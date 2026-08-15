import { eq } from "drizzle-orm";

import { cards, users } from "@/db/schema";

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
  assigneeId: string | null;
  assigneeName: string | null;
  assigneeImage: string | null;
};

export function toApiCard(row: CardRow) {
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
    assignee: row.assigneeId
      ? { id: row.assigneeId, name: row.assigneeName, image: row.assigneeImage }
      : null,
  };
}
