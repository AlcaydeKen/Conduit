/**
 * Exercises card filtering and, more importantly, drop resolution under a
 * filter.
 *
 * Run: pnpm verify:filters
 *
 * Pure functions only — no dev server, no database. The point of the file is
 * check 5: with cards hidden, a drop between two *visible* cards must resolve
 * to the neighbours in the full list, not the visible ones. Nothing on the
 * server would catch the alternative. `move/route.ts` validates only that both
 * neighbours exist and sit in the destination scope, and `computePosition`
 * only refuses when `prev >= next`, so a far-apart pair is accepted and the
 * card silently lands somewhere inside the hidden run.
 */
import { generateKeyBetween } from "fractional-indexing";

import { resolveDrop } from "@/lib/board-drop";
import {
  EMPTY_FILTERS,
  UNASSIGNED,
  collectAssignees,
  filterCards,
  hasUnassigned,
  isFiltering,
  matchesCard,
  toggleFilter,
  visibleColumns,
  type CardFilters,
} from "@/lib/board-filters";
import type { BoardCard, BoardColumn, Person, Priority } from "@/types/board";

let failures = 0;

function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) {
    console.log(`  PASS  ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${label}`, detail ?? "");
  }
}

const ana: Person = { id: "u-ana", name: "Ana Diaz", image: null };
const bo: Person = { id: "u-bo", name: "Bo Chen", image: null };

function card(
  id: number,
  options: {
    position?: string;
    columnId?: number;
    priority?: Priority;
    assignee?: Person | null;
  } = {},
): BoardCard {
  return {
    id,
    title: `Card ${id}`,
    description: null,
    column_id: options.columnId ?? 1,
    sprint_id: 1,
    priority: options.priority ?? "medium",
    points: null,
    position: options.position ?? `a${id}`,
    assignee: options.assignee ?? null,
    labels: [],
    comment_count: 0,
  };
}

const filters = (overrides: Partial<CardFilters> = {}): CardFilters => ({
  ...EMPTY_FILTERS,
  ...overrides,
});

function main() {
  console.log("1. an empty filter is not a filter");
  const sample = [
    card(1, { priority: "low", assignee: ana }),
    card(2, { priority: "urgent", assignee: null }),
    card(3, { priority: "high", assignee: bo }),
  ];
  check("isFiltering is false", !isFiltering(EMPTY_FILTERS));
  check(
    "every card matches",
    sample.every((item) => matchesCard(item, EMPTY_FILTERS)),
  );
  check(
    "filterCards returns the same array reference",
    filterCards(sample, EMPTY_FILTERS) === sample,
  );

  console.log("\n2. OR within a dimension, AND across dimensions");
  const byPriority = filters({ priorities: ["low", "urgent"] });
  check(
    "two priorities match either",
    filterCards(sample, byPriority).map((item) => item.id).join(",") === "1,2",
    filterCards(sample, byPriority).map((item) => item.id),
  );
  check(
    "unassigned sentinel matches a null assignee only",
    filterCards(sample, filters({ assignees: [UNASSIGNED] }))
      .map((item) => item.id)
      .join(",") === "2",
  );
  check(
    "a user id matches that user only",
    filterCards(sample, filters({ assignees: [bo.id] }))
      .map((item) => item.id)
      .join(",") === "3",
  );
  check(
    "priority AND assignee intersect",
    filterCards(
      sample,
      filters({ priorities: ["low", "urgent"], assignees: [ana.id] }),
    )
      .map((item) => item.id)
      .join(",") === "1",
  );
  check(
    "a filter that intersects to nothing hides everything",
    filterCards(sample, filters({ priorities: ["high"], assignees: [ana.id] }))
      .length === 0,
  );
  check(
    "the column dimension is not part of matchesCard",
    matchesCard(sample[0], filters({ columns: [999] })),
  );

  console.log("\n3. column visibility");
  const columns: BoardColumn[] = [
    { id: 1, name: "Todo", position: 1, wip_limit: null },
    { id: 2, name: "In Progress", position: 2, wip_limit: 3 },
    { id: 3, name: "Done", position: 3, wip_limit: null },
  ];
  check(
    "no column filter shows every column",
    visibleColumns(columns, EMPTY_FILTERS).length === 3,
  );
  const shown = visibleColumns(columns, filters({ columns: [3, 1] }));
  check("hides exactly the unlisted columns", shown.length === 2);
  check(
    "and preserves the caller's order rather than the filter's",
    shown.map((column) => column.id).join(",") === "1,3",
    shown.map((column) => column.id),
  );

  console.log("\n4. the assignee roster is derived from the cards on hand");
  const roster = collectAssignees([
    card(1, { assignee: bo }),
    card(2, { assignee: ana }),
    card(3, { assignee: bo }),
    card(4, { assignee: null }),
  ]);
  check("deduped by id", roster.length === 2, roster);
  check("sorted by name", roster.map((p) => p.id).join(",") === "u-ana,u-bo");
  check("nulls are skipped", !roster.some((p) => p === null));
  check("hasUnassigned sees the null", hasUnassigned([card(1)]));
  check(
    "and is false when every card has an assignee",
    !hasUnassigned([card(1, { assignee: ana })]),
  );
  check("toggleFilter adds", toggleFilter<number>([1], 2).join(",") === "1,2");
  check("toggleFilter removes", toggleFilter([1, 2], 1).join(",") === "2");

  console.log("\n5. a drop under a filter resolves against the FULL list");
  // A, B, C, D in one column. The filter hides B and C, so the user sees A, D
  // and drops the moving card between them.
  const full = [
    card(10, { position: "a0", priority: "urgent" }),
    card(11, { position: "a1", priority: "low" }),
    card(12, { position: "a2", priority: "low" }),
    card(13, { position: "a3", priority: "urgent" }),
  ];
  const hiding = filters({ priorities: ["urgent"] });
  const visible = filterCards(full, hiding);
  check(
    "the filter really does hide the middle two",
    visible.map((item) => item.id).join(",") === "10,13",
  );

  // The gesture anchors to the card under the pointer: "insert before #13".
  // In the full list that slot is after #12, so the card lands at the far end
  // of the hidden run — never inside it.
  const dropped = resolveDrop(full, 13);
  check(
    "next is the card under the pointer (#13)",
    dropped.nextId === 13,
    dropped,
  );
  check(
    "prev is #12 — the true neighbour, NOT the visible #10",
    dropped.prevId === 12,
    dropped,
  );
  check("insertion index is a full-list index", dropped.index === 3, dropped);

  // This is the invariant the whole design exists for, stated directly: the
  // pair handed to the server is adjacent in the full list, so there is never
  // a hidden card between them for the new key to land among.
  const adjacent = (result: { prevId: number | null; nextId: number | null }) => {
    const prevIndex = full.findIndex((item) => item.id === result.prevId);
    const nextIndex = full.findIndex((item) => item.id === result.nextId);
    if (result.prevId === null) return nextIndex === 0;
    if (result.nextId === null) return prevIndex === full.length - 1;
    return nextIndex === prevIndex + 1;
  };
  check("the resolved pair is adjacent in the full list", adjacent(dropped), dropped);
  check(
    "and it is adjacent for every possible drop target",
    [...full.map((item) => item.id), null].every((overId) =>
      adjacent(resolveDrop(full, overId)),
    ),
  );
  check(
    "the pair the VISIBLE list would have produced is NOT adjacent",
    !adjacent({ prevId: 10, nextId: 13 }),
  );

  console.log("\n6. dropping on the container appends");
  const appended = resolveDrop(full, null);
  check("prev is the last card", appended.prevId === 13, appended);
  check("next is null", appended.nextId === null, appended);
  check("index is the length", appended.index === full.length, appended);
  check(
    "an id that is not in this scope also appends rather than guessing",
    resolveDrop(full, 999).prevId === 13,
  );
  check("and an empty list yields two nulls", (() => {
    const empty = resolveDrop([], null);
    return empty.prevId === null && empty.nextId === null && empty.index === 0;
  })());

  console.log("\n7. parity with the pre-refactor arithmetic when nothing is hidden");
  // What board.tsx did before: insert into the rendered list, then read the
  // slots either side. With no filter the rendered list is the full list.
  let parity = true;
  for (let index = 0; index <= full.length; index += 1) {
    const overCardId = index < full.length ? full[index].id : null;
    const legacyTarget = [...full];
    const toIndex = overCardId === null ? legacyTarget.length : index;
    const nextTarget = [...legacyTarget];
    nextTarget.splice(toIndex, 0, card(99));
    const legacyPrev = nextTarget[toIndex - 1]?.id ?? null;
    const legacyNext = nextTarget[toIndex + 1]?.id ?? null;

    const resolved = resolveDrop(full, overCardId);
    if (resolved.prevId !== legacyPrev || resolved.nextId !== legacyNext) {
      parity = false;
      console.error("    mismatch at index", index, { legacyPrev, legacyNext, resolved });
    }
  }
  check("every insertion index produces the same neighbour pair", parity);

  console.log("\n8. the resolved pair produces a key that keeps hidden cards put");
  const positionOf = (id: number | null) =>
    id === null ? null : (full.find((item) => item.id === id)?.position ?? null);
  const prevPosition = positionOf(dropped.prevId);
  const nextPosition = positionOf(dropped.nextId);
  const minted = generateKeyBetween(prevPosition, nextPosition);
  check(
    `the key sorts strictly between ${prevPosition} and ${nextPosition}`,
    prevPosition! < minted && minted < nextPosition!,
    minted,
  );

  const resorted = [...full, card(99, { position: minted })].sort((a, b) =>
    a.position === b.position ? a.id - b.id : a.position < b.position ? -1 : 1,
  );
  check(
    "the moved card lands immediately before the card it was dropped on",
    resorted.map((item) => item.id).join(",") === "10,11,12,99,13",
    resorted.map((item) => item.id),
  );
  check(
    "and every hidden card keeps its relative order",
    resorted
      .filter((item) => item.id !== 99)
      .map((item) => item.id)
      .join(",") === "10,11,12,13",
  );

  // The alternative, for contrast: had the visible neighbours been sent, the
  // key would have landed somewhere between #10 and #13 — inside the hidden run.
  const naive = generateKeyBetween(positionOf(10), positionOf(13));
  check(
    "sending the VISIBLE neighbours would have buried the card among the hidden ones",
    !(naive < full[1].position),
    { naive, firstHidden: full[1].position },
  );
  if (naive === full[1].position) {
    console.log(
      `        (it collides outright with #11 at "${naive}" — the duplicate-key trap)`,
    );
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exitCode = 1;
  } else {
    console.log("\nall checks passed");
  }
}

main();
