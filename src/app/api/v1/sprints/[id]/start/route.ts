import { and, eq, ne } from "drizzle-orm";

import { db } from "@/db";
import { sprints, workspaceMembers } from "@/db/schema";
import { parseIntParam, resolveActor } from "@/lib/api/guards";
import { badRequest, conflict, notFound, ok, unauthorized } from "@/lib/api/response";

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const actor = await resolveActor();
  if (!actor) return unauthorized();

  const { id } = await context.params;
  const sprintId = parseIntParam(id);
  if (!sprintId) return notFound();

  // Sprint lookup and membership proof in one statement.
  const [sprint] = await db
    .select({
      id: sprints.id,
      workspaceId: sprints.workspaceId,
      status: sprints.status,
      startsAt: sprints.startsAt,
    })
    .from(sprints)
    .innerJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.workspaceId, sprints.workspaceId),
        eq(workspaceMembers.userId, actor.userId),
      ),
    )
    .where(eq(sprints.id, sprintId))
    .limit(1);

  if (!sprint) return notFound();

  if (sprint.status === "active") return ok({ sprint: { id: sprint.id, status: "active" } });
  if (sprint.status === "completed") return badRequest("sprint_already_completed");

  // One active sprint per workspace. Refusing is deliberate: silently completing
  // whatever was running would move another person's in-flight cards.
  const [otherActive] = await db
    .select({ id: sprints.id })
    .from(sprints)
    .where(
      and(
        eq(sprints.workspaceId, sprint.workspaceId),
        eq(sprints.status, "active"),
        ne(sprints.id, sprintId),
      ),
    )
    .limit(1);

  if (otherActive) return conflict("active_sprint_exists");

  const [updated] = await db
    .update(sprints)
    .set({
      status: "active",
      startsAt: sprint.startsAt ?? new Date(),
    })
    .where(
      and(
        eq(sprints.id, sprintId),
        eq(sprints.workspaceId, sprint.workspaceId),
      ),
    )
    .returning();

  return ok({
    sprint: {
      id: updated.id,
      name: updated.name,
      status: updated.status,
      starts_at: updated.startsAt?.toISOString() ?? null,
      ends_at: updated.endsAt?.toISOString() ?? null,
    },
  });
}
