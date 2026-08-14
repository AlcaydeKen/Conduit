import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db";
import { cards, columns, workspaceMembers } from "@/db/schema";
import {
  badRequest,
  notFound,
  ok,
  unauthorized,
} from "@/lib/api/response";
import { parseIntParam, resolveActor } from "@/lib/api/guards";
import {
  MAX_POSITION_LENGTH,
  computePosition,
  readColumnOrder,
  rebalanceColumn,
} from "@/lib/ordering";

const cardId = z.number().int().positive();

/**
 * Neighbour intent, never a position string. A client-computed key would be
 * derived from board state up to one poll interval stale, which is exactly how
 * a card lands in the wrong gap.
 */
const moveSchema = z.object({
  column_id: cardId,
  prev_card_id: cardId.nullish(),
  next_card_id: cardId.nullish(),
});

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const actor = await resolveActor();
  if (!actor) return unauthorized();

  const { id } = await context.params;
  const movingId = parseIntParam(id);
  if (!movingId) return notFound();

  const parsed = moveSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return badRequest("invalid_body", parsed.error.issues);
  }
  const { column_id: columnId, prev_card_id, next_card_id } = parsed.data;

  if (prev_card_id === movingId || next_card_id === movingId) {
    return badRequest("invalid_neighbors");
  }
  if (prev_card_id && next_card_id && prev_card_id === next_card_id) {
    return badRequest("invalid_neighbors");
  }

  // Card lookup and membership proof in one statement. The workspace comes from
  // the row the caller provably has access to, never from the request.
  const [card] = await db
    .select({ id: cards.id, workspaceId: cards.workspaceId })
    .from(cards)
    .innerJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.workspaceId, cards.workspaceId),
        eq(workspaceMembers.userId, actor.userId),
      ),
    )
    .where(eq(cards.id, movingId))
    .limit(1);

  if (!card) return notFound();
  const workspaceId = card.workspaceId;

  const [targetColumn] = await db
    .select({ id: columns.id })
    .from(columns)
    .where(and(eq(columns.id, columnId), eq(columns.workspaceId, workspaceId)))
    .limit(1);

  if (!targetColumn) return notFound();

  // Neighbours must live in the target column of the same workspace. A card id
  // from another tenant is indistinguishable from one that does not exist.
  const neighborIds = [prev_card_id, next_card_id].filter(
    (value): value is number => typeof value === "number",
  );

  let neighborRows: { id: number; position: string }[] = [];
  if (neighborIds.length > 0) {
    neighborRows = await db
      .select({ id: cards.id, position: cards.position })
      .from(cards)
      .where(
        and(
          inArray(cards.id, neighborIds),
          eq(cards.workspaceId, workspaceId),
          eq(cards.columnId, columnId),
        ),
      );

    if (neighborRows.length !== neighborIds.length) return notFound();
  }

  const positionOf = (
    rows: { id: number; position: string }[],
    id: number | null | undefined,
  ) => (id ? (rows.find((row) => row.id === id)?.position ?? null) : null);

  let prev = positionOf(neighborRows, prev_card_id);
  const next = positionOf(neighborRows, next_card_id);

  // No neighbours given: append to the end of the target column. Deterministic,
  // and avoids minting a bare "a0" that collides with whatever is already there.
  if (prev === null && next === null) {
    const order = await readColumnOrder(workspaceId, columnId);
    prev = order.filter((row) => row.id !== movingId).at(-1)?.position ?? null;
  }

  const result = await computePosition(
    workspaceId,
    columnId,
    { prev, next },
    (fresh) => ({
      prev: positionOf(fresh, prev_card_id),
      next: positionOf(fresh, next_card_id),
    }),
  );

  if (!result.ok) return badRequest(result.error);

  const [updated] = await db
    .update(cards)
    .set({
      columnId,
      position: result.position,
      updatedAt: new Date(),
    })
    .where(and(eq(cards.id, movingId), eq(cards.workspaceId, workspaceId)))
    .returning({
      id: cards.id,
      columnId: cards.columnId,
      position: cards.position,
      sprintId: cards.sprintId,
    });

  if (!updated) return notFound();

  // Repeated drops into the same gap grow the key without bound.
  let rebalanced = result.rebalanced;
  let position = updated.position;
  if (position.length > MAX_POSITION_LENGTH) {
    const fresh = await rebalanceColumn(workspaceId, columnId);
    position = fresh.find((row) => row.id === movingId)?.position ?? position;
    rebalanced = true;
  }

  return ok({
    card: {
      id: updated.id,
      column_id: updated.columnId,
      sprint_id: updated.sprintId,
      position,
    },
    rebalanced,
  });
}
