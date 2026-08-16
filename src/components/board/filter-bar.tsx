"use client";

import { PRIORITY_STYLES } from "@/components/board/card-item";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  collectAssignees,
  hasUnassigned,
  initialsOf,
  isFiltering,
  toggleFilter,
  EMPTY_FILTERS,
  PRIORITIES,
  UNASSIGNED,
  type CardFilters,
} from "@/lib/board-filters";
import { cn } from "@/lib/utils";
import type {
  BoardCard,
  BoardColumn,
  BoardLabel,
  Person,
} from "@/types/board";

/**
 * Chips rather than dropdowns. Nothing here opens a portal, so none of it can
 * be caught mid-teardown by the navigation transitions the board runs — the
 * hazard that `sprint-controls.tsx` needs `flushSync` for.
 */
function Chip({
  selected,
  onClick,
  className,
  style,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  className?: string;
  style?: React.CSSProperties;
  children: React.ReactNode;
}) {
  return (
    <button type="button" onClick={onClick} aria-pressed={selected}>
      <Badge
        variant={selected ? "secondary" : "outline"}
        style={style}
        className={cn(
          "cursor-pointer gap-1 px-2 py-0.5 text-xs font-normal transition-colors",
          !selected && "text-muted-foreground hover:text-foreground",
          className,
        )}
      >
        {children}
      </Badge>
    </button>
  );
}

function Group({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-muted-foreground w-14 shrink-0 text-xs">
        {label}
      </span>
      <div className="flex flex-wrap items-center gap-1">{children}</div>
    </div>
  );
}

export function FilterBar({
  columns,
  cards,
  labels,
  members,
  filters,
  onChange,
  visibleCount,
  totalCount,
}: {
  columns: BoardColumn[];
  /** Every card in view, board and backlog, unfiltered. */
  cards: BoardCard[];
  /** Every label in the workspace, from the board payload. */
  labels: BoardLabel[];
  /**
   * The workspace roster. Null while it loads — the chips fall back to the
   * people holding cards rather than flashing an empty Assignee group, since a
   * row that appears a moment later is worse than one that starts small.
   */
  members: Person[] | null;
  filters: CardFilters;
  onChange: (filters: CardFilters) => void;
  visibleCount: number;
  totalCount: number;
}) {
  // The whole roster, not just people with cards: filtering to a colleague and
  // seeing nothing is how you find out they have nothing assigned.
  const assignees = members ?? collectAssignees(cards);
  // "Unassigned" is offered whenever there is a card without an owner. It is a
  // property of the board, not of the roster, so it does not come from members.
  const showUnassigned = hasUnassigned(cards);
  const active = isFiltering(filters);

  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
      {/* No debounce: this filters an array already in memory, so there is no
          request to throttle and every keystroke is a re-render the board does
          anyway. `type="search"` gives the native clear affordance for free. */}
      <Input
        type="search"
        value={filters.query}
        onChange={(event) =>
          onChange({ ...filters, query: event.target.value })
        }
        placeholder="Search cards…"
        aria-label="Search cards by title or description"
        className="h-8 w-56"
      />

      <Group label="Priority">
        {PRIORITIES.map((priority) => {
          const selected = filters.priorities.includes(priority);
          return (
            <Chip
              key={priority}
              selected={selected}
              onClick={() =>
                onChange({
                  ...filters,
                  priorities: toggleFilter(filters.priorities, priority),
                })
              }
              className={selected ? undefined : PRIORITY_STYLES[priority]}
            >
              {priority}
            </Chip>
          );
        })}
      </Group>

      <Group label="Column">
        {columns.map((column) => (
          <Chip
            key={column.id}
            selected={filters.columns.includes(column.id)}
            onClick={() =>
              onChange({
                ...filters,
                columns: toggleFilter(filters.columns, column.id),
              })
            }
          >
            {column.name}
          </Chip>
        ))}
      </Group>

      {labels.length > 0 ? (
        <Group label="Label">
          {labels.map((label) => {
            const selected = filters.labels.includes(label.id);
            return (
              <Chip
                key={label.id}
                selected={selected}
                onClick={() =>
                  onChange({
                    ...filters,
                    labels: toggleFilter(filters.labels, label.id),
                  })
                }
                // The label's own colour when selected, so the chip and the
                // card face agree about what was picked. Outline when not, or
                // every label would read as active.
                className={selected ? "border-transparent text-white" : undefined}
                style={
                  selected ? { backgroundColor: label.color } : undefined
                }
              >
                {label.name}
              </Chip>
            );
          })}
        </Group>
      ) : null}

      {assignees.length > 0 || showUnassigned ? (
        <Group label="Assignee">
          {assignees.map((person) => (
            <Chip
              key={person.id}
              selected={filters.assignees.includes(person.id)}
              onClick={() =>
                onChange({
                  ...filters,
                  assignees: toggleFilter(filters.assignees, person.id),
                })
              }
            >
              <Avatar className="size-4">
                {person.image ? <AvatarImage src={person.image} alt="" /> : null}
                <AvatarFallback className="text-[8px]">
                  {initialsOf(person.name)}
                </AvatarFallback>
              </Avatar>
              {person.name ?? "Unnamed"}
            </Chip>
          ))}
          {showUnassigned ? (
            <Chip
              selected={filters.assignees.includes(UNASSIGNED)}
              onClick={() =>
                onChange({
                  ...filters,
                  assignees: toggleFilter(filters.assignees, UNASSIGNED),
                })
              }
            >
              Unassigned
            </Chip>
          ) : null}
        </Group>
      ) : null}

      {active ? (
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground text-xs tabular-nums">
            showing {visibleCount} of {totalCount}
          </span>
          {/* EMPTY_FILTERS rather than a literal: a hand-written object here
              would silently stop clearing whichever dimension gets added next,
              and "Clear" leaving a filter on is the kind of bug nobody reports
              because they assume they mistyped. */}
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={() => onChange(EMPTY_FILTERS)}
          >
            Clear
          </Button>
        </div>
      ) : null}
    </div>
  );
}
