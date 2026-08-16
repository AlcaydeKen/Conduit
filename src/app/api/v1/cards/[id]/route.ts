import { and, asc, eq, inArray, notInArray } from "drizzle-orm";
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
import {
  assigneeJoin,
  cardProjection,
  labelsByCard,
  toApiCard,
} from "@/lib/api/cards";
import {
  loadCardForActor,
  parseIntParam,
  resolveActor,
} from "@/lib/api/guards";
import { SCOPES } from "@/lib/api/scopes";
import { badRequest, notFound, ok } from "@/lib/api/response";

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
    /**
     * The card's complete label set, not a delta. An empty array clears them.
     *
     * Replace rather than add/remove because the drawer holds the whole set on
     * screen and sends what it should end up as; a delta API would need the
     * client to diff against a list that the 5s poll may already have changed
     * under it, which is the bug the edit form's snapshot exists to avoid.
     */
    label_ids: z.array(z.number().int().positive()).max(50).optional(),
    /** Archive or restore. The row is never deleted — see `cards.archived_at`. */
    archived: z.boolean().optional(),
  })
  /*
   * An empty body is refused here, not further down. Zod strips unknown keys
   * first, so `{"position": "zzz"}` — a caller trying to reorder through the
   * edit endpoint — arrives as `{}` and is rejected by exactly this line.
   */
  .refine((body) => Object.keys(body).length > 0, {
    message: "no_fields_to_update",
  });

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const auth = await resolveActor(request, SCOPES.BOARD_READ);
  if (!auth.ok) return auth.response;
  const actor = auth.actor;

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

  return ok({ card: toApiCard(row, cardLabelRows) });
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const auth = await resolveActor(request, SCOPES.BOARD_WRITE);
  if (!auth.ok) return auth.response;
  const actor = auth.actor;

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
  if (body.archived !== undefined) {
    patch.archivedAt = body.archived ? new Date() : null;
  }

  /*
   * Every label must belong to this card's workspace, checked in one statement
   * against the tenant the card proved — not by trusting the ids.
   *
   * Without it, `label_ids: [<id from another tenant>]` would attach a
   * foreign label to this card, and the board would then render another
   * workspace's label name and colour. Counting is enough: the ids are already
   * a set, so if every one of them resolves inside this workspace, all of them
   * are legitimate.
   */
  if (body.label_ids !== undefined && body.label_ids.length > 0) {
    const wanted = [...new Set(body.label_ids)];
    const owned = await db
      .select({ id: labels.id })
      .from(labels)
      .where(
        and(
          inArray(labels.id, wanted),
          eq(labels.workspaceId, scoped.workspaceId),
        ),
      );
    if (owned.length !== wanted.length) return notFound();
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

  /*
   * Reconcile the label set: add what is missing, then remove what is extra.
   *
   * That order is deliberate. neon-http has no interactive transaction, so
   * these are two independent statements and a failure between them is
   * possible. Adding first means the failure mode is a card carrying a label
   * too many — visible on the board and fixed by saving again. Deleting first
   * means the failure mode is labels silently gone, which nobody notices until
   * they go looking for a card by its label and it is not there.
   */
  if (body.label_ids !== undefined) {
    const wanted = [...new Set(body.label_ids)];

    if (wanted.length > 0) {
      await db
        .insert(cardLabels)
        .values(wanted.map((labelId) => ({ cardId, labelId })))
        .onConflictDoNothing();
    }

    await db
      .delete(cardLabels)
      .where(
        wanted.length > 0
          ? and(
              eq(cardLabels.cardId, cardId),
              notInArray(cardLabels.labelId, wanted),
            )
          : eq(cardLabels.cardId, cardId),
      );
  }

  await logActivity({
    workspaceId: scoped.workspaceId,
    cardId,
    actor,
    action: body.archived === undefined
      ? "card.update"
      : body.archived
        ? "card.archive"
        : "card.restore",
    // Field names only, no values. Enough to see who touched what and when;
    // reconstructing an old value is what the card itself is for.
    payload: { fields: Object.keys(body) },
  });

  const labelsFor = await labelsByCard([cardId]);

  return ok({
    card: toApiCard(
      { ...updated, assigneeName: null, assigneeImage: null },
      labelsFor.get(cardId) ?? [],
    ),
  });
}
