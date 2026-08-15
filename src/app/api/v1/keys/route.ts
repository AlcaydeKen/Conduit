import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db";
import { apiKeys } from "@/db/schema";
import { logActivity } from "@/lib/api/activity";
import { resolveSessionActor, resolveWorkspace } from "@/lib/api/guards";
import { generateApiKey } from "@/lib/api/keys";
import { badRequest, notFound, ok, unauthorized } from "@/lib/api/response";
import { parseIntParam } from "@/lib/api/guards";

/**
 * Key management is session-only, on purpose.
 *
 * These handlers call `resolveSessionActor` rather than `resolveActor`, so a
 * Bearer token cannot reach them at all — not to list keys, not to mint one,
 * not to revoke one. A machine credential that could issue further credentials
 * turns a single leaked key into permanent, self-renewing access, and revoking
 * the original would no longer be enough to end it.
 */
const createSchema = z.object({
  workspace_id: z.number().int().positive().optional(),
  label: z.string().trim().min(1).max(120),
});

export async function GET(request: Request) {
  const actor = await resolveSessionActor();
  if (!actor) return unauthorized();

  const url = new URL(request.url);
  const workspace = await resolveWorkspace(
    actor,
    parseIntParam(url.searchParams.get("workspace")),
  );
  if (!workspace) return notFound();

  // `key_hash` is never selected. There is nothing useful a caller could do
  // with it, and everything an attacker could.
  const rows = await db
    .select({
      id: apiKeys.id,
      label: apiKeys.label,
      revoked: apiKeys.revoked,
      createdAt: apiKeys.createdAt,
      lastUsedAt: apiKeys.lastUsedAt,
      createdBy: apiKeys.createdBy,
    })
    .from(apiKeys)
    .where(eq(apiKeys.workspaceId, workspace.id))
    .orderBy(desc(apiKeys.createdAt), desc(apiKeys.id));

  return ok({
    workspace: { id: workspace.id, name: workspace.name },
    keys: rows.map((row) => ({
      id: row.id,
      label: row.label,
      revoked: row.revoked,
      created_at: row.createdAt.toISOString(),
      last_used_at: row.lastUsedAt?.toISOString() ?? null,
      created_by: row.createdBy,
    })),
  });
}

export async function POST(request: Request) {
  // The `kind` test looks redundant next to `resolveSessionActor`, which can
  // only return a user actor — it is there to narrow the union so `actor.userId`
  // below is a type error if this function ever starts accepting keys.
  const actor = await resolveSessionActor();
  if (!actor || actor.kind !== "user") return unauthorized();

  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest("invalid_body", parsed.error.issues);

  const workspace = await resolveWorkspace(actor, parsed.data.workspace_id);
  if (!workspace) return notFound();

  const { plaintext, hash } = generateApiKey();

  const [created] = await db
    .insert(apiKeys)
    .values({
      workspaceId: workspace.id,
      label: parsed.data.label,
      keyHash: hash,
      createdBy: actor.userId,
      scopes: [],
    })
    .returning({
      id: apiKeys.id,
      label: apiKeys.label,
      createdAt: apiKeys.createdAt,
    });

  await logActivity({
    workspaceId: workspace.id,
    actor,
    action: "api_key.create",
    payload: { key_id: created.id, label: created.label },
  });

  return ok({
    key: {
      id: created.id,
      label: created.label,
      created_at: created.createdAt.toISOString(),
    },
    // The only time this value exists outside the caller's own memory. It is
    // not recoverable afterwards: the column holds a digest.
    plaintext,
  });
}

export async function DELETE(request: Request) {
  const actor = await resolveSessionActor();
  if (!actor) return unauthorized();

  const url = new URL(request.url);
  const keyId = parseIntParam(url.searchParams.get("id"));
  if (!keyId) return notFound();

  const workspace = await resolveWorkspace(
    actor,
    parseIntParam(url.searchParams.get("workspace")),
  );
  if (!workspace) return notFound();

  // Revoked rather than deleted: `activity` refers to keys by label, and a
  // deleted row would leave that history pointing at nothing. The tenant
  // predicate is on the write itself.
  const [revoked] = await db
    .update(apiKeys)
    .set({ revoked: true })
    .where(and(eq(apiKeys.id, keyId), eq(apiKeys.workspaceId, workspace.id)))
    .returning({ id: apiKeys.id, label: apiKeys.label });

  if (!revoked) return notFound();

  await logActivity({
    workspaceId: workspace.id,
    actor,
    action: "api_key.revoke",
    payload: { key_id: revoked.id, label: revoked.label },
  });

  return ok({ revoked: { id: revoked.id } });
}
