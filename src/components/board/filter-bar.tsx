"use client";

import { PRIORITY_STYLES } from "@/components/board/card-item";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  collectAssignees,
  hasUnassigned,
  initialsOf,
  isFiltering,
  toggleFilter,
  PRIORITIES,
  UNASSIGNED,
  type CardFilters,
} from "@/lib/board-filters";
import { cn } from "@/lib/utils";
import type { BoardCard, BoardColumn } from "@/types/board";

/**
 * Chips rather than dropdowns. Nothing here opens a portal, so none of it can
 * be caught mid-teardown by the navigation transitions the board runs — the
 * hazard that `sprint-controls.tsx` needs `flushSync` for.
 */
function Chip({
  selected,
  onClick,
  className,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button type="button" onClick={onClick} aria-pressed={selected}>
      <Badge
        variant={selected ? "secondary" : "outline"}
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
  filters,
  onChange,
  visibleCount,
  totalCount,
}: {
  columns: BoardColumn[];
  /** Every card in view, board and backlog, unfiltered — this is the roster. */
  cards: BoardCard[];
  filters: CardFilters;
  onChange: (filters: CardFilters) => void;
  visibleCount: number;
  totalCount: number;
}) {
  const assignees = collectAssignees(cards);
  const showUnassigned = hasUnassigned(cards);
  const active = isFiltering(filters);

  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
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
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={() =>
              onChange({ columns: [], assignees: [], priorities: [] })
            }
          >
            Clear
          </Button>
        </div>
      ) : null}
    </div>
  );
}
