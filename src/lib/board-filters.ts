/**
 * Card filtering, kept free of React so the verification script can import it
 * directly — the same reason `src/types/board.ts` holds no database import.
 *
 * Filtering is a render-time derivation and nothing more. The full board payload
 * stays intact in memory, because a drop has to be resolved against the real
 * neighbours rather than the visible ones. See `src/lib/board-drop.ts`.
 */
import type {
  BoardCard,
  BoardColumn,
  Person,
  Priority,
} from "@/types/board";

/** Sentinel for cards with no assignee, which has no user id to select by. */
export const UNASSIGNED = "unassigned" as const;

export type AssigneeFilter = string | typeof UNASSIGNED;

/** An empty array means "no constraint", not "match nothing". */
export type CardFilters = {
  columns: number[];
  assignees: AssigneeFilter[];
  priorities: Priority[];
};

export const EMPTY_FILTERS: CardFilters = {
  columns: [],
  assignees: [],
  priorities: [],
};

export const PRIORITIES: Priority[] = ["low", "medium", "high", "urgent"];

export function isFiltering(filters: CardFilters): boolean {
  return (
    filters.columns.length > 0 ||
    filters.assignees.length > 0 ||
    filters.priorities.length > 0
  );
}

/** Adds or removes one value, leaving the other dimensions alone. */
export function toggleFilter<T>(values: T[], value: T): T[] {
  return values.includes(value)
    ? values.filter((item) => item !== value)
    : [...values, value];
}

/**
 * OR within a dimension, AND across dimensions.
 *
 * The column dimension is deliberately absent: on a board, hiding a column and
 * hiding the cards inside it are the same act, and it is the column that has to
 * disappear — a visible column emptied by a filter reads as somewhere you can
 * drop, which is exactly what it is not. See `visibleColumns`.
 */
export function matchesCard(card: BoardCard, filters: CardFilters): boolean {
  if (
    filters.priorities.length > 0 &&
    !filters.priorities.includes(card.priority)
  ) {
    return false;
  }

  if (filters.assignees.length > 0) {
    const key = card.assignee ? card.assignee.id : UNASSIGNED;
    if (!filters.assignees.includes(key)) return false;
  }

  return true;
}

export function filterCards(
  cards: BoardCard[],
  filters: CardFilters,
): BoardCard[] {
  if (!isFiltering(filters)) return cards;
  return cards.filter((card) => matchesCard(card, filters));
}

/** Column visibility. Order is preserved; the caller already sorted it. */
export function visibleColumns(
  columns: BoardColumn[],
  filters: CardFilters,
): BoardColumn[] {
  if (filters.columns.length === 0) return columns;
  return columns.filter((column) => filters.columns.includes(column.id));
}

/**
 * The assignees actually present on the board, deduped and sorted by name.
 *
 * There is no endpoint that lists the members of a workspace — `listWorkspaces`
 * is the inverse relation — so the roster is derived from the cards on hand.
 * Nothing is lost: filtering by a member who holds no cards hides nothing.
 */
export function collectAssignees(cards: BoardCard[]): Person[] {
  const seen = new Map<string, Person>();
  for (const card of cards) {
    if (card.assignee && !seen.has(card.assignee.id)) {
      seen.set(card.assignee.id, card.assignee);
    }
  }
  return [...seen.values()].sort((a, b) =>
    (a.name ?? "").localeCompare(b.name ?? ""),
  );
}

export function hasUnassigned(cards: BoardCard[]): boolean {
  return cards.some((card) => card.assignee === null);
}

/** Shared by the card face and the assignee chips so they never disagree. */
export function initialsOf(name: string | null): string {
  return (name ?? "?")
    .split(" ")
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}
