/**
 * Server-side view of the AI queue: whether the claim key actually
 * authenticated, and what the jobs are doing.
 *
 * Run: pnpm queue:status
 *
 * `pnpm verify:queue` answers "does the queue work". This answers "what is the
 * runner actually doing right now", which is the other question you have when
 * n8n looks wrong — and it answers it without believing anything the n8n canvas
 * says. A green execution proves the workflow ran, not that the claim was
 * accepted; `last_used_at` moving is the server's own evidence that it was.
 */
import { desc, isNull } from "drizzle-orm";

import { db } from "@/db";
import { aiJobs, apiKeys } from "@/db/schema";

function ago(at: Date | null): string {
  if (!at) return "never";
  const seconds = Math.round((Date.now() - at.getTime()) / 1000);
  if (seconds < 90) return `${seconds}s ago`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

async function main() {
  // `workspace_id IS NULL` is the service-key definition, not a missing value.
  const keys = await db
    .select({
      id: apiKeys.id,
      label: apiKeys.label,
      revoked: apiKeys.revoked,
      lastUsedAt: apiKeys.lastUsedAt,
    })
    .from(apiKeys)
    .where(isNull(apiKeys.workspaceId))
    .orderBy(desc(apiKeys.id))
    .limit(5);

  console.log("service keys (workspace_id IS NULL):");
  if (keys.length === 0) console.log("  (none — pnpm claim-key:mint)");
  for (const key of keys) {
    const flag = key.revoked ? " [REVOKED]" : "";
    console.log(`  #${key.id} ${key.label}${flag} — last used ${ago(key.lastUsedAt)}`);
  }

  const jobs = await db
    .select({
      id: aiJobs.id,
      workspaceId: aiJobs.workspaceId,
      cardId: aiJobs.cardId,
      kind: aiJobs.kind,
      status: aiJobs.status,
      attempts: aiJobs.attempts,
      error: aiJobs.error,
      updatedAt: aiJobs.updatedAt,
    })
    .from(aiJobs)
    .orderBy(desc(aiJobs.id))
    .limit(10);

  console.log("\nrecent ai_jobs:");
  if (jobs.length === 0) console.log("  (none)");
  for (const job of jobs) {
    const detail = job.error ? `  error=${job.error}` : "";
    console.log(
      `  #${job.id} ws=${job.workspaceId} card=${job.cardId ?? "-"} ` +
        `${job.kind} ${job.status} attempts=${job.attempts} ` +
        `updated ${ago(job.updatedAt)}${detail}`,
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
