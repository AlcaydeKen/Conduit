import { asc, eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db";
import { comments, users } from "@/db/schema";
import { logActivity } from "@/lib/api/activity";
import {
  authorIdOf,
  loadCardForActor,
  parseIntParam,
  resolveActor,
} from "@/lib/api/guards";
import { badRequest, notFound, ok, unauthorized } from "@/lib/api/response";

const bodySchema = z.object({
  body: z.string().trim().min(1).max(10_000),
});

/*
 * `comments` has no workspace of its own, so reaching the tenant boundary means
 * joining up to `cards` — which is what `loadCardForActor` does, in one
 * statement, for either kind of credential.
 */

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const actor = await resolveActor(request);
  if (!actor) return unauthorized();

  const { id } = await context.params;
  const cardId = parseIntParam(id);
  if (!cardId) return notFound();

  const card = await loadCardForActor(actor, cardId);
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
  const actor = await resolveActor(request);
  if (!actor) return unauthorized();

  const { id } = await context.params;
  const cardId = parseIntParam(id);
  if (!cardId) return notFound();

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest("invalid_body", parsed.error.issues);

  const card = await loadCardForActor(actor, cardId);
  if (!card) return notFound();

  const [created] = await db
    .insert(comments)
    .values({
      cardId,
      // Null when a machine commented. `comments.author_id` is a foreign key
      // into `users`, and a key is not a user; the key's label is preserved on
      // the activity row instead.
      authorId: authorIdOf(actor),
      body: parsed.data.body,
    })
    .returning();

  await logActivity({
    workspaceId: card.workspaceId,
    cardId,
    actor,
    action: "comment.create",
    payload: { comment_id: created.id },
  });

  return ok({
    comment: {
      id: created.id,
      body: created.body,
      created_at: created.createdAt.toISOString(),
    },
  });
}
