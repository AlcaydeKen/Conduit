import { asc, eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db";
import { labels } from "@/db/schema";
import { logActivity } from "@/lib/api/activity";
import {
  parseIntParam,
  resolveActor,
  resolveWorkspace,
} from "@/lib/api/guards";
import { badRequest, conflict, notFound, ok } from "@/lib/api/response";
import { SCOPES } from "@/lib/api/scopes";

/**
 * Labels existed in the schema, on the board payload, and in both render paths
 * long before anything could create one. This is the missing half.
 *
 * There is no DELETE. `card_labels` cascades, so removing a label would silently
 * strip it from every card that carries it, and `activity` records label changes
 * by id — a deleted label turns that history into dangling numbers. Detaching a
 * label from a card is `PATCH /cards/:id` with `label_ids`; that is the
 * reversible operation, and it is the one people actually mean.
 */
const createSchema = z.object({
  workspace_id: z.number().int().positive().optional(),
  name: z.string().trim().min(1).max(60),
  /** Rendered as a chip background, so it has to be a colour the DOM accepts. */
  color: z
    .string()
    .trim()
    .regex(/^#[0-9a-fA-F]{6}$/, "expected #rrggbb")
    .optional(),
});

export async function GET(request: Request) {
  const auth = await resolveActor(request, SCOPES.BOARD_READ);
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const workspace = await resolveWorkspace(
    auth.actor,
    parseIntParam(url.searchParams.get("workspace")),
  );
  if (!workspace) return notFound();

  const rows = await db
    .select({ id: labels.id, name: labels.name, color: labels.color })
    .from(labels)
    .where(eq(labels.workspaceId, workspace.id))
    .orderBy(asc(labels.name), asc(labels.id));

  return ok({
    workspace: { id: workspace.id, name: workspace.name },
    labels: rows,
  });
}

export async function POST(request: Request) {
  const auth = await resolveActor(request, SCOPES.BOARD_WRITE);
  if (!auth.ok) return auth.response;
  const actor = auth.actor;

  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest("invalid_body", parsed.error.issues);

  const workspace = await resolveWorkspace(actor, parsed.data.workspace_id);
  if (!workspace) return notFound();

  /*
   * `labels_workspace_name_idx` is unique on (workspace_id, name), so the
   * database decides whether this name is taken — not a SELECT beforehand.
   * Two people adding "blocked" at once would both find nothing and both
   * insert; `onConflictDoNothing` returns no row for the loser, which is the
   * only version of this check that is atomic.
   */
  const [created] = await db
    .insert(labels)
    .values({
      workspaceId: workspace.id,
      name: parsed.data.name,
      color: parsed.data.color ?? "#64748b",
    })
    .onConflictDoNothing()
    .returning({ id: labels.id, name: labels.name, color: labels.color });

  if (!created) return conflict("label_exists");

  await logActivity({
    workspaceId: workspace.id,
    actor,
    action: "label.create",
    payload: { label_id: created.id, name: created.name },
  });

  return ok({ label: created });
}
