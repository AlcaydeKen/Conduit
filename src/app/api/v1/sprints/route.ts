import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db";
import { sprints } from "@/db/schema";
import {
  parseIntParam,
  resolveActor,
  resolveWorkspace,
} from "@/lib/api/guards";
import { badRequest, conflict, notFound, ok, unauthorized } from "@/lib/api/response";
import { listSprints } from "@/lib/board-queries";

const createSchema = z.object({
  workspace_id: z.number().int().positive().optional(),
  name: z.string().trim().min(1).max(120),
  goal: z.string().trim().max(2000).nullish(),
  starts_at: z.iso.datetime({ offset: true }).nullish(),
  ends_at: z.iso.datetime({ offset: true }).nullish(),
  /** Start it immediately instead of leaving it planned. */
  activate: z.boolean().optional(),
});

export async function GET(request: Request) {
  const actor = await resolveActor();
  if (!actor) return unauthorized();

  const url = new URL(request.url);
  const workspace = await resolveWorkspace(
    actor,
    parseIntParam(url.searchParams.get("workspace")),
  );
  if (!workspace) return notFound();

  const rows = await listSprints(workspace.id);
  return ok({
    sprints: rows.map((sprint) => ({
      id: sprint.id,
      name: sprint.name,
      goal: sprint.goal,
      status: sprint.status,
      starts_at: sprint.startsAt?.toISOString() ?? null,
      ends_at: sprint.endsAt?.toISOString() ?? null,
    })),
  });
}

export async function POST(request: Request) {
  const actor = await resolveActor();
  if (!actor) return unauthorized();

  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest("invalid_body", parsed.error.issues);

  // `workspace_id` in the body is a hint only; membership is proven by the join
  // inside resolveWorkspace, and a workspace the caller cannot see is absent.
  const workspace = await resolveWorkspace(actor, parsed.data.workspace_id);
  if (!workspace) return notFound();

  const { name, goal, starts_at, ends_at, activate } = parsed.data;

  if (starts_at && ends_at && new Date(starts_at) > new Date(ends_at)) {
    return badRequest("ends_at_before_starts_at");
  }

  if (activate) {
    const [existingActive] = await db
      .select({ id: sprints.id })
      .from(sprints)
      .where(
        and(
          eq(sprints.workspaceId, workspace.id),
          eq(sprints.status, "active"),
        ),
      )
      .limit(1);

    if (existingActive) return conflict("active_sprint_exists");
  }

  const [created] = await db
    .insert(sprints)
    .values({
      workspaceId: workspace.id,
      name,
      goal: goal ?? null,
      startsAt: starts_at ? new Date(starts_at) : null,
      endsAt: ends_at ? new Date(ends_at) : null,
      status: activate ? "active" : "planned",
    })
    .returning();

  return ok({
    sprint: {
      id: created.id,
      name: created.name,
      goal: created.goal,
      status: created.status,
      starts_at: created.startsAt?.toISOString() ?? null,
      ends_at: created.endsAt?.toISOString() ?? null,
    },
  });
}
