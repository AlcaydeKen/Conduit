"use client";

import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { MessageSquare } from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { BoardCard, Priority } from "@/types/board";

const PRIORITY_STYLES: Record<Priority, string> = {
  low: "border-slate-300 text-slate-600 dark:border-slate-700 dark:text-slate-400",
  medium: "border-sky-300 text-sky-700 dark:border-sky-800 dark:text-sky-400",
  high: "border-amber-300 text-amber-700 dark:border-amber-800 dark:text-amber-400",
  urgent: "border-red-300 text-red-700 dark:border-red-800 dark:text-red-400",
};

export function CardFace({
  card,
  dragging = false,
  className,
}: {
  card: BoardCard;
  dragging?: boolean;
  className?: string;
}) {
  const initials = (card.assignee?.name ?? "?")
    .split(" ")
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  return (
    <div
      className={cn(
        "bg-background space-y-2 rounded-md border p-3 text-left shadow-xs",
        dragging && "ring-primary/40 rotate-1 shadow-lg ring-2",
        className,
      )}
    >
      {card.labels.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {card.labels.map((label) => (
            <span
              key={label.id}
              className="rounded-full px-1.5 py-0.5 text-[10px] font-medium text-white"
              style={{ backgroundColor: label.color }}
            >
              {label.name}
            </span>
          ))}
        </div>
      ) : null}

      <p className="text-sm leading-snug font-medium">{card.title}</p>

      <div className="text-muted-foreground flex items-center gap-2 text-xs">
        <span className="tabular-nums">#{card.id}</span>
        <Badge
          variant="outline"
          className={cn("px-1.5 py-0 text-[10px]", PRIORITY_STYLES[card.priority])}
        >
          {card.priority}
        </Badge>
        {card.points !== null ? (
          <span className="tabular-nums">{card.points} pts</span>
        ) : null}
        {card.comment_count > 0 ? (
          <span className="inline-flex items-center gap-1 tabular-nums">
            <MessageSquare className="size-3" />
            {card.comment_count}
          </span>
        ) : null}
        <span className="ml-auto">
          {card.assignee ? (
            <Avatar className="size-5">
              {card.assignee.image ? (
                <AvatarImage src={card.assignee.image} alt="" />
              ) : null}
              <AvatarFallback className="text-[9px]">{initials}</AvatarFallback>
            </Avatar>
          ) : null}
        </span>
      </div>
    </div>
  );
}

export function SortableCard({
  card,
  onOpen,
}: {
  card: BoardCard;
  onOpen: (cardId: number) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: card.id, data: { type: "card", columnId: card.column_id } });

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn("touch-none", isDragging && "opacity-40")}
      {...attributes}
      {...listeners}
      onClick={() => onOpen(card.id)}
    >
      <CardFace card={card} className="cursor-grab active:cursor-grabbing" />
    </li>
  );
}
