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
  labels: number[];
  /** Free text over title and description. Empty means no constraint. */
  query: string;
};

export const EMPTY_FILTERS: CardFilters = {
  columns: [],
  assignees: [],
  priorities: [],
  labels: [],
  query: "",
};

export const PRIORITIES: Priority[] = ["low", "medium", "high", "urgent"];

export function isFiltering(filters: CardFilters): boolean {
  return (
    filters.columns.length > 0 ||
    filters.assignees.length > 0 ||
    filters.priorities.length > 0 ||
    filters.labels.length > 0 ||
    filters.query.trim().length > 0
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

  /*
   * OR within the dimension, like the others: a card matches if it carries any
   * of the selected labels, not all of them.
   *
   * "All of them" is the other reasonable reading, and it is the wrong default
   * here — selecting two labels to see both kinds of work is the common case,
   * and intersection would usually return nothing on a board this size.
   */
  if (filters.labels.length > 0) {
    const hit = card.labels.some((label) => filters.labels.includes(label.id));
    if (!hit) return false;
  }

  /*
   * Substring, case-insensitive, over title and description — the same two
   * fields `GET /api/v1/cards?q=` searches, so the board and the machine API
   * cannot answer "does this card match" differently.
   *
   * Client-side on purpose. This runs over the payload already in memory, so it
   * needs no request and, more importantly, it stays a render-time derivation
   * like every other filter here. A server-backed search would return a
   * *different list of cards*, and a move computed against that list would send
   * neighbour ids that are not neighbours.
   */
  const query = filters.query.trim().toLowerCase();
  if (query.length > 0) {
    const haystack = `${card.title}\n${card.description ?? ""}`.toLowerCase();
    if (!haystack.includes(query)) return false;
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
 * No longer what the filter bar renders — it lists the whole roster from
 * `GET /api/v1/members`. An earlier comment here argued the opposite, that
 * offering someone with no cards "would only ever produce an empty board". That
 * was wrong: filtering to a colleague and seeing nothing is how you learn they
 * have nothing assigned, which is a question people actually ask. A roster that
 * changes shape depending on who happens to hold a card is also a moving target
 * to aim at.
 *
 * Kept because it is still the right answer when there is no roster to hand.
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
