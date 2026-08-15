import { and, asc, desc, eq, ne, sql } from "drizzle-orm";
import { generateNKeysBetween } from "fractional-indexing";
import { z } from "zod";

import { db } from "@/db";
import { cards, columns, sprints } from "@/db/schema";
import { logActivity } from "@/lib/api/activity";
import {
  loadSprintForActor,
  parseIntParam,
  requireScope,
  resolveActor,
} from "@/lib/api/guards";
import { SCOPES } from "@/lib/api/scopes";
import { badRequest, notFound, ok, unauthorized } from "@/lib/api/response";
import { readOrder, type OrderScope } from "@/lib/ordering";

const completeSchema = z.object({
  /** Where unfinished cards go. Defaults to the backlog. */
  carry_over_to: z
    .union([z.literal("backlog"), z.number().int().positive()])
    .optional(),
});

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const actor = await resolveActor(request);
  if (!actor) return unauthorized();

  const denied = requireScope(actor, SCOPES.BOARD_WRITE);
  if (denied) return denied;

  const { id } = await context.params;
  const sprintId = parseIntParam(id);
  if (!sprintId) return notFound();

  const parsed = completeSchema.safeParse(
    (await request.json().catch(() => null)) ?? {},
  );
  if (!parsed.success) return badRequest("invalid_body", parsed.error.issues);
  const carryOverTo = parsed.data.carry_over_to ?? "backlog";

  const sprint = await loadSprintForActor(actor, sprintId);
  if (!sprint) return notFound();
  if (sprint.status === "completed") return badRequest("sprint_already_completed");

  const workspaceId = sprint.workspaceId;

  if (carryOverTo !== "backlog") {
    if (carryOverTo === sprintId) return badRequest("carry_over_to_self");
    const [destination] = await db
      .select({ id: sprints.id })
      .from(sprints)
      .where(
        and(
          eq(sprints.id, carryOverTo),
          eq(sprints.workspaceId, workspaceId),
          ne(sprints.status, "completed"),
        ),
      )
      .limit(1);
    if (!destination) return notFound();
  }

  // "Done" is the right-most column. That is a convention, not a schema fact —
  // there is no done flag on `columns` — so it is stated here rather than
  // hidden behind a name match on "Done", which would break on a rename.
  const [doneColumn] = await db
    .select({ id: columns.id })
    .from(columns)
    .where(eq(columns.workspaceId, workspaceId))
    .orderBy(desc(columns.position), desc(columns.id))
    .limit(1);

  const unfinished = doneColumn
    ? await db
        .select({ id: cards.id, columnId: cards.columnId })
        .from(cards)
        .where(
          and(
            eq(cards.workspaceId, workspaceId),
            eq(cards.sprintId, sprintId),
            ne(cards.columnId, doneColumn.id),
          ),
        )
        .orderBy(asc(cards.position), asc(cards.id))
    : [];

  let carried = 0;

  if (unfinished.length > 0) {
    // Each destination scope has its own key space, so keys are minted per
    // scope and appended after whatever is already there.
    const byScope = new Map<string, { scope: OrderScope; ids: number[] }>();

    for (const card of unfinished) {
      const scope: OrderScope =
        carryOverTo === "backlog"
          ? { kind: "backlog", workspaceId }
          : {
              kind: "board",
              workspaceId,
              columnId: card.columnId,
              sprintId: carryOverTo,
            };
      const key =
        scope.kind === "backlog" ? "backlog" : `column:${card.columnId}`;
      const bucket = byScope.get(key) ?? { scope, ids: [] };
      bucket.ids.push(card.id);
      byScope.set(key, bucket);
    }

    const assignments: { id: number; position: string }[] = [];
    for (const { scope, ids } of byScope.values()) {
      const existing = await readOrder(scope);
      const lastKey = existing.at(-1)?.position ?? null;
      const keys = generateNKeysBetween(lastKey, null, ids.length);
      ids.forEach((cardId, index) =>
        assignments.push({ id: cardId, position: keys[index] }),
      );
    }

    const values = sql.join(
      assignments.map(
        (row) => sql`(${row.id}::int, ${row.position}::text)`,
      ),
      sql`, `,
    );

    // One statement: neon-http has no interactive transaction, and a partial
    // carry-over would strand cards between two sprints.
    await db.execute(sql`
      UPDATE ${cards} AS c
      SET position = v.position,
          sprint_id = ${carryOverTo === "backlog" ? null : carryOverTo},
          updated_at = now()
      FROM (VALUES ${values}) AS v(id, position)
      WHERE c.id = v.id
        AND c.workspace_id = ${workspaceId}
        AND c.sprint_id = ${sprintId}
    `);

    carried = assignments.length;
  }

  const [updated] = await db
    .update(sprints)
    .set({ status: "completed", endsAt: sprint.endsAt ?? new Date() })
    .where(and(eq(sprints.id, sprintId), eq(sprints.workspaceId, workspaceId)))
    .returning();

  const [{ remaining }] = await db
    .select({ remaining: sql<number>`count(*)::int` })
    .from(cards)
    .where(
      and(eq(cards.workspaceId, workspaceId), eq(cards.sprintId, sprintId)),
    );

  await logActivity({
    workspaceId,
    actor,
    action: "sprint.complete",
    payload: {
      sprint_id: sprintId,
      carried_over: carried,
      carried_to: carryOverTo,
      completed_in_sprint: remaining,
    },
  });

  return ok({
    sprint: {
      id: updated.id,
      name: updated.name,
      status: updated.status,
      ends_at: updated.endsAt?.toISOString() ?? null,
    },
    carried_over: carried,
    carried_to: carryOverTo,
    completed_in_sprint: remaining,
  });
}
