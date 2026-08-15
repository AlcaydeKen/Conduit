"use client";

import { useEffect, useMemo, useState } from "react";
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

import {
  BACKLOG_DROPPABLE_ID,
  BacklogRail,
} from "@/components/board/backlog-rail";
import { CardFace } from "@/components/board/card-item";
import { CardPanel } from "@/components/board/card-panel";
import { Column } from "@/components/board/column";
import { FilterBar } from "@/components/board/filter-bar";
import { SprintControls } from "@/components/board/sprint-controls";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { resolveDrop } from "@/lib/board-drop";
import {
  EMPTY_FILTERS,
  filterCards,
  visibleColumns,
  type CardFilters,
} from "@/lib/board-filters";
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
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [filters, setFilters] = useState<CardFilters>(EMPTY_FILTERS);
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

  // Filters are view state, not fetch state: they are deliberately absent from
  // `key` above and from the URL. A chip toggle must not refetch the board, and
  // must not call router.replace — that re-runs the page server component and
  // costs a database round-trip per click.
  const { data, mutate } = useSWR<BoardPayload>(key, fetcher, {
    refreshInterval: POLL_INTERVAL_MS,
    fallbackData: initialBoard,
    keepPreviousData: true,
    revalidateOnFocus: true,
  });

  const board = data ?? initialBoard;

  // Column ids and user ids are scoped to one workspace. Carrying a filter
  // across a switch would match nothing and read as an empty board.
  const workspaceId = board.workspace.id;
  useEffect(() => {
    setFilters(EMPTY_FILTERS);
  }, [workspaceId]);

  const groups = useMemo(() => groupByColumn(board), [board]);
  const viewingBacklog = board.selected_sprint === "backlog";
  const selectedSprint =
    board.sprints.find((sprint) => sprint.id === board.selected_sprint) ?? null;

  /**
   * Unfiltered on purpose. `handleDragEnd` resolves the moving card from here,
   * and `CardPanel` resolves the open card from here — a filtered list would
   * break a drag mid-flight and blank the panel of a card the user just hid.
   */
  const allCards = useMemo(
    () => [...board.cards, ...board.backlog],
    [board.cards, board.backlog],
  );
  const activeCard = activeId
    ? (allCards.find((card) => card.id === activeId) ?? null)
    : null;

  // Everything below is render-only derivation. Nothing in the move path reads it.
  const shownColumns = useMemo(
    () => visibleColumns(board.columns, filters),
    [board.columns, filters],
  );
  const shownGroups = useMemo(() => {
    const next = new Map<number, BoardCard[]>();
    for (const [columnId, list] of groups) {
      next.set(columnId, filterCards(list, filters));
    }
    return next;
  }, [groups, filters]);
  const shownBacklog = useMemo(
    () => filterCards(board.backlog, filters),
    [board.backlog, filters],
  );

  const totalCount = board.cards.length + board.backlog.length;
  const visibleCount =
    shownColumns.reduce(
      (sum, column) => sum + (shownGroups.get(column.id)?.length ?? 0),
      0,
    ) + (viewingBacklog ? 0 : shownBacklog.length);

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

  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    setActiveId(null);
    if (!over) return;

    const movingId = Number(active.id);
    const moving = allCards.find((card) => card.id === movingId);
    if (!moving) return;

    const overId = over.id;
    const overType = over.data.current?.type as string | undefined;

    const droppedOnBacklog =
      overId === BACKLOG_DROPPABLE_ID ||
      overType === "backlog" ||
      (typeof overId !== "string" &&
        board.backlog.some((card) => card.id === Number(overId)));

    // Where the card is going. The backlog is one flat list; a sprint board is
    // per column. Both are just destinations for the same move call.
    const targetColumnId = droppedOnBacklog
      ? moving.column_id
      : typeof overId === "string" && overId.startsWith("column:")
        ? Number(overId.slice("column:".length))
        : (over.data.current?.columnId as number | undefined);

    if (!targetColumnId) return;

    const targetSprintId = droppedOnBacklog
      ? null
      : viewingBacklog
        ? null
        : (board.selected_sprint as number);

    const wasInBacklog = moving.sprint_id === null;
    const sameList =
      wasInBacklog === droppedOnBacklog &&
      (droppedOnBacklog || moving.column_id === targetColumnId);

    // Both lists come from the unfiltered payload. A filter hides cards; it must
    // never hide a neighbour, or the server computes a key against the wrong
    // pair and the card lands inside the hidden run.
    const sourceList = wasInBacklog
      ? board.backlog
      : (groups.get(moving.column_id) ?? []);
    const fromIndex = sourceList.findIndex((card) => card.id === movingId);

    const fullTarget = (
      droppedOnBacklog ? board.backlog : (groups.get(targetColumnId) ?? [])
    ).filter((card) => card.id !== movingId);

    const overCardId = typeof overId === "string" ? null : Number(overId);
    const { index, prevId, nextId } = resolveDrop(fullTarget, overCardId);

    if (sameList && index === fromIndex) return;

    const movedCard: BoardCard = {
      ...moving,
      column_id: targetColumnId,
      sprint_id: targetSprintId,
    };
    const nextTarget = [...fullTarget];
    nextTarget.splice(index, 0, movedCard);

    const optimistic = buildOptimistic(
      board,
      movingId,
      movedCard,
      droppedOnBacklog,
      nextTarget,
      targetColumnId,
    );

    setError(null);
    try {
      await mutate(
        async () => {
          const response = await fetch(`/api/v1/cards/${movingId}/move`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              column_id: targetColumnId,
              sprint_id: targetSprintId,
              // Neighbours, not a position. The server owns key generation.
              prev_card_id: prevId,
              next_card_id: nextId,
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
          value={String(board.selected_sprint)}
          onValueChange={(value) => setParam("sprint", value)}
        >
          <SelectTrigger className="w-56" aria-label="Sprint">
            <SelectValue>
              {(value) => {
                if (String(value) === "backlog") return "Backlog";
                const sprint = board.sprints.find(
                  (item) => String(item.id) === String(value),
                );
                return sprint ? sprint.name : "Sprint";
              }}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {board.sprints.map((sprint) => (
              <SelectItem key={sprint.id} value={String(sprint.id)}>
                {sprint.name}
                {sprint.status === "active" ? " · active" : ""}
                {sprint.status === "completed" ? " · completed" : ""}
              </SelectItem>
            ))}
            <SelectItem value="backlog">Backlog</SelectItem>
          </SelectContent>
        </Select>

        {selectedSprint ? (
          <Badge
            variant="outline"
            className={
              selectedSprint.status === "active"
                ? "border-emerald-300 text-emerald-700 dark:border-emerald-800 dark:text-emerald-400"
                : undefined
            }
          >
            {selectedSprint.status}
          </Badge>
        ) : null}

        <SprintControls
          workspaceId={board.workspace.id}
          sprints={board.sprints}
          selected={selectedSprint}
          onChanged={(sprintId) => {
            // Creating a sprint jumps to it, which changes the SWR key and
            // refetches on its own. Starting or completing acts on the sprint
            // already in view, so there is nothing to navigate to — revalidate
            // instead. Doing both would fire a wasted request against the key
            // we are leaving.
            if (sprintId && String(sprintId) !== String(board.selected_sprint)) {
              setParam("sprint", String(sprintId));
            } else {
              void mutate();
            }
          }}
        />

        {error ? (
          <p className="text-destructive text-sm" role="status">
            {error}
          </p>
        ) : null}
      </div>

      <FilterBar
        columns={board.columns}
        cards={allCards}
        filters={filters}
        onChange={setFilters}
        visibleCount={visibleCount}
        totalCount={totalCount}
      />

      {selectedSprint?.goal ? (
        <p className="text-muted-foreground text-sm">{selectedSprint.goal}</p>
      ) : null}

      <DndContext
        // Pinned. dnd-kit's fallback id comes from a module-global counter that
        // keeps incrementing across renders — on the server it survives between
        // requests — so the `aria-describedby` it writes onto every card drifts
        // out of step with the client's and fails hydration. Pre-existing, and
        // only visible in dev, but a real mismatch either way.
        id="board"
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={(event: DragStartEvent) =>
          setActiveId(Number(event.active.id))
        }
        onDragEnd={handleDragEnd}
        onDragCancel={() => setActiveId(null)}
      >
        <div className="flex items-start gap-4">
          {viewingBacklog ? null : (
            <BacklogRail
              cards={shownBacklog}
              totalCount={board.backlog.length}
              collapsed={railCollapsed}
              onToggle={() => setRailCollapsed((value) => !value)}
              onOpenCard={setOpenCardId}
            />
          )}

          <div className="grid flex-1 items-start gap-4 md:grid-cols-2 xl:grid-cols-4">
            {shownColumns.map((column) => (
              <Column
                key={column.id}
                column={column}
                cards={shownGroups.get(column.id) ?? []}
                totalCount={groups.get(column.id)?.length ?? 0}
                onOpenCard={setOpenCardId}
              />
            ))}
          </div>
        </div>

        <DragOverlay>
          {activeCard ? <CardFace card={activeCard} dragging /> : null}
        </DragOverlay>
      </DndContext>

      <CardPanel
        cardId={openCardId}
        card={allCards.find((card) => card.id === openCardId) ?? null}
        onClose={() => setOpenCardId(null)}
      />
    </div>
  );
}

/**
 * Rebuilds the payload with the card in its new home so the drag lands
 * instantly. `position` is deliberately left stale — nothing renders from it,
 * the lists are drawn in array order, and the server's key arrives on
 * revalidation. The payload stays whole; the filter is applied downstream.
 */
function buildOptimistic(
  board: BoardPayload,
  movingId: number,
  movedCard: BoardCard,
  toBacklog: boolean,
  targetList: BoardCard[],
  targetColumnId: number,
): BoardPayload {
  const withoutMoved = (list: BoardCard[]) =>
    list.filter((card) => card.id !== movingId);

  if (toBacklog) {
    return {
      ...board,
      cards: withoutMoved(board.cards),
      backlog: targetList,
    };
  }

  const remaining = withoutMoved(board.cards).filter(
    (card) => card.column_id !== targetColumnId,
  );

  return {
    ...board,
    backlog: withoutMoved(board.backlog),
    cards: [...remaining, ...targetList].map((card) =>
      card.id === movingId ? movedCard : card,
    ),
  };
}
