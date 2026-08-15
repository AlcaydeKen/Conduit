import { and, asc, eq, lt, sql } from "drizzle-orm";

import { db } from "@/db";
import { cards, columns } from "@/db/schema";
import {
  loadSprintForActor,
  parseIntParam,
  resolveActor,
} from "@/lib/api/guards";
import { SCOPES } from "@/lib/api/scopes";
import { notFound, ok } from "@/lib/api/response";

/** A card untouched for this long is worth surfacing in a standup. */
const STALE_AFTER_DAYS = 7;
const STALE_LIMIT = 20;

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const auth = await resolveActor(request, SCOPES.BOARD_READ);
  if (!auth.ok) return auth.response;
  const actor = auth.actor;

  const { id } = await context.params;
  const sprintId = parseIntParam(id);
  if (!sprintId) return notFound();

  const sprint = await loadSprintForActor(actor, sprintId);
  if (!sprint) return notFound();

  const workspaceId = sprint.workspaceId;
  const staleBefore = new Date(
    Date.now() - STALE_AFTER_DAYS * 24 * 60 * 60 * 1000,
  );

  const inSprint = and(
    eq(cards.workspaceId, workspaceId),
    eq(cards.sprintId, sprintId),
  );

  const [columnRows, perColumn, staleRows] = await Promise.all([
    db
      .select({ id: columns.id, name: columns.name, position: columns.position })
      .from(columns)
      .where(eq(columns.workspaceId, workspaceId))
      .orderBy(asc(columns.position), asc(columns.id)),

    db
      .select({
        columnId: cards.columnId,
        cardCount: sql<number>`count(*)::int`,
        points: sql<number>`coalesce(sum(${cards.points}), 0)::int`,
      })
      .from(cards)
      .where(inSprint)
      .groupBy(cards.columnId),

    db
      .select({
        id: cards.id,
        title: cards.title,
        columnId: cards.columnId,
        updatedAt: cards.updatedAt,
      })
      .from(cards)
      .where(and(inSprint, lt(cards.updatedAt, staleBefore)))
      .orderBy(asc(cards.updatedAt), asc(cards.id))
      .limit(STALE_LIMIT),
  ]);

  const counts = new Map(perColumn.map((row) => [row.columnId, row]));

  // "Done" is the right-most column, the same convention sprint completion uses
  // — derived from `position`, never from a name match that a rename would
  // silently break.
  const doneColumnId = [...columnRows].sort(
    (a, b) => b.position - a.position || b.id - a.id,
  )[0]?.id;

  const byColumn = columnRows.map((column) => ({
    column_id: column.id,
    name: column.name,
    cards: counts.get(column.id)?.cardCount ?? 0,
    points: counts.get(column.id)?.points ?? 0,
    done: column.id === doneColumnId,
  }));

  const totalCards = byColumn.reduce((sum, column) => sum + column.cards, 0);
  const totalPoints = byColumn.reduce((sum, column) => sum + column.points, 0);
  const burned = byColumn.find((column) => column.done);

  return ok({
    sprint: {
      id: sprint.id,
      name: sprint.name,
      status: sprint.status,
      starts_at: sprint.startsAt?.toISOString() ?? null,
      ends_at: sprint.endsAt?.toISOString() ?? null,
    },
    by_column: byColumn,
    totals: {
      cards: totalCards,
      points: totalPoints,
      points_burned: burned?.points ?? 0,
      cards_done: burned?.cards ?? 0,
    },
    stale: {
      after_days: STALE_AFTER_DAYS,
      cards: staleRows.map((row) => ({
        id: row.id,
        title: row.title,
        column_id: row.columnId,
        updated_at: row.updatedAt.toISOString(),
      })),
      truncated: staleRows.length === STALE_LIMIT,
    },
  });
}

