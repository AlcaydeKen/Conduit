"use client";

import { useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCorners,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import useSWR from "swr";

import { CardFace } from "@/components/board/card-item";
import { CardPanel } from "@/components/board/card-panel";
import { Column } from "@/components/board/column";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type {
  BoardCard,
  BoardPayload,
  WorkspaceSummary,
} from "@/types/board";

const POLL_INTERVAL_MS = 5_000;

const fetcher = async (url: string): Promise<BoardPayload> => {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`board_fetch_failed_${response.status}`);
  return response.json();
};

/** Cards arrive already sorted by `position ASC, id ASC`; keep that order. */
function groupByColumn(payload: BoardPayload) {
  const groups = new Map<number, BoardCard[]>();
  for (const column of payload.columns) groups.set(column.id, []);
  for (const card of payload.cards) {
    const list = groups.get(card.column_id);
    if (list) list.push(card);
  }
  return groups;
}

function flatten(payload: BoardPayload, groups: Map<number, BoardCard[]>) {
  return payload.columns.flatMap((column) => groups.get(column.id) ?? []);
}

export function Board({
  initialBoard,
  workspaces,
}: {
  initialBoard: BoardPayload;
  workspaces: WorkspaceSummary[];
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [activeId, setActiveId] = useState<number | null>(null);
  const [openCardId, setOpenCardId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const workspaceParam = searchParams.get("workspace");
  const sprintParam = searchParams.get("sprint");

  const key = useMemo(() => {
    const params = new URLSearchParams();
    if (workspaceParam) params.set("workspace", workspaceParam);
    if (sprintParam) params.set("sprint", sprintParam);
    const query = params.toString();
    return query ? `/api/v1/board?${query}` : "/api/v1/board";
  }, [workspaceParam, sprintParam]);

  const { data, mutate } = useSWR<BoardPayload>(key, fetcher, {
    refreshInterval: POLL_INTERVAL_MS,
    fallbackData: initialBoard,
    keepPreviousData: true,
    revalidateOnFocus: true,
  });

  const board = data ?? initialBoard;
  const groups = useMemo(() => groupByColumn(board), [board]);
  const activeCard = activeId
    ? (board.cards.find((card) => card.id === activeId) ?? null)
    : null;

  const sensors = useSensors(
    // A small threshold so a plain click still opens the detail panel instead
    // of being swallowed as a drag.
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

  function setParam(name: string, value: string | null) {
    if (!value) return;
    const params = new URLSearchParams(searchParams.toString());
    params.set(name, value);
    if (name === "workspace") params.delete("sprint");
    router.replace(`/?${params.toString()}`, { scroll: false });
  }

  function handleDragStart(event: DragStartEvent) {
    setActiveId(Number(event.active.id));
  }

  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    setActiveId(null);
    if (!over) return;

    const movingId = Number(active.id);
    const moving = board.cards.find((card) => card.id === movingId);
    if (!moving) return;

    const overId = over.id;
    const targetColumnId =
      typeof overId === "string" && overId.startsWith("column:")
        ? Number(overId.slice("column:".length))
        : (over.data.current?.columnId as number | undefined);

    if (!targetColumnId) return;

    const next = new Map(groups);
    const source = [...(next.get(moving.column_id) ?? [])];
    const fromIndex = source.findIndex((card) => card.id === movingId);
    if (fromIndex >= 0) source.splice(fromIndex, 1);
    next.set(moving.column_id, source);

    const target =
      moving.column_id === targetColumnId
        ? source
        : [...(next.get(targetColumnId) ?? [])];

    let toIndex = target.length;
    if (typeof overId !== "string") {
      const overIndex = target.findIndex((card) => card.id === Number(overId));
      if (overIndex >= 0) toIndex = overIndex;
    }

    const movedCard: BoardCard = { ...moving, column_id: targetColumnId };
    target.splice(toIndex, 0, movedCard);
    next.set(targetColumnId, target);

    // Neighbours, not a position. The server owns key generation.
    const prevCard = target[toIndex - 1] ?? null;
    const nextCard = target[toIndex + 1] ?? null;

    // Dropped back where it started — nothing to persist.
    if (moving.column_id === targetColumnId && toIndex === fromIndex) return;

    const optimistic: BoardPayload = {
      ...board,
      cards: flatten(board, next),
    };

    setError(null);
    try {
      await mutate(
        async () => {
          const response = await fetch(`/api/v1/cards/${movingId}/move`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              column_id: targetColumnId,
              prev_card_id: prevCard?.id ?? null,
              next_card_id: nextCard?.id ?? null,
            }),
          });
          if (!response.ok) throw new Error(`move_failed_${response.status}`);
          return fetcher(key);
        },
        {
          optimisticData: optimistic,
          rollbackOnError: true,
          revalidate: false,
          populateCache: true,
        },
      );
    } catch {
      setError("Move failed — the card snapped back.");
    }
  }

  const selectedSprint = String(board.selected_sprint);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Select
          value={String(board.workspace.id)}
          onValueChange={(value) => setParam("workspace", value)}
        >
          <SelectTrigger className="w-52" aria-label="Workspace">
            {/* base-ui renders the raw value unless given a label resolver */}
            <SelectValue>
              {(value) =>
                workspaces.find((item) => String(item.id) === String(value))
                  ?.name ?? board.workspace.name
              }
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {workspaces.map((workspace) => (
              <SelectItem key={workspace.id} value={String(workspace.id)}>
                {workspace.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={selectedSprint}
          onValueChange={(value) => setParam("sprint", value)}
        >
          <SelectTrigger className="w-56" aria-label="Sprint">
            <SelectValue>
              {(value) => {
                if (String(value) === "backlog") return "Backlog";
                const sprint = board.sprints.find(
                  (item) => String(item.id) === String(value),
                );
                if (!sprint) return "Sprint";
                return sprint.status === "active"
                  ? `${sprint.name} · active`
                  : sprint.name;
              }}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {board.sprints.map((sprint) => (
              <SelectItem key={sprint.id} value={String(sprint.id)}>
                {sprint.name}
                {sprint.status === "active" ? " · active" : ""}
              </SelectItem>
            ))}
            <SelectItem value="backlog">Backlog</SelectItem>
          </SelectContent>
        </Select>

        {error ? (
          <p className="text-destructive text-sm" role="status">
            {error}
          </p>
        ) : null}
      </div>

      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={() => setActiveId(null)}
      >
        <div className="grid items-start gap-4 md:grid-cols-2 xl:grid-cols-4">
          {board.columns.map((column) => (
            <Column
              key={column.id}
              column={column}
              cards={groups.get(column.id) ?? []}
              onOpenCard={setOpenCardId}
            />
          ))}
        </div>

        <DragOverlay>
          {activeCard ? <CardFace card={activeCard} dragging /> : null}
        </DragOverlay>
      </DndContext>

      <CardPanel
        cardId={openCardId}
        card={board.cards.find((card) => card.id === openCardId) ?? null}
        onClose={() => setOpenCardId(null)}
      />
    </div>
  );
}
