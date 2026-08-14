import { and, asc, count, desc, eq, inArray, isNull, or } from "drizzle-orm";

import { db } from "@/db";
import {
  cardLabels,
  cards,
  columns,
  comments,
  labels,
  sprints,
  users,
} from "@/db/schema";

import type {
  BoardCard,
  BoardPayload,
  SprintFilter,
} from "@/types/board";

export type { BoardCard, BoardPayload, SprintFilter };

export async function listSprints(workspaceId: number) {
  return db
    .select()
    .from(sprints)
    .where(eq(sprints.workspaceId, workspaceId))
    .orderBy(desc(sprints.status), asc(sprints.id));
}

/**
 * Resolves which sprint the board should show when the client did not ask for
 * one: the active sprint, else the newest, else the backlog.
 */
export async function defaultSprintFilter(
  workspaceId: number,
): Promise<SprintFilter> {
  const [active] = await db
    .select({ id: sprints.id })
    .from(sprints)
    .where(
      and(eq(sprints.workspaceId, workspaceId), eq(sprints.status, "active")),
    )
    .orderBy(asc(sprints.id))
    .limit(1);

  if (active) return active.id;

  const [latest] = await db
    .select({ id: sprints.id })
    .from(sprints)
    .where(eq(sprints.workspaceId, workspaceId))
    .orderBy(desc(sprints.id))
    .limit(1);

  return latest?.id ?? "backlog";
}

export async function getBoard(
  workspace: { id: number; name: string; slug: string },
  sprintFilter: SprintFilter,
): Promise<BoardPayload> {
  const workspaceId = workspace.id;

  // When a sprint is selected we also pull the backlog, in the SAME query, so
  // the rail can render beside the board and cards can be dragged between them.
  const sprintPredicate =
    sprintFilter === "backlog"
      ? isNull(cards.sprintId)
      : or(eq(cards.sprintId, sprintFilter), isNull(cards.sprintId));

  const [sprintRows, columnRows, cardRows] = await Promise.all([
    listSprints(workspaceId),
    db
      .select()
      .from(columns)
      .where(eq(columns.workspaceId, workspaceId))
      .orderBy(asc(columns.position), asc(columns.id)),
    db
      .select({
        id: cards.id,
        title: cards.title,
        description: cards.description,
        columnId: cards.columnId,
        sprintId: cards.sprintId,
        priority: cards.priority,
        points: cards.points,
        position: cards.position,
        assigneeId: users.id,
        assigneeName: users.name,
        assigneeImage: users.image,
      })
      .from(cards)
      .leftJoin(users, eq(users.id, cards.assigneeId))
      .where(and(eq(cards.workspaceId, workspaceId), sprintPredicate))
      // The tie-breaker every ordered read in this system must carry.
      .orderBy(asc(cards.position), asc(cards.id)),
  ]);

  const cardIds = cardRows.map((row) => row.id);

  const [labelRows, commentCounts] = await Promise.all([
    cardIds.length
      ? db
          .select({
            cardId: cardLabels.cardId,
            id: labels.id,
            name: labels.name,
            color: labels.color,
          })
          .from(cardLabels)
          .innerJoin(labels, eq(labels.id, cardLabels.labelId))
          .where(inArray(cardLabels.cardId, cardIds))
      : Promise.resolve([]),
    cardIds.length
      ? db
          .select({ cardId: comments.cardId, total: count() })
          .from(comments)
          .where(inArray(comments.cardId, cardIds))
          .groupBy(comments.cardId)
      : Promise.resolve([]),
  ]);

  const labelsByCard = new Map<number, BoardCard["labels"]>();
  for (const row of labelRows) {
    const list = labelsByCard.get(row.cardId) ?? [];
    list.push({ id: row.id, name: row.name, color: row.color });
    labelsByCard.set(row.cardId, list);
  }

  const countsByCard = new Map(
    commentCounts.map((row) => [row.cardId, Number(row.total)]),
  );

  return {
    workspace,
    sprints: sprintRows.map((sprint) => ({
      id: sprint.id,
      name: sprint.name,
      goal: sprint.goal,
      status: sprint.status,
      starts_at: sprint.startsAt?.toISOString() ?? null,
      ends_at: sprint.endsAt?.toISOString() ?? null,
    })),
    selected_sprint: sprintFilter,
    columns: columnRows.map((column) => ({
      id: column.id,
      name: column.name,
      position: column.position,
      wip_limit: column.wipLimit,
    })),
    // Both lists keep the `position ASC, id ASC` order the query produced.
    cards: cardRows.filter(inSelectedView).map(toBoardCard),
    backlog:
      sprintFilter === "backlog"
        ? []
        : cardRows.filter((row) => row.sprintId === null).map(toBoardCard),
  };

  function inSelectedView(row: (typeof cardRows)[number]) {
    return sprintFilter === "backlog"
      ? row.sprintId === null
      : row.sprintId === sprintFilter;
  }

  function toBoardCard(row: (typeof cardRows)[number]): BoardCard {
    return {
      id: row.id,
      title: row.title,
      description: row.description,
      column_id: row.columnId,
      sprint_id: row.sprintId,
      priority: row.priority,
      points: row.points,
      position: row.position,
      assignee: row.assigneeId
        ? { id: row.assigneeId, name: row.assigneeName, image: row.assigneeImage }
        : null,
      labels: labelsByCard.get(row.id) ?? [],
      comment_count: countsByCard.get(row.id) ?? 0,
    };
  }
}
