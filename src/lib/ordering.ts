import { and, asc, eq, sql } from "drizzle-orm";
import { generateKeyBetween, generateNKeysBetween } from "fractional-indexing";

import { db } from "@/db";
import { cards } from "@/db/schema";

/**
 * Rebalance a column once its longest key passes this. Repeated drops into the
 * same gap grow keys without bound otherwise.
 */
export const MAX_POSITION_LENGTH = 40;

export type OrderedCard = { id: number; position: string };

/**
 * The canonical ordered read. `id ASC` is not decoration — duplicate position
 * keys are reachable (two clients dropping into the same gap in the same
 * instant), and without the tie-breaker those two clients render different
 * orders from identical data.
 */
export async function readColumnOrder(
  workspaceId: number,
  columnId: number,
): Promise<OrderedCard[]> {
  return db
    .select({ id: cards.id, position: cards.position })
    .from(cards)
    .where(and(eq(cards.workspaceId, workspaceId), eq(cards.columnId, columnId)))
    .orderBy(asc(cards.position), asc(cards.id));
}

/**
 * Rewrites every key in a column to a fresh evenly-spaced sequence, preserving
 * the exact order the board currently displays.
 *
 * Written as ONE `UPDATE ... FROM (VALUES ...)` statement on purpose. The
 * neon-http driver has no interactive transaction, so a per-row update loop
 * would be N separate HTTP requests with no atomicity — a failure halfway
 * through would leave the column in a partially rebalanced state, which is
 * strictly worse than the duplicate key we came here to fix.
 */
export async function rebalanceColumn(
  workspaceId: number,
  columnId: number,
): Promise<OrderedCard[]> {
  const current = await readColumnOrder(workspaceId, columnId);
  if (current.length === 0) return [];

  const keys = generateNKeysBetween(null, null, current.length);

  const values = sql.join(
    current.map(
      (card, index) => sql`(${card.id}::int, ${keys[index]}::text)`,
    ),
    sql`, `,
  );

  await db.execute(sql`
    UPDATE ${cards} AS c
    SET position = v.position, updated_at = now()
    FROM (VALUES ${values}) AS v(id, position)
    WHERE c.id = v.id AND c.workspace_id = ${workspaceId}
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
 * subdivide. `generateKeyBetween("a1", "a1")` throws `a1 >= a1`, which surfaces
 * as a 500 and an optimistic drag that rubber-bands. So we heal the column
 * first, then compute against the fresh keys.
 */
export async function computePosition(
  workspaceId: number,
  columnId: number,
  neighbors: NeighborPositions,
  reread: (columnOrder: OrderedCard[]) => NeighborPositions,
): Promise<PositionResult> {
  let { prev, next } = neighbors;
  let rebalanced = false;

  if (prev !== null && next !== null && prev === next) {
    const fresh = await rebalanceColumn(workspaceId, columnId);
    ({ prev, next } = reread(fresh));
    rebalanced = true;
  }

  // Still inverted after any healing: the client sent its neighbours backwards.
  // Rebalancing cannot fix a wrong intent, so refuse rather than guess.
  if (prev !== null && next !== null && prev >= next) {
    return { ok: false, error: "invalid_neighbors" };
  }

  return {
    ok: true,
    position: generateKeyBetween(prev, next),
    rebalanced,
  };
}
