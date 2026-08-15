import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db";
import {
  cardLabels,
  cards,
  labels,
  users,
  workspaceMembers,
} from "@/db/schema";
import { logActivity } from "@/lib/api/activity";
import { assigneeJoin, cardProjection, toApiCard } from "@/lib/api/cards";
import {
  loadCardForActor,
  parseIntParam,
  resolveActor,
} from "@/lib/api/guards";
import { badRequest, notFound, ok, unauthorized } from "@/lib/api/response";

/**
 * Fields a card can be edited into. `column_id`, `sprint_id` and `position` are
 * deliberately absent: moving is `POST /cards/:id/move`, which takes neighbour
 * intent so the server can compute the key. Accepting a column here would be a
 * second way to move a card, and the one that skips that machinery.
 */
const patchSchema = z
  .object({
    title: z.string().trim().min(1).max(300).optional(),
    description: z.string().trim().max(20_000).nullish(),
    priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
    points: z.number().int().min(0).max(1000).nullish(),
    assignee_id: z.string().trim().min(1).max(255).nullish(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: "no_fields_to_update",
  });

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const actor = await resolveActor(request);
  if (!actor) return unauthorized();

  const { id } = await context.params;
  const cardId = parseIntParam(id);
  if (!cardId) return notFound();

  // Tenant proof first, so the detail queries below can be keyed on the id
  // alone without any of them becoming the boundary.
  const scoped = await loadCardForActor(actor, cardId);
  if (!scoped) return notFound();

  const [[row], cardLabelRows] = await Promise.all([
    db
      .select(cardProjection)
      .from(cards)
      .leftJoin(users, assigneeJoin)
      .where(eq(cards.id, cardId))
      .limit(1),
    db
      .select({ id: labels.id, name: labels.name, color: labels.color })
      .from(cardLabels)
      .innerJoin(labels, eq(labels.id, cardLabels.labelId))
      .where(eq(cardLabels.cardId, cardId))
      .orderBy(asc(labels.id)),
  ]);

  if (!row) return notFound();

  return ok({ card: { ...toApiCard(row), labels: cardLabelRows } });
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const actor = await resolveActor(request);
  if (!actor) return unauthorized();

  const { id } = await context.params;
  const cardId = parseIntParam(id);
  if (!cardId) return notFound();

  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest("invalid_body", parsed.error.issues);

  const scoped = await loadCardForActor(actor, cardId);
  if (!scoped) return notFound();

  const body = parsed.data;

  if (body.assignee_id) {
    const [member] = await db
      .select({ userId: workspaceMembers.userId })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, scoped.workspaceId),
          eq(workspaceMembers.userId, body.assignee_id),
        ),
      )
      .limit(1);
    if (!member) return notFound();
  }

  // Only the keys actually present. Spreading the parsed body wholesale would
  // write nulls over fields the caller never mentioned.
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (body.title !== undefined) patch.title = body.title;
  if (body.description !== undefined) patch.description = body.description ?? null;
  if (body.priority !== undefined) patch.priority = body.priority;
  if (body.points !== undefined) patch.points = body.points ?? null;
  if (body.assignee_id !== undefined) {
    patch.assigneeId = body.assignee_id ?? null;
  }

  const [updated] = await db
    .update(cards)
    .set(patch)
    // The tenant predicate is repeated on the write itself, not just on the
    // read above, so the statement that changes data carries its own boundary.
    .where(
      and(eq(cards.id, cardId), eq(cards.workspaceId, scoped.workspaceId)),
    )
    .returning();

  if (!updated) return notFound();

  await logActivity({
    workspaceId: scoped.workspaceId,
    cardId,
    actor,
    action: "card.update",
    payload: { fields: Object.keys(body) },
  });

  return ok({
    card: toApiCard({ ...updated, assigneeName: null, assigneeImage: null }),
  });
}
