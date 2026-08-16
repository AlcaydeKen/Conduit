"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  defaultDropAnimationSideEffects,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
  type DropAnimation,
} from "@dnd-kit/core";
import { restrictToWindowEdges } from "@dnd-kit/modifiers";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
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
  Person,
  WorkspaceSummary,
} from "@/types/board";

const POLL_INTERVAL_MS = 5_000;

/**
 * The source card fades to 40% while dragging (`card-item.tsx`). Without this
 * the overlay snaps back to full opacity at the instant it lands, one frame
 * before the real card finishes fading in — a flicker that reads as the drop
 * having failed.
 */
const DROP_ANIMATION: DropAnimation = {
  sideEffects: defaultDropAnimationSideEffects({
    styles: { active: { opacity: "0.4" } },
  }),
};

const fetcher = async (url: string): Promise<BoardPayload> => {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`board_fetch_failed_${response.status}`);
  return response.json();
};

const membersFetcher = async (url: string): Promise<{ members: Person[] }> => {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`members_fetch_failed_${response.status}`);
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
  const [collapsedColumns, setCollapsedColumns] = useState<Set<number>>(
    () => new Set(),
  );
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

  /*
   * The roster, for the assignee chips. Deliberately not on `refreshInterval`:
   * membership changes are a hand-written SQL statement in this system (see
   * `resolveKeyActor`), so polling it every five seconds would spend a request
   * per tick on a list that changes about once a quarter.
   */
  const { data: memberData } = useSWR(
    `/api/v1/members?workspace=${board.workspace.id}`,
    membersFetcher,
    { revalidateOnFocus: false },
  );

  // Column ids and user ids are scoped to one workspace. Carrying a filter
  // across a switch would match nothing and read as an empty board, and a
  // carried-over collapsed set would fold whichever columns happened to share
  // an id with the ones collapsed in the workspace we left.
  const workspaceId = board.workspace.id;
  useEffect(() => {
    setFilters(EMPTY_FILTERS);
    setCollapsedColumns(new Set());
  }, [workspaceId]);

  function toggleColumn(columnId: number) {
    setCollapsedColumns((current) => {
      const next = new Set(current);
      if (!next.delete(columnId)) next.add(columnId);
      return next;
    });
  }

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

  /**
   * dnd-kit's default announcements name things by id — "Draggable item 3 was
   * moved over droppable area column:2" — which is exactly the information a
   * screen reader user does not have. These say the card's title and the
   * column's name instead.
   *
   * The hidden elements these feed were always mounting; a period of stale dev
   * bundles made it look otherwise. There is deliberately no hand-rendered
   * `<div id="board">` here: dnd-kit renders its own with that id, and a second
   * would be a duplicate id pointing the same `aria-describedby` at two nodes.
   */
  const announcements = useMemo(() => {
    const titleOf = (id: string | number) =>
      allCards.find((card) => String(card.id) === String(id))?.title ??
      `card ${id}`;

    const destinationOf = (id: string | number | undefined) => {
      if (id === undefined) return null;
      const raw = String(id);
      if (raw === BACKLOG_DROPPABLE_ID) return "the backlog";
      const columnId = raw.startsWith("column:")
        ? Number(raw.slice("column:".length))
        : allCards.find((card) => String(card.id) === raw)?.column_id;
      const column = board.columns.find((item) => item.id === columnId);
      return column ? column.name : null;
    };

    return {
      onDragStart({ active }: { active: { id: string | number } }) {
        return `Picked up ${titleOf(active.id)}.`;
      },
      onDragOver({
        active,
        over,
      }: {
        active: { id: string | number };
        over: { id: string | number } | null;
      }) {
        const where = destinationOf(over?.id);
        return where
          ? `${titleOf(active.id)} is over ${where}.`
          : `${titleOf(active.id)} is not over a drop target.`;
      },
      onDragEnd({
        active,
        over,
      }: {
        active: { id: string | number };
        over: { id: string | number } | null;
      }) {
        const where = destinationOf(over?.id);
        return where
          ? `${titleOf(active.id)} was dropped into ${where}.`
          : `${titleOf(active.id)} was dropped where it started.`;
      },
      onDragCancel({ active }: { active: { id: string | number } }) {
        return `Cancelled. ${titleOf(active.id)} stayed where it was.`;
      },
    };
  }, [allCards, board.columns]);

  const sensors = useSensors(
    // A small threshold so a plain click still opens the detail panel instead
    // of being swallowed as a drag.
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    /*
     * Space picks a card up, arrows move it, space drops it, escape cancels —
     * and the announcements above finally have someone who can act on them.
     * Until now they described a drag to a screen-reader user who had no way to
     * begin one.
     *
     * Empty columns are reachable, which is worth stating because the obvious
     * assumption is that they are not. `sortableKeyboardCoordinates` walks
     * `droppableContainers.getEnabled()` — every registered droppable, not the
     * sortable items — and each column registers one on its list element. So
     * the keyboard path covers the same targets the pointer does, including a
     * column holding nothing and a collapsed column's strip.
     *
     * Confirmed in a browser, then confirmed against the implementation, in
     * that order: the first note here claimed the opposite from reasoning alone.
     */
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function setParam(name: string, value: string | null) {
    if (!value) return;
    const params = new URLSearchParams(searchParams.toString());
    params.set(name, value);
    if (name === "workspace") params.delete("sprint");
    router.replace(`/?${params.toString()}`, { scroll: false });
  }

  /**
   * Creates a card at the end of one scope.
   *
   * No `position` is sent and no optimistic insert is made. The create route
   * owns key generation exactly as the move route does — `readOrder` then
   * `generateKeyBetween(last, null)` — so there is no key the client could
   * guess, and a placeholder card holding a fabricated one would have to be
   * reconciled against the real one a moment later.
   *
   * `sprintId` null means the backlog. When the backlog itself is the selected
   * view, a column composer is also creating a backlog card, which is why this
   * reads `selected_sprint` rather than assuming a sprint is in view.
   */
  async function createCard(
    columnId: number,
    sprintId: number | null,
    title: string,
  ): Promise<boolean> {
    setError(null);
    try {
      const response = await fetch("/api/v1/cards", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          column_id: columnId,
          sprint_id: sprintId,
          title,
        }),
      });
      if (!response.ok) throw new Error(`create_failed_${response.status}`);
      await mutate();
      return true;
    } catch {
      setError("Could not add that card.");
      return false;
    }
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
        labels={board.labels}
        members={memberData?.members ?? null}
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
        accessibility={{ announcements }}
        sensors={sensors}
        // Keeps the overlay inside the viewport. Without it a card dragged past
        // the edge scrolls the page under the pointer and the drop lands
        // somewhere the user was no longer looking.
        modifiers={[restrictToWindowEdges]}
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
              /* The rail is one flat list, but `cards.column_id` is NOT NULL —
                 a backlog card still has to sit in some column for when it is
                 pulled into a sprint. The first column is the honest default:
                 it is the leftmost, which is where unstarted work belongs. */
              onCreateCard={(title) =>
                board.columns[0]
                  ? createCard(board.columns[0].id, null, title)
                  : Promise.resolve(false)
              }
            />
          )}

          {/* Flex rather than a fixed grid: in `grid-cols-4` a collapsed column
              still occupies a full track, so collapsing would reclaim nothing.
              Here an expanded column takes an equal share of what is left and a
              collapsed one takes 44px. */}
          <div className="flex flex-1 flex-wrap items-start gap-4">
            {shownColumns.map((column) => (
              <Column
                key={column.id}
                column={column}
                cards={shownGroups.get(column.id) ?? []}
                totalCount={groups.get(column.id)?.length ?? 0}
                collapsed={collapsedColumns.has(column.id)}
                onToggle={() => toggleColumn(column.id)}
                onOpenCard={setOpenCardId}
                onCreateCard={(columnId, title) =>
                  createCard(
                    columnId,
                    // Creating while the backlog is in view creates in the
                    // backlog, not in a sprint that is not on screen.
                    viewingBacklog ? null : (board.selected_sprint as number),
                    title,
                  )
                }
              />
            ))}
          </div>
        </div>

        <DragOverlay dropAnimation={DROP_ANIMATION}>
          {activeCard ? <CardFace card={activeCard} dragging /> : null}
        </DragOverlay>
      </DndContext>

      <CardPanel
        cardId={openCardId}
        card={allCards.find((card) => card.id === openCardId) ?? null}
        workspaceId={board.workspace.id}
        labels={board.labels}
        onClose={() => setOpenCardId(null)}
        onCardChanged={() => void mutate()}
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
