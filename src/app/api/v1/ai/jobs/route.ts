import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db";
import { aiJobs } from "@/db/schema";
import { logActivity } from "@/lib/api/activity";
import {
  loadCardForActor,
  parseIntParam,
  resolveActor,
} from "@/lib/api/guards";
import { SCOPES } from "@/lib/api/scopes";
import {
  badRequest,
  conflict,
  notFound,
  ok,
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

/**
 * The title the job was generated from, if the input recorded one.
 *
 * Only the title, rather than `input` whole. `input` also carries whatever keys
 * the caller passed at enqueue, and there is no reason to hand those back on
 * every drawer poll to render one line of provenance.
 */
function sourceTitleOf(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const card = (input as { card?: unknown }).card;
  if (!card || typeof card !== "object") return null;
  const title = (card as { title?: unknown }).title;
  return typeof title === "string" ? title : null;
}

function toApiJob(row: {
  id: number;
  cardId: number | null;
  kind: string;
  status: string;
  input: unknown;
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
    /*
     * `input` is a snapshot taken at enqueue and deliberately never refreshed —
     * a retry half an hour later must run the same prompt as the first attempt,
     * and the runner could not re-read the card even if it wanted to, holding a
     * claim-only credential.
     *
     * The consequence lands here: the drawer renders the draft beside a card
     * that may since have been renamed, and without this field it has nothing
     * to say why the two disagree. A confident paragraph about the wrong
     * subject reads as a broken model rather than a stale snapshot.
     */
    source_title: sourceTitleOf(row.input),
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

const jobProjection = {
  id: aiJobs.id,
  cardId: aiJobs.cardId,
  kind: aiJobs.kind,
  status: aiJobs.status,
  input: aiJobs.input,
  result: aiJobs.result,
  error: aiJobs.error,
  attempts: aiJobs.attempts,
  createdAt: aiJobs.createdAt,
  updatedAt: aiJobs.updatedAt,
};

/** The newest job for one card, which is what the drawer polls. */
export async function GET(request: Request) {
  const auth = await resolveActor(request, SCOPES.BOARD_READ);
  if (!auth.ok) return auth.response;
  const actor = auth.actor;

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
  const auth = await resolveActor(request, SCOPES.BOARD_WRITE);
  if (!auth.ok) return auth.response;
  const actor = auth.actor;

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
      /*
       * The card's own text is written in here by the server, from the row it
       * just proved — not accepted from the caller.
       *
       * `ai_jobs` rows are self-describing on purpose: the same reason
       * `workspace_id` sits on the row rather than being joined through
       * `card_id` at result time. The runner holds a claim-only credential, so
       * it *cannot* read a card even if it wanted to; an input that omits the
       * content leaves it prompting a model about a card nobody showed it.
       *
       * Caller-supplied keys are kept but cannot shadow these two. A drafted
       * description that was generated from a title the card does not have is
       * worse than no draft, and nothing downstream would reveal the swap.
       */
      input: {
        ...(input ?? {}),
        card: {
          id: card.id,
          title: card.title,
          description: card.description,
        },
      },
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
