import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db";
import { cards, columns, sprints } from "@/db/schema";
import { SCOPES } from "@/lib/api/scopes";
import { badRequest, notFound, ok } from "@/lib/api/response";
import { logActivity } from "@/lib/api/activity";
import {
  loadCardForActor,
  parseIntParam,
  resolveActor,
} from "@/lib/api/guards";
import {
  MAX_POSITION_LENGTH,
  computePosition,
  readOrder,
  rebalance,
  scopeWhere,
  type OrderScope,
} from "@/lib/ordering";

const positiveId = z.number().int().positive();

/**
 * Neighbour intent, never a position string. A client-computed key would be
 * derived from board state up to one poll interval stale, which is exactly how
 * a card lands in the wrong gap.
 *
 * `sprint_id` is part of a move because dropping a card into the backlog still
 * needs a position within the backlog. Omitted means "leave the sprint alone";
 * explicit null means the backlog.
 */
const moveSchema = z.object({
  column_id: positiveId,
  sprint_id: positiveId.nullish(),
  prev_card_id: positiveId.nullish(),
  next_card_id: positiveId.nullish(),
});

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const auth = await resolveActor(request, SCOPES.BOARD_WRITE);
  if (!auth.ok) return auth.response;
  const actor = auth.actor;

  const { id } = await context.params;
  const movingId = parseIntParam(id);
  if (!movingId) return notFound();

  const body = await request.json().catch(() => null);
  const parsed = moveSchema.safeParse(body);
  if (!parsed.success) return badRequest("invalid_body", parsed.error.issues);

  const { column_id: columnId, prev_card_id, next_card_id } = parsed.data;

  if (prev_card_id === movingId || next_card_id === movingId) {
    return badRequest("invalid_neighbors");
  }
  if (prev_card_id && next_card_id && prev_card_id === next_card_id) {
    return badRequest("invalid_neighbors");
  }

  // Card lookup and tenant proof in one statement. The workspace comes from the
  // row the caller provably has access to, never from the request.
  const card = await loadCardForActor(actor, movingId);
  if (!card) return notFound();
  const workspaceId = card.workspaceId;

  const [targetColumn] = await db
    .select({ id: columns.id })
    .from(columns)
    .where(and(eq(columns.id, columnId), eq(columns.workspaceId, workspaceId)))
    .limit(1);

  if (!targetColumn) return notFound();

  // `sprint_id` absent leaves the card where it is; explicit null is the backlog.
  const targetSprintId =
    parsed.data.sprint_id === undefined ? card.sprintId : parsed.data.sprint_id;

  if (targetSprintId !== null) {
    const [targetSprint] = await db
      .select({ id: sprints.id })
      .from(sprints)
      .where(
        and(
          eq(sprints.id, targetSprintId),
          eq(sprints.workspaceId, workspaceId),
        ),
      )
      .limit(1);

    if (!targetSprint) return notFound();
  }

  const scope: OrderScope =
    targetSprintId === null
      ? { kind: "backlog", workspaceId }
      : { kind: "board", workspaceId, columnId, sprintId: targetSprintId };

  // Neighbours must already live in the destination scope. A card id from
  // another tenant is indistinguishable from one that does not exist.
  const neighborIds = [prev_card_id, next_card_id].filter(
    (value): value is number => typeof value === "number",
  );

  let neighborRows: { id: number; position: string }[] = [];
  if (neighborIds.length > 0) {
    neighborRows = await db
      .select({ id: cards.id, position: cards.position })
      .from(cards)
      .where(and(inArray(cards.id, neighborIds), scopeWhere(scope)));

    if (neighborRows.length !== neighborIds.length) return notFound();
  }

  const positionOf = (
    rows: { id: number; position: string }[],
    value: number | null | undefined,
  ) => (value ? (rows.find((row) => row.id === value)?.position ?? null) : null);

  let prev = positionOf(neighborRows, prev_card_id);
  const next = positionOf(neighborRows, next_card_id);

  // No neighbours given: append to the end of the destination. Deterministic,
  // and avoids minting a bare "a0" that collides with whatever is already there.
  if (prev === null && next === null) {
    const order = await readOrder(scope);
    prev = order.filter((row) => row.id !== movingId).at(-1)?.position ?? null;
  }

  const result = await computePosition(scope, { prev, next }, (fresh) => ({
    prev: positionOf(fresh, prev_card_id),
    next: positionOf(fresh, next_card_id),
  }));

  if (!result.ok) return badRequest(result.error);

  const [updated] = await db
    .update(cards)
    .set({
      columnId,
      sprintId: targetSprintId,
      position: result.position,
      updatedAt: new Date(),
    })
    .where(and(eq(cards.id, movingId), eq(cards.workspaceId, workspaceId)))
    .returning({
      id: cards.id,
      columnId: cards.columnId,
      sprintId: cards.sprintId,
      position: cards.position,
    });

  if (!updated) return notFound();

  // Repeated drops into the same gap grow the key without bound.
  let rebalanced = result.rebalanced;
  let position = updated.position;
  if (position.length > MAX_POSITION_LENGTH) {
    const fresh = await rebalance(scope);
    position = fresh.find((row) => row.id === movingId)?.position ?? position;
    rebalanced = true;
  }

  await logActivity({
    workspaceId,
    cardId: movingId,
    actor,
    action: "card.move",
    payload: {
      from_column_id: card.columnId,
      to_column_id: updated.columnId,
      from_sprint_id: card.sprintId,
      to_sprint_id: updated.sprintId,
      rebalanced,
    },
  });

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
