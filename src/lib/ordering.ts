import { and, asc, eq, isNull, sql, type SQL } from "drizzle-orm";
import { generateKeyBetween, generateNKeysBetween } from "fractional-indexing";

import { db } from "@/db";
import { cards } from "@/db/schema";

/**
 * Rebalance a scope once its longest key passes this. Repeated drops into the
 * same gap grow keys without bound otherwise.
 */
export const MAX_POSITION_LENGTH = 40;

/**
 * A card's ordering peers are exactly the cards it is displayed alongside, so
 * the position space is scoped the same way the view is.
 *
 * A column holds cards from every sprint plus the backlog. Scoping keys by
 * column alone would put cards that never appear in the same list into one
 * ordering space — their relative keys would be meaningless, and a rebalance
 * triggered by one sprint would rewrite another sprint's cards for no reason.
 */
export type OrderScope =
  | { kind: "board"; workspaceId: number; columnId: number; sprintId: number }
  | { kind: "backlog"; workspaceId: number };

export type OrderedCard = { id: number; position: string };

/*
 * Archived cards are outside every ordering scope.
 *
 * A scope is the key space for what is displayed together, and an archived card
 * is displayed nowhere. Leaving them in would make `readOrder` return rows the
 * client cannot see, so an append would land after an invisible card and a
 * rebalance would spend keys on rows nobody is looking at.
 *
 * The cost is that restoring a card returns it with a key from the old
 * numbering, which can now collide or sort oddly. That is bounded and visible —
 * `id ASC` still gives every client the same order, and the next move through
 * the scope rebalances it — whereas the alternative is a permanent tax on every
 * live board for the sake of rows that have been put away.
 */
export function scopeWhere(scope: OrderScope): SQL {
  if (scope.kind === "backlog") {
    return and(
      eq(cards.workspaceId, scope.workspaceId),
      isNull(cards.archivedAt),
      isNull(cards.sprintId),
    )!;
  }
  return and(
    eq(cards.workspaceId, scope.workspaceId),
    isNull(cards.archivedAt),
    eq(cards.columnId, scope.columnId),
    eq(cards.sprintId, scope.sprintId),
  )!;
}

/** The same predicate as raw SQL, for the single-statement rebalance below. */
function scopeSql(scope: OrderScope): SQL {
  if (scope.kind === "backlog") {
    return sql`c.workspace_id = ${scope.workspaceId} AND c.archived_at IS NULL AND c.sprint_id IS NULL`;
  }
  return sql`c.workspace_id = ${scope.workspaceId} AND c.archived_at IS NULL AND c.column_id = ${scope.columnId} AND c.sprint_id = ${scope.sprintId}`;
}

/**
 * The canonical ordered read. `id ASC` is not decoration — duplicate position
 * keys are reachable (two clients dropping into the same gap in the same
 * instant), and without the tie-breaker those two clients render different
 * orders from identical data.
 */
export async function readOrder(scope: OrderScope): Promise<OrderedCard[]> {
  return db
    .select({ id: cards.id, position: cards.position })
    .from(cards)
    .where(scopeWhere(scope))
    .orderBy(asc(cards.position), asc(cards.id));
}

/**
 * Rewrites every key in a scope to a fresh evenly-spaced sequence, preserving
 * the exact order currently displayed.
 *
 * Written as ONE `UPDATE ... FROM (VALUES ...)` statement on purpose. The
 * neon-http driver has no interactive transaction, so a per-row update loop
 * would be N separate HTTP requests with no atomicity — a failure halfway
 * through would leave the scope partially rebalanced, which is strictly worse
 * than the duplicate key we came here to fix.
 */
export async function rebalance(scope: OrderScope): Promise<OrderedCard[]> {
  const current = await readOrder(scope);
  if (current.length === 0) return [];

  const keys = generateNKeysBetween(null, null, current.length);

  const values = sql.join(
    current.map((card, index) => sql`(${card.id}::int, ${keys[index]}::text)`),
    sql`, `,
  );

  await db.execute(sql`
    UPDATE ${cards} AS c
    SET position = v.position, updated_at = now()
    FROM (VALUES ${values}) AS v(id, position)
    WHERE c.id = v.id AND ${scopeSql(scope)}
  `);

  return current.map((card, index) => ({ id: card.id, position: keys[index] }));
}

export type NeighborPositions = {
  prev: string | null;
  next: string | null;
};

export type PositionResult =
  | { ok: true; position: string; rebalanced: boolean }
  | { ok: false; error: "invalid_neighbors" };

/**
 * Computes the key for a card landing between two neighbours.
 *
 * The equal-key case is the one that matters. SPEC calls a duplicate position
 * "a cosmetic tie", but it is not: once two cards share a key, the slot between
 * them is un-representable — only `id` separates them, and integers do not
 * subdivide. `generateKeyBetween` throws on equal arguments, which surfaces as
 * a 500 and an optimistic drag that rubber-bands. So we heal the scope first,
 * then compute against the fresh keys.
 */
export async function computePosition(
  scope: OrderScope,
  neighbors: NeighborPositions,
  reread: (fresh: OrderedCard[]) => NeighborPositions,
): Promise<PositionResult> {
  let { prev, next } = neighbors;
  let rebalanced = false;

  if (prev !== null && next !== null && prev === next) {
    const fresh = await rebalance(scope);
    ({ prev, next } = reread(fresh));
    rebalanced = true;
  }

  // Still inverted after any healing: the client sent its neighbours backwards.
  // Rebalancing cannot fix a wrong intent, so refuse rather than guess.
  if (prev !== null && next !== null && prev >= next) {
    return { ok: false, error: "invalid_neighbors" };
  }

  return { ok: true, position: generateKeyBetween(prev, next), rebalanced };
}
