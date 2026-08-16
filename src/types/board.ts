/**
 * Wire shapes shared by the API routes and the client components. Kept free of
 * any database import so client bundles never pull server code in behind a
 * type-only reference.
 */

export type SprintFilter = number | "backlog";

export type Priority = "low" | "medium" | "high" | "urgent";

export type SprintStatus = "planned" | "active" | "completed";

export type Person = {
  id: string;
  name: string | null;
  image: string | null;
};

export type BoardCard = {
  id: number;
  title: string;
  description: string | null;
  column_id: number;
  sprint_id: number | null;
  priority: Priority;
  points: number | null;
  position: string;
  assignee: Person | null;
  labels: { id: number; name: string; color: string }[];
  comment_count: number;
};

export type BoardColumn = {
  id: number;
  name: string;
  position: number;
  wip_limit: number | null;
};

export type BoardSprint = {
  id: number;
  name: string;
  goal: string | null;
  status: SprintStatus;
  starts_at: string | null;
  ends_at: string | null;
};

export type BoardLabel = { id: number; name: string; color: string };

export type BoardPayload = {
  workspace: { id: number; name: string; slug: string };
  sprints: BoardSprint[];
  selected_sprint: SprintFilter;
  columns: BoardColumn[];
  /**
   * Every label in the workspace, not only the ones currently on a card. The
   * filter bar and the drawer's selector both need the full roster, and a label
   * nobody has used yet is exactly the one you are about to apply.
   */
  labels: BoardLabel[];
  cards: BoardCard[];
  /**
   * Always present so the backlog rail can render beside a sprint board and
   * cards can be dragged between the two. Empty when the backlog itself is the
   * selected view, since then it is already rendered in the columns.
   */
  backlog: BoardCard[];
};

export type WorkspaceSummary = {
  id: number;
  name: string;
  slug: string;
  role: "owner" | "member";
};

export type CardComment = {
  id: number;
  body: string;
  created_at: string;
  author: Person | null;
};
