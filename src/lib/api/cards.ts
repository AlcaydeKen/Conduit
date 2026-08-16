import { eq, inArray } from "drizzle-orm";

import { db } from "@/db";
import { cardLabels, cards, labels, users } from "@/db/schema";

/**
 * The card shape the machine API returns. Kept out of the route files so
 * `/cards`, `/cards/:id` and any future consumer cannot drift into returning
 * subtly different objects for the same row.
 */
export const cardProjection = {
  id: cards.id,
  title: cards.title,
  description: cards.description,
  columnId: cards.columnId,
  sprintId: cards.sprintId,
  priority: cards.priority,
  points: cards.points,
  position: cards.position,
  updatedAt: cards.updatedAt,
  archivedAt: cards.archivedAt,
  assigneeId: users.id,
  assigneeName: users.name,
  assigneeImage: users.image,
};

/** The join that fills the assignee half of `cardProjection`. */
export const assigneeJoin = eq(users.id, cards.assigneeId);

export type CardRow = {
  id: number;
  title: string;
  description: string | null;
  columnId: number;
  sprintId: number | null;
  priority: "low" | "medium" | "high" | "urgent";
  points: number | null;
  position: string;
  updatedAt: Date;
  archivedAt: Date | null;
  assigneeId: string | null;
  assigneeName: string | null;
  assigneeImage: string | null;
};

export type ApiLabel = { id: number; name: string; color: string };

/**
 * Labels for a set of cards, in one query, keyed by card id.
 *
 * A join against the main card query would multiply rows per label and force
 * the caller to re-collapse them; `getBoard` already solved this the same way.
 * Shared so the machine API and the board payload cannot drift into disagreeing
 * about what a card's labels are.
 *
 * No tenant predicate of its own, deliberately: every caller passes ids that a
 * workspace-scoped query already produced, and adding a second boundary here
 * would suggest the first one is optional.
 */
export async function labelsByCard(
  cardIds: number[],
): Promise<Map<number, ApiLabel[]>> {
  const byCard = new Map<number, ApiLabel[]>();
  if (cardIds.length === 0) return byCard;

  const rows = await db
    .select({
      cardId: cardLabels.cardId,
      id: labels.id,
      name: labels.name,
      color: labels.color,
    })
    .from(cardLabels)
    .innerJoin(labels, eq(labels.id, cardLabels.labelId))
    .where(inArray(cardLabels.cardId, cardIds));

  for (const row of rows) {
    const list = byCard.get(row.cardId) ?? [];
    list.push({ id: row.id, name: row.name, color: row.color });
    byCard.set(row.cardId, list);
  }
  return byCard;
}

export function toApiCard(row: CardRow, cardLabelList: ApiLabel[] = []) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    column_id: row.columnId,
    sprint_id: row.sprintId,
    priority: row.priority,
    points: row.points,
    position: row.position,
    updated_at: row.updatedAt.toISOString(),
    archived: row.archivedAt !== null,
    archived_at: row.archivedAt?.toISOString() ?? null,
    assignee: row.assigneeId
      ? { id: row.assigneeId, name: row.assigneeName, image: row.assigneeImage }
      : null,
    labels: cardLabelList,
  };
}
