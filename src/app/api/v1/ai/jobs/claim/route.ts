import { sql } from "drizzle-orm";

import { db } from "@/db";
import { resolveClaimKey } from "@/lib/api/guards";
import { TOKEN_TTL_SECONDS, signJobToken } from "@/lib/api/job-token";
import { ok, unauthorized } from "@/lib/api/response";

/** n8n polls on a one-minute schedule; this only stops a runaway loop. */
const MIN_POLL_INTERVAL_SECONDS = 5;

/** A job left claimed this long is assumed abandoned by its runner. */
const STALE_AFTER_MINUTES = 10;

/** Give up rather than feed the same poison input to the model forever. */
const MAX_ATTEMPTS = 3;

function tooManyRequests(): Response {
  return Response.json(
    { error: "rate_limited", retry_after_seconds: MIN_POLL_INTERVAL_SECONDS },
    { status: 429, headers: { "retry-after": String(MIN_POLL_INTERVAL_SECONDS) } },
  );
}

export async function POST(request: Request) {
  const outcome = await resolveClaimKey(request, MIN_POLL_INTERVAL_SECONDS);
  if (!outcome.ok) {
    return outcome.reason === "rate_limited" ? tooManyRequests() : unauthorized();
  }

  // Sweep before claiming. The runner polls every minute anyway, so there is no
  // reason to stand up a separate cron for this: a job whose runner died is
  // either retried or failed permanently the next time anyone asks for work.
  // The casts are load-bearing: a CASE over two bare literals is typed `text`,
  // and Postgres will not assign text to an enum column (42804).
  await db.execute(sql`
    UPDATE ai_jobs
    SET status = CASE
                   WHEN attempts >= ${MAX_ATTEMPTS} THEN 'failed'::ai_job_status
                   ELSE 'pending'::ai_job_status
                 END,
        error = CASE WHEN attempts >= ${MAX_ATTEMPTS}
                     THEN 'abandoned after ' || attempts || ' attempts'
                     ELSE error END,
        claimed_at = NULL,
        updated_at = now()
    WHERE status = 'claimed'
      AND claimed_at < now() - make_interval(mins => ${STALE_AFTER_MINUTES})
  `);

  /*
   * One statement, and it has to be. neon-http gives every statement its own
   * transaction, so a SELECT ... FOR UPDATE SKIP LOCKED followed by a separate
   * UPDATE would release the lock between the two and hand the same job to two
   * runners. Nesting the locking select inside the update keeps the claim
   * atomic over a stateless driver.
   *
   * SKIP LOCKED here is not a contradiction of the no-locking stance on card
   * moves. A work queue genuinely needs exactly-once handoff; card ordering
   * does not, and pays for locks it cannot benefit from.
   */
  const claimed = await db.execute(sql`
    UPDATE ai_jobs
    SET status = 'claimed'::ai_job_status,
        claimed_at = now(),
        attempts = attempts + 1,
        updated_at = now()
    WHERE id = (
      SELECT id FROM ai_jobs
      WHERE status = 'pending'
      ORDER BY created_at ASC, id ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING id, workspace_id, card_id, kind, input, attempts
  `);

  const row = (claimed.rows ?? claimed)[0] as
    | {
        id: number;
        workspace_id: number;
        card_id: number | null;
        kind: string;
        input: unknown;
        attempts: number;
      }
    | undefined;

  // An empty queue is not an error. The runner should treat it as "nothing to
  // do" and go back to sleep, not as a failure worth alerting on.
  if (!row) return ok({ job: null });

  const exp = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS;

  return ok({
    job: {
      id: row.id,
      workspace_id: row.workspace_id,
      card_id: row.card_id,
      kind: row.kind,
      input: row.input,
      attempts: row.attempts,
    },
    // The only thing that will let the runner report back. The workspace is
    // signed into it, so n8n never gets to say which tenant a result belongs to.
    token: signJobToken({
      job_id: row.id,
      workspace_id: row.workspace_id,
      exp,
    }),
    expires_at: new Date(exp * 1000).toISOString(),
  });
}
