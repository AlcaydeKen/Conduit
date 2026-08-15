import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db";
import { aiJobs } from "@/db/schema";
import { logActivity } from "@/lib/api/activity";
import {
  loadCardForActor,
  parseIntParam,
  requireScope,
  resolveActor,
} from "@/lib/api/guards";
import { SCOPES } from "@/lib/api/scopes";
import {
  badRequest,
  conflict,
  notFound,
  ok,
  unauthorized,
} from "@/lib/api/response";

/** The kinds a card-scoped job may be queued as. */
const CARD_JOB_KINDS = [
  "draft_card",
  "suggest_labels",
  "estimate_points",
  "split_epic",
] as const;

const enqueueSchema = z.object({
  card_id: z.number().int().positive(),
  kind: z.enum(CARD_JOB_KINDS),
  input: z.record(z.string(), z.unknown()).optional(),
});

function toApiJob(row: {
  id: number;
  cardId: number | null;
  kind: string;
  status: string;
  result: unknown;
  error: string | null;
  attempts: number;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: row.id,
    card_id: row.cardId,
    kind: row.kind,
    status: row.status,
    result: row.result,
    error: row.error,
    attempts: row.attempts,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

const jobProjection = {
  id: aiJobs.id,
  cardId: aiJobs.cardId,
  kind: aiJobs.kind,
  status: aiJobs.status,
  result: aiJobs.result,
  error: aiJobs.error,
  attempts: aiJobs.attempts,
  createdAt: aiJobs.createdAt,
  updatedAt: aiJobs.updatedAt,
};

/** The newest job for one card, which is what the drawer polls. */
export async function GET(request: Request) {
  const actor = await resolveActor(request);
  if (!actor) return unauthorized();

  const denied = requireScope(actor, SCOPES.BOARD_READ);
  if (denied) return denied;

  const url = new URL(request.url);
  const cardId = parseIntParam(url.searchParams.get("card"));
  if (!cardId) return badRequest("card_required");

  // The card proves the tenant. `ai_jobs.workspace_id` is never read from the
  // request, and this route never has to trust one.
  const card = await loadCardForActor(actor, cardId);
  if (!card) return notFound();

  const [job] = await db
    .select(jobProjection)
    .from(aiJobs)
    .where(
      and(eq(aiJobs.cardId, cardId), eq(aiJobs.workspaceId, card.workspaceId)),
    )
    .orderBy(desc(aiJobs.createdAt), desc(aiJobs.id))
    .limit(1);

  return ok({ job: job ? toApiJob(job) : null });
}

export async function POST(request: Request) {
  const actor = await resolveActor(request);
  if (!actor) return unauthorized();

  const denied = requireScope(actor, SCOPES.BOARD_WRITE);
  if (denied) return denied;

  const parsed = enqueueSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest("invalid_body", parsed.error.issues);

  const { card_id: cardId, kind, input } = parsed.data;

  /*
   * The workspace comes from the card, proven in the same statement that loads
   * it — never from the body. A caller that could name the workspace could
   * queue work into someone else's tenant, and `ai_jobs.workspace_id` is what
   * the result callback's signed token is later minted from.
   */
  const card = await loadCardForActor(actor, cardId);
  if (!card) return notFound();

  /*
   * One open job per card and kind, enforced by a partial unique index rather
   * than by a select-then-insert here. Two clicks that overlap — a fast
   * double-click, or two people with the same card open — would both see an
   * empty result and both insert. The database is the only place that check can
   * be atomic, so the insert simply asks for the row and reads whether it got
   * one.
   */
  const [created] = await db
    .insert(aiJobs)
    .values({
      workspaceId: card.workspaceId,
      cardId,
      kind,
      status: "pending",
      input: input ?? {},
    })
    .onConflictDoNothing()
    .returning(jobProjection);

  if (!created) return conflict("job_already_queued");

  await logActivity({
    workspaceId: card.workspaceId,
    cardId,
    actor,
    action: `ai.${kind}.queued`,
    payload: { job_id: created.id },
  });

  return ok({ job: toApiJob(created) });
}
