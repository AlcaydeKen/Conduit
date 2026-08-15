/**
 * Mints the service-scoped claim key the n8n runner authenticates with.
 *
 * Run: pnpm claim-key:mint
 *      pnpm claim-key:mint --label "n8n claim key" --revoke-existing
 *
 * There is no UI for this, and there should not be. Every other credential in
 * the system is tenant-bounded: a workspace key can only ever see the workspace
 * it was minted in. This one is not. It drains the queue for every tenant, so
 * it must be created from a terminal by someone who meant to, rather than from
 * a form that a member could reach by wandering through Settings.
 *
 * The script exists because the alternative — copy a digest out of `node -e`
 * and paste it into a hand-written INSERT — has two silent failure modes. A
 * mistyped hash mints a key nobody holds, and an omitted `["ai:claim"]` mints
 * one the claim endpoint refuses. Both look like "n8n is broken" hours later.
 */
import { and, eq, isNull } from "drizzle-orm";

import { db } from "@/db";
import { apiKeys } from "@/db/schema";
import { generateApiKey } from "@/lib/api/keys";
import { SCOPES } from "@/lib/api/scopes";

function readFlag(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return null;
  return process.argv[index + 1] ?? null;
}

const label = readFlag("label") ?? "n8n claim key";
const revokeExisting = process.argv.includes("--revoke-existing");

async function main() {
  // A service key is the one row where `workspace_id IS NULL`. That predicate is
  // the whole definition — `resolveKeyActor` excludes it with IS NOT NULL, and
  // `resolveClaimKey` requires it with IS NULL.
  const live = await db
    .select({ id: apiKeys.id, label: apiKeys.label, lastUsedAt: apiKeys.lastUsedAt })
    .from(apiKeys)
    .where(and(isNull(apiKeys.workspaceId), eq(apiKeys.revoked, false)));

  if (live.length > 0 && !revokeExisting) {
    // Refusing rather than adding a second one is deliberate. Two live claim
    // keys means revoking the leaked one does not end the leak unless you know
    // which of them leaked, and `last_used_at` is the only distinguishing
    // evidence — both are unlabelled traffic from the same runner otherwise.
    console.error("A live claim key already exists:\n");
    for (const row of live) {
      const used = row.lastUsedAt?.toISOString() ?? "never used";
      console.error(`  #${row.id}  ${row.label}  (${used})`);
    }
    console.error(
      "\nRe-run with --revoke-existing to revoke it and mint a replacement,",
    );
    console.error("or revoke it yourself if you still hold the plaintext.");
    process.exit(1);
  }

  if (live.length > 0) {
    // Revoke before minting, not after. If the process dies between the two,
    // the failure is "no runner can claim" — noisy and obvious. The other order
    // fails as "two live keys, one of them unaccounted for", which is silent.
    await db
      .update(apiKeys)
      .set({ revoked: true })
      .where(and(isNull(apiKeys.workspaceId), eq(apiKeys.revoked, false)));

    console.log(`Revoked ${live.length} existing claim key(s).\n`);
  }

  const { plaintext, hash } = generateApiKey();

  const [created] = await db
    .insert(apiKeys)
    .values({
      // Explicit rather than omitted: this null is the security property, not a
      // missing value, and it should read that way at the call site.
      workspaceId: null,
      label,
      keyHash: hash,
      // Required, not decorative. `resolveClaimKey` checks it, so a
      // workspace-less key without this scope authenticates as nothing at all.
      scopes: [SCOPES.AI_CLAIM],
      createdBy: null,
    })
    .returning({ id: apiKeys.id, createdAt: apiKeys.createdAt });

  console.log(`Minted claim key #${created.id} (${label}).`);
  console.log(`Scopes: ["${SCOPES.AI_CLAIM}"]  workspace_id: null\n`);
  console.log("Paste this into the n8n Header Auth credential, whole:\n");
  console.log(`  Bearer ${plaintext}\n`);
  console.log(
    "It is not recoverable — the column holds a SHA-256 digest, not the key.",
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
