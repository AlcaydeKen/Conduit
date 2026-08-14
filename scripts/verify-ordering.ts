/**
 * Proves the equal-neighbour trap is real, that the move path survives it, and
 * that board and backlog key spaces are independent.
 *
 * Run: pnpm verify:ordering
 *
 * Creates throwaway cards in the first column of workspace 1 and drives the
 * same code path the move endpoint uses. Cleans up after itself.
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import { generateKeyBetween } from "fractional-indexing";

import { db } from "@/db";
import { cards, columns, sprints, workspaces } from "@/db/schema";
import {
  computePosition,
  readOrder,
  rebalance,
  type OrderScope,
} from "@/lib/ordering";

let failures = 0;

function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) {
    console.log(`  PASS  ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${label}`, detail ?? "");
  }
}

async function main() {
  const [workspace] = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .orderBy(asc(workspaces.id))
    .limit(1);
  if (!workspace) throw new Error("no workspace — run pnpm db:seed first");

  const [column] = await db
    .select({ id: columns.id, name: columns.name })
    .from(columns)
    .where(eq(columns.workspaceId, workspace.id))
    .orderBy(asc(columns.position))
    .limit(1);
  if (!column) throw new Error("no columns — run pnpm db:seed first");

  const [sprint] = await db
    .select({ id: sprints.id })
    .from(sprints)
    .where(eq(sprints.workspaceId, workspace.id))
    .orderBy(asc(sprints.id))
    .limit(1);
  if (!sprint) throw new Error("no sprint — run pnpm db:seed first");

  const boardScope: OrderScope = {
    kind: "board",
    workspaceId: workspace.id,
    columnId: column.id,
    sprintId: sprint.id,
  };
  const backlogScope: OrderScope = {
    kind: "backlog",
    workspaceId: workspace.id,
  };

  console.log(
    `workspace #${workspace.id}, column "${column.name}" (#${column.id}), sprint #${sprint.id}`,
  );

  const created: number[] = [];

  try {
    const duplicate = "a5";
    const inserted = await db
      .insert(cards)
      .values([
        {
          workspaceId: workspace.id,
          columnId: column.id,
          sprintId: sprint.id,
          title: "[verify] duplicate A",
          position: duplicate,
        },
        {
          workspaceId: workspace.id,
          columnId: column.id,
          sprintId: sprint.id,
          title: "[verify] duplicate B",
          position: duplicate,
        },
      ])
      .returning({ id: cards.id });
    created.push(...inserted.map((row) => row.id));
    const [cardA, cardB] = inserted.map((row) => row.id);

    console.log("\n1. the trap is real");
    let threw = false;
    try {
      generateKeyBetween(duplicate, duplicate);
    } catch (error) {
      threw = true;
      check(
        `generateKeyBetween("${duplicate}", "${duplicate}") throws: "${(error as Error).message}"`,
        true,
      );
    }
    check("naive path would 500", threw);

    const before = await readOrder(boardScope);
    const beforeIds = before.map((row) => row.id);
    check(
      "duplicate keys present before healing",
      new Set(before.map((row) => row.position)).size < before.length,
      before,
    );
    check(
      "id ASC tie-break puts A before B",
      beforeIds.indexOf(cardA) < beforeIds.indexOf(cardB),
    );

    console.log("\n2. move path heals instead of throwing");
    const result = await computePosition(
      boardScope,
      { prev: duplicate, next: duplicate },
      (fresh) => ({
        prev: fresh.find((row) => row.id === cardA)?.position ?? null,
        next: fresh.find((row) => row.id === cardB)?.position ?? null,
      }),
    );

    check("computePosition returned a key", result.ok, result);
    if (!result.ok) throw new Error("computePosition refused");
    check("it reported a rebalance", result.rebalanced);

    const after = await readOrder(boardScope);
    check(
      "all keys distinct after rebalance",
      new Set(after.map((row) => row.position)).size === after.length,
      after,
    );
    check(
      "displayed order unchanged",
      JSON.stringify(after.map((row) => row.id)) === JSON.stringify(beforeIds),
      { before: beforeIds, after: after.map((row) => row.id) },
    );

    console.log("\n3. the new key lands in the right gap");
    const [middle] = await db
      .insert(cards)
      .values({
        workspaceId: workspace.id,
        columnId: column.id,
        sprintId: sprint.id,
        title: "[verify] lands between",
        position: result.position,
      })
      .returning({ id: cards.id });
    created.push(middle.id);

    const final = await readOrder(boardScope);
    const finalIds = final.map((row) => row.id);
    check(
      "sorts strictly between A and B",
      finalIds.indexOf(cardA) < finalIds.indexOf(middle.id) &&
        finalIds.indexOf(middle.id) < finalIds.indexOf(cardB),
      finalIds,
    );

    console.log("\n4. inverted neighbours are refused");
    const inverted = await computePosition(
      boardScope,
      { prev: "a9", next: "a1" },
      () => ({ prev: "a9", next: "a1" }),
    );
    check(
      "returns invalid_neighbors",
      !inverted.ok && inverted.error === "invalid_neighbors",
      inverted,
    );

    // A card can sit in the same column as a sprint card while belonging to the
    // backlog. The two are never displayed together, so they must not share a
    // key space — otherwise a backlog rebalance would rewrite sprint cards.
    console.log("\n5. board and backlog key spaces are independent");
    const [backlogCard] = await db
      .insert(cards)
      .values({
        workspaceId: workspace.id,
        columnId: column.id,
        sprintId: null,
        title: "[verify] backlog resident",
        position: "a0",
      })
      .returning({ id: cards.id });
    created.push(backlogCard.id);

    const boardIds = (await readOrder(boardScope)).map((row) => row.id);
    const backlogIds = (await readOrder(backlogScope)).map((row) => row.id);

    check(
      "backlog card is absent from the board scope",
      !boardIds.includes(backlogCard.id),
      boardIds,
    );
    check(
      "backlog card is present in the backlog scope",
      backlogIds.includes(backlogCard.id),
      backlogIds,
    );
    check(
      "no sprint card leaks into the backlog scope",
      !backlogIds.includes(cardA) && !backlogIds.includes(cardB),
      backlogIds,
    );

    const boardKeysBefore = await readOrder(boardScope);
    await rebalance(backlogScope);
    const boardKeysAfter = await readOrder(boardScope);
    check(
      "rebalancing the backlog leaves board keys untouched",
      JSON.stringify(boardKeysBefore) === JSON.stringify(boardKeysAfter),
      { boardKeysBefore, boardKeysAfter },
    );
  } finally {
    if (created.length > 0) {
      await db.delete(cards).where(inArray(cards.id, created));
    }
    await rebalance(boardScope);
    const restored = await db
      .select({ id: cards.id })
      .from(cards)
      .where(
        and(eq(cards.workspaceId, workspace.id), eq(cards.columnId, column.id)),
      );
    console.log(`\ncleaned up; column left with ${restored.length} cards`);
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exitCode = 1;
  } else {
    console.log("\nall checks passed");
  }
}

main().catch((error) => {
  console.error("verify-ordering failed:", error);
  process.exitCode = 1;
});
