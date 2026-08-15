/**
 * One-off backfill: give every pre-scope key the rights it already had.
 *
 * Run: pnpm tsx --env-file=.env.local scripts/migrate-key-scopes.ts
 *
 * Before scopes were enforced, `api_keys.scopes` was written as `[]` and read by
 * nothing, so every key had full access to its workspace. Enforcing the column
 * without this would silently 403 every key already in circulation — the change
 * would look like a broken deploy rather than a policy change.
 *
 * Idempotent: only rows with an empty array are touched.
 */
import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { apiKeys } from "@/db/schema";
import { FULL_WORKSPACE_SCOPES, SCOPES } from "@/lib/api/scopes";

async function main() {
  const empty = sql`jsonb_array_length(${apiKeys.scopes}) = 0`;

  const workspaceKeys = await db
    .update(apiKeys)
    .set({ scopes: FULL_WORKSPACE_SCOPES })
    .where(sql`${empty} and ${apiKeys.workspaceId} is not null`)
    .returning({ id: apiKeys.id, label: apiKeys.label });

  // A workspace-less key can only ever have been a claim key: nothing else has
  // ever been able to use one.
  const serviceKeys = await db
    .update(apiKeys)
    .set({ scopes: [SCOPES.AI_CLAIM] })
    .where(sql`${empty} and ${apiKeys.workspaceId} is null`)
    .returning({ id: apiKeys.id, label: apiKeys.label });

  for (const row of workspaceKeys) {
    console.log(`  workspace key #${row.id} "${row.label}" -> read & write`);
  }
  for (const row of serviceKeys) {
    console.log(`  service key   #${row.id} "${row.label}" -> claim only`);
  }

  const remaining = await db
    .select({ id: apiKeys.id, scopes: apiKeys.scopes, label: apiKeys.label })
    .from(apiKeys)
    .where(eq(apiKeys.revoked, false));

  const scopeless = remaining.filter((row) => row.scopes.length === 0);
  console.log(
    `\nbackfilled ${workspaceKeys.length + serviceKeys.length} key(s); ` +
      `${scopeless.length} active key(s) still have no scopes`,
  );
  if (scopeless.length > 0) {
    console.error("  these would now be refused:", scopeless);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
