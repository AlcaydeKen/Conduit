"use client";

import { useDroppable } from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";

import { SortableCard } from "@/components/board/card-item";
import { cn } from "@/lib/utils";
import type { BoardCard, BoardColumn } from "@/types/board";

export const columnDroppableId = (columnId: number) => `column:${columnId}`;

export function Column({
  column,
  cards,
  onOpenCard,
}: {
  column: BoardColumn;
  cards: BoardCard[];
  onOpenCard: (cardId: number) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: columnDroppableId(column.id),
    data: { type: "column", columnId: column.id },
  });

  const overWip = column.wip_limit !== null && cards.length > column.wip_limit;

  return (
    <section className="flex min-h-0 flex-col gap-3">
      <header className="flex items-baseline justify-between px-1">
        <h3 className="text-sm font-medium">{column.name}</h3>
        <span
          className={cn(
            "text-muted-foreground text-xs tabular-nums",
            overWip && "text-destructive font-medium",
          )}
        >
          {cards.length}
          {column.wip_limit !== null ? ` / ${column.wip_limit}` : ""}
        </span>
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
              Drop cards here
            </li>
          ) : null}
        </ul>
      </SortableContext>
    </section>
  );
}
