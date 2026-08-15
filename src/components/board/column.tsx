"use client";

import { useDroppable } from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { CardComposer } from "@/components/board/card-composer";
import { SortableCard } from "@/components/board/card-item";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { BoardCard, BoardColumn } from "@/types/board";

export const columnDroppableId = (columnId: number) => `column:${columnId}`;

export function Column({
  column,
  cards,
  totalCount,
  collapsed,
  onToggle,
  onOpenCard,
  onCreateCard,
}: {
  column: BoardColumn;
  /** Filtered — what is rendered. */
  cards: BoardCard[];
  /** Unfiltered. The WIP limit is a property of the column, not of the view. */
  totalCount: number;
  collapsed: boolean;
  onToggle: () => void;
  onOpenCard: (cardId: number) => void;
  onCreateCard: (columnId: number, title: string) => Promise<boolean>;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: columnDroppableId(column.id),
    data: { type: "column", columnId: column.id },
  });

  const filtering = cards.length !== totalCount;
  const overWip = column.wip_limit !== null && totalCount > column.wip_limit;
  const count = filtering ? `${cards.length} of ${totalCount}` : `${totalCount}`;

  if (collapsed) {
    return (
      /*
       * `setNodeRef` stays attached while collapsed, so a collapsed column is
       * still a drop target — collapse the columns you are not working in and
       * you can still throw a card into one.
       *
       * This deliberately diverges from `BacklogRail`, which drops the ref in
       * its collapsed branch and so cannot be dropped into. That is worth
       * reconciling later; the rail is one flat list where "somewhere in the
       * backlog" is less meaningful than "in that column".
       */
      <section
        ref={setNodeRef}
        className={cn(
          "flex w-11 flex-none flex-col items-center gap-2 rounded-lg border border-transparent py-2 transition-colors",
          isOver && "border-primary/40 bg-muted/60",
        )}
      >
        <Button
          variant="ghost"
          size="icon"
          onClick={onToggle}
          aria-label={`Expand ${column.name}`}
        >
          <ChevronRight className="size-4" />
        </Button>
        <span
          className={cn(
            "text-muted-foreground [writing-mode:vertical-rl] text-xs",
            overWip && "text-destructive font-medium",
          )}
        >
          {column.name} · {count}
        </span>
      </section>
    );
  }

  return (
    <section className="flex min-h-0 min-w-56 flex-1 basis-56 flex-col gap-3">
      <header className="flex items-center justify-between gap-1 px-1">
        <h3 className="truncate text-sm font-medium">{column.name}</h3>
        <div className="flex shrink-0 items-center gap-1">
          <span
            className={cn(
              "text-muted-foreground text-xs tabular-nums",
              overWip && "text-destructive font-medium",
            )}
          >
            {count}
            {column.wip_limit !== null ? ` / ${column.wip_limit}` : ""}
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            onClick={onToggle}
            aria-label={`Collapse ${column.name}`}
          >
            <ChevronLeft className="size-3.5" />
          </Button>
        </div>
      </header>

      <SortableContext
        items={cards.map((card) => card.id)}
        strategy={verticalListSortingStrategy}
      >
        <ul
          ref={setNodeRef}
          className={cn(
            "bg-muted/30 min-h-32 flex-1 space-y-2 rounded-lg border border-transparent p-2 transition-colors",
            isOver && "border-primary/40 bg-muted/60",
          )}
        >
          {cards.map((card) => (
            <SortableCard key={card.id} card={card} onOpen={onOpenCard} />
          ))}
          {cards.length === 0 ? (
            <li className="text-muted-foreground/60 px-2 py-6 text-center text-xs">
              {/* A column emptied by a filter is not an empty column, and must
                  not read as an invitation to drop into something whose real
                  contents are hidden. */}
              {totalCount > 0 ? "No cards match" : "Drop cards here"}
            </li>
          ) : null}
        </ul>
      </SortableContext>

      {/* Outside the SortableContext list on purpose — inside it, the composer
          would be measured as a sortable sibling and a drop could target it. */}
      <CardComposer
        label={column.name}
        onCreate={(title) => onCreateCard(column.id, title)}
      />
    </section>
  );
}
