"use client";

import { useDroppable } from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { SortableCard } from "@/components/board/card-item";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { BoardCard } from "@/types/board";

export const BACKLOG_DROPPABLE_ID = "backlog";

export function BacklogRail({
  cards,
  collapsed,
  onToggle,
  onOpenCard,
}: {
  cards: BoardCard[];
  collapsed: boolean;
  onToggle: () => void;
  onOpenCard: (cardId: number) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: BACKLOG_DROPPABLE_ID,
    data: { type: "backlog" },
  });

  if (collapsed) {
    return (
      <aside className="flex flex-col items-center gap-2 border-r pr-3">
        <Button
          variant="ghost"
          size="icon"
          onClick={onToggle}
          aria-label="Show backlog"
        >
          <ChevronRight className="size-4" />
        </Button>
        <span className="text-muted-foreground [writing-mode:vertical-rl] text-xs">
          Backlog · {cards.length}
        </span>
      </aside>
    );
  }

  return (
    <aside className="flex min-h-0 w-64 shrink-0 flex-col gap-3 border-r pr-4">
      <header className="flex items-center justify-between px-1">
        <h3 className="text-sm font-medium">
          Backlog
          <span className="text-muted-foreground ml-1.5 text-xs tabular-nums">
            {cards.length}
          </span>
        </h3>
        <Button
          variant="ghost"
          size="icon"
          onClick={onToggle}
          aria-label="Hide backlog"
        >
          <ChevronLeft className="size-4" />
        </Button>
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
              Backlog is empty. Drag a card here to pull it out of the sprint.
            </li>
          ) : null}
        </ul>
      </SortableContext>
    </aside>
  );
}
