import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db";
import { activity, aiJobs } from "@/db/schema";
import { parseIntParam } from "@/lib/api/guards";
import { verifyJobToken } from "@/lib/api/job-token";
import { readBearer } from "@/lib/api/keys";
import {
  badRequest,
  conflict,
  notFound,
  ok,
  unauthorized,
} from "@/lib/api/response";

const resultSchema = z.object({
  status: z.enum(["done", "failed"]),
  result: z.unknown().optional(),
  error: z.string().trim().max(4000).nullish(),
});

/**
 * Authenticates SOLELY on the signed execution token.
 *
 * No API key is accepted here, not even a valid workspace one. n8n drains the
 * queue for every tenant, so any credential it holds is cross-workspace by
 * definition — if a key could authorise this call, a workspace-2 key could post
 * a result onto a workspace-1 job and inject arbitrary model output into
 * another tenant's card. That is state poisoning, not merely a read leak.
 *
 * The tenant therefore comes from the signed payload: not from the body, not
 * from the URL, and not from whatever credential the caller presents.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const token = readBearer(request);
  if (!token) return unauthorized();

  const verified = verifyJobToken(token);
  if (!verified.ok) return unauthorized();

  const { id } = await context.params;
  const jobId = parseIntParam(id);
  if (!jobId) return notFound();

  // A token is minted for one job. Presenting it against a different id is the
  // cross-tenant probe this endpoint exists to refuse, and it gets the same
  // answer as an id that does not exist.
  if (jobId !== verified.payload.job_id) return notFound();

  const parsed = resultSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest("invalid_body", parsed.error.issues);

  const { status, result, error } = parsed.data;

  /*
   * `status = 'claimed'` in the WHERE is what makes the token single-use. The
   * first call moves the row out of `claimed`, so a replay inside the token's
   * fifteen minutes matches nothing — no second write, and the caller is told
   * the job is already resolved rather than being allowed to overwrite it.
   *
   * `workspace_id` is matched against the token's copy so the row can only be
   * the one the token was signed for, even if job ids were ever reused.
   */
  const [updated] = await db
    .update(aiJobs)
    .set({
      status,
      result: status === "done" ? (result ?? null) : null,
      error: status === "failed" ? (error ?? "unspecified failure") : null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(aiJobs.id, jobId),
        eq(aiJobs.workspaceId, verified.payload.workspace_id),
        eq(aiJobs.status, "claimed"),
      ),
    )
    .returning({
      id: aiJobs.id,
      workspaceId: aiJobs.workspaceId,
      cardId: aiJobs.cardId,
      kind: aiJobs.kind,
      status: aiJobs.status,
      attempts: aiJobs.attempts,
    });

  if (!updated) {
    // The signature already proved this token was minted for this job in this
    // workspace, so the row existing but not being claimable means it was
    // resolved already — a replay, not a probe.
    const [existing] = await db
      .select({ status: aiJobs.status })
      .from(aiJobs)
      .where(
        and(
          eq(aiJobs.id, jobId),
          eq(aiJobs.workspaceId, verified.payload.workspace_id),
        ),
      )
      .limit(1);

    if (!existing) return notFound();
    return conflict("job_already_resolved");
  }

  await db.insert(activity).values({
    workspaceId: updated.workspaceId,
    cardId: updated.cardId,
    // Not a user and not an API key: the token is its own kind of actor, and
    // flattening it into either would misattribute the write.
    actor: `job:${updated.id}`,
    action: `ai.${updated.kind}.${status}`,
    payload: { attempts: updated.attempts },
  });

  return ok({
    job: {
      id: updated.id,
      status: updated.status,
      card_id: updated.cardId,
      kind: updated.kind,
    },
  });
}
