/**
 * Proves the equal-neighbour trap is real and that the move path survives it.
 *
 * Run: pnpm verify:ordering
 *
 * Creates throwaway cards in the first column of workspace 1, forces a
 * duplicate position key, and drives the same code path the move endpoint uses.
 * Cleans up after itself.
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import { generateKeyBetween } from "fractional-indexing";

import { db } from "@/db";
import { cards, columns, workspaces } from "@/db/schema";
import { computePosition, readColumnOrder, rebalanceColumn } from "@/lib/ordering";

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

  console.log(`workspace #${workspace.id}, column "${column.name}" (#${column.id})`);

  const created: number[] = [];

  try {
    // 1. Two cards land in the same gap in the same instant. SPEC accepts this.
    const duplicate = "a5";
    const inserted = await db
      .insert(cards)
      .values([
        {
          workspaceId: workspace.id,
          columnId: column.id,
          title: "[verify] duplicate A",
          position: duplicate,
        },
        {
          workspaceId: workspace.id,
          columnId: column.id,
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
        `generateKeyBetween("${duplicate}", "${duplicate}") throws: ${(error as Error).message}`,
        true,
      );
    }
    check("naive path would 500", threw);

    // 2. Order as displayed, before healing.
    const before = await readColumnOrder(workspace.id, column.id);
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

    // 3. Drive the real move path: land a card between the two equal keys.
    console.log("\n2. move path heals instead of throwing");
    const result = await computePosition(
      workspace.id,
      column.id,
      { prev: duplicate, next: duplicate },
      (fresh) => ({
        prev: fresh.find((row) => row.id === cardA)?.position ?? null,
        next: fresh.find((row) => row.id === cardB)?.position ?? null,
      }),
    );

    check("computePosition returned a key", result.ok, result);
    if (!result.ok) throw new Error("computePosition refused");
    check("it reported a rebalance", result.rebalanced);

    // 4. Column is healed and order is preserved exactly.
    const after = await readColumnOrder(workspace.id, column.id);
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

    // 5. The computed key really does sort between the two former duplicates.
    console.log("\n3. the new key lands in the right gap");
    const [insertedMiddle] = await db
      .insert(cards)
      .values({
        workspaceId: workspace.id,
        columnId: column.id,
        title: "[verify] lands between",
        position: result.position,
      })
      .returning({ id: cards.id });
    created.push(insertedMiddle.id);

    const final = await readColumnOrder(workspace.id, column.id);
    const finalIds = final.map((row) => row.id);
    check(
      "sorts strictly between A and B",
      finalIds.indexOf(cardA) < finalIds.indexOf(insertedMiddle.id) &&
        finalIds.indexOf(insertedMiddle.id) < finalIds.indexOf(cardB),
      finalIds,
    );

    // 6. Inverted neighbours are refused rather than guessed at.
    console.log("\n4. inverted neighbours are refused");
    const inverted = await computePosition(
      workspace.id,
      column.id,
      { prev: "a9", next: "a1" },
      () => ({ prev: "a9", next: "a1" }),
    );
    check(
      "returns invalid_neighbors",
      !inverted.ok && inverted.error === "invalid_neighbors",
      inverted,
    );
  } finally {
    if (created.length > 0) {
      await db.delete(cards).where(inArray(cards.id, created));
    }
    await rebalanceColumn(workspace.id, column.id);
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
