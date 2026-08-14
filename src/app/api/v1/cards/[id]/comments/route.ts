import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db";
import { cards, comments, users, workspaceMembers } from "@/db/schema";
import { parseIntParam, resolveActor } from "@/lib/api/guards";
import { badRequest, notFound, ok, unauthorized } from "@/lib/api/response";

const bodySchema = z.object({
  body: z.string().trim().min(1).max(10_000),
});

/**
 * `comments` has no workspace of its own, so every query joins up to `cards` to
 * reach the tenant boundary — in the same statement, never as a second check.
 */
async function requireCardAccess(cardId: number, userId: string) {
  const [card] = await db
    .select({ id: cards.id, workspaceId: cards.workspaceId })
    .from(cards)
    .innerJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.workspaceId, cards.workspaceId),
        eq(workspaceMembers.userId, userId),
      ),
    )
    .where(eq(cards.id, cardId))
    .limit(1);

  return card ?? null;
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const actor = await resolveActor();
  if (!actor) return unauthorized();

  const { id } = await context.params;
  const cardId = parseIntParam(id);
  if (!cardId) return notFound();

  const card = await requireCardAccess(cardId, actor.userId);
  if (!card) return notFound();

  const rows = await db
    .select({
      id: comments.id,
      body: comments.body,
      createdAt: comments.createdAt,
      authorId: users.id,
      authorName: users.name,
      authorImage: users.image,
    })
    .from(comments)
    .leftJoin(users, eq(users.id, comments.authorId))
    .where(eq(comments.cardId, cardId))
    .orderBy(asc(comments.createdAt), asc(comments.id));

  return ok({
    comments: rows.map((row) => ({
      id: row.id,
      body: row.body,
      created_at: row.createdAt.toISOString(),
      author: row.authorId
        ? { id: row.authorId, name: row.authorName, image: row.authorImage }
        : null,
    })),
  });
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const actor = await resolveActor();
  if (!actor) return unauthorized();

  const { id } = await context.params;
  const cardId = parseIntParam(id);
  if (!cardId) return notFound();

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest("invalid_body", parsed.error.issues);

  const card = await requireCardAccess(cardId, actor.userId);
  if (!card) return notFound();

  const [created] = await db
    .insert(comments)
    .values({
      cardId,
      authorId: actor.userId,
      body: parsed.data.body,
    })
    .returning();

  return ok({
    comment: {
      id: created.id,
      body: created.body,
      created_at: created.createdAt.toISOString(),
    },
  });
}
