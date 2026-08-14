// Env is loaded by the runtime (`tsx --env-file=.env.local`), not here: ES
// module imports are hoisted, so a dotenv call in this file would run after
// `@/db` has already read process.env.
import { asc, eq } from "drizzle-orm";
import { generateKeyBetween } from "fractional-indexing";

import { db } from "@/db";
import { cards, columns, labels, sprints, workspaces } from "@/db/schema";

const WORKSPACE_SLUG = "koban";

const DEFAULT_COLUMNS = [
  { name: "To Do", wipLimit: null },
  { name: "In Progress", wipLimit: 5 },
  { name: "In Review", wipLimit: 3 },
  { name: "Done", wipLimit: null },
];

const DEFAULT_LABELS = [
  { name: "bug", color: "#ef4444" },
  { name: "feature", color: "#3b82f6" },
  { name: "chore", color: "#64748b" },
  { name: "spike", color: "#a855f7" },
];

const SAMPLE_CARDS = [
  {
    column: "To Do",
    title: "Wire the machine API key table",
    description: "Hashed keys, per-workspace scoping, revocation flag.",
    priority: "high" as const,
    points: 3,
  },
  {
    column: "To Do",
    title: "Backlog view",
    description: "Cards with sprint_id = null, draggable into the active sprint.",
    priority: "medium" as const,
    points: 5,
  },
  {
    column: "In Progress",
    title: "Server-side move endpoint",
    description:
      "Takes prev_card_id / next_card_id and calls generateKeyBetween on the server.",
    priority: "urgent" as const,
    points: 3,
  },
  {
    column: "In Review",
    title: "Drizzle schema for all 12 tables",
    description: "Includes the self-describing workspace_id on ai_jobs.",
    priority: "medium" as const,
    points: 2,
  },
  {
    column: "Done",
    title: "Scaffold Next.js 15 + Tailwind + shadcn/ui",
    description: "App Router, src dir, @/* alias.",
    priority: "low" as const,
    points: 1,
  },
];

async function main() {
  console.log("Seeding…");

  // Workspace ------------------------------------------------------------
  let [workspace] = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.slug, WORKSPACE_SLUG))
    .limit(1);

  if (!workspace) {
    [workspace] = await db
      .insert(workspaces)
      .values({ name: "Koban", slug: WORKSPACE_SLUG })
      .returning();
    console.log(`  workspace #${workspace.id} (${workspace.slug})`);
  } else {
    console.log(`  workspace #${workspace.id} already exists, reusing`);
  }

  // Columns --------------------------------------------------------------
  const existingColumns = await db
    .select()
    .from(columns)
    .where(eq(columns.workspaceId, workspace.id))
    .orderBy(asc(columns.position));

  let boardColumns = existingColumns;
  if (existingColumns.length === 0) {
    boardColumns = await db
      .insert(columns)
      .values(
        DEFAULT_COLUMNS.map((column, index) => ({
          workspaceId: workspace.id,
          name: column.name,
          position: index,
          wipLimit: column.wipLimit,
        })),
      )
      .returning();
    console.log(`  ${boardColumns.length} columns`);
  } else {
    console.log(`  ${existingColumns.length} columns already exist, reusing`);
  }

  const columnByName = new Map(boardColumns.map((c) => [c.name, c]));

  // Labels ---------------------------------------------------------------
  const existingLabels = await db
    .select({ id: labels.id })
    .from(labels)
    .where(eq(labels.workspaceId, workspace.id));

  if (existingLabels.length === 0) {
    await db
      .insert(labels)
      .values(
        DEFAULT_LABELS.map((label) => ({ ...label, workspaceId: workspace.id })),
      );
    console.log(`  ${DEFAULT_LABELS.length} labels`);
  }

  // Sprint ---------------------------------------------------------------
  const existingSprints = await db
    .select()
    .from(sprints)
    .where(eq(sprints.workspaceId, workspace.id))
    .limit(1);

  let sprint = existingSprints[0];
  if (!sprint) {
    const startsAt = new Date();
    const endsAt = new Date(startsAt.getTime() + 14 * 24 * 60 * 60 * 1000);
    [sprint] = await db
      .insert(sprints)
      .values({
        workspaceId: workspace.id,
        name: "Sprint 1",
        goal: "Board loads, cards drag, positions persist.",
        startsAt,
        endsAt,
        status: "active",
      })
      .returning();
    console.log(`  sprint #${sprint.id} (${sprint.name})`);
  } else {
    console.log(`  sprint #${sprint.id} already exists, reusing`);
  }

  // Cards ----------------------------------------------------------------
  const existingCards = await db
    .select({ id: cards.id })
    .from(cards)
    .where(eq(cards.workspaceId, workspace.id))
    .limit(1);

  if (existingCards.length > 0) {
    console.log("  cards already exist, skipping sample cards");
  } else {
    // One fractional-index sequence per column, exactly as the move endpoint
    // will generate them later.
    const lastKeyByColumn = new Map<number, string | null>();
    const rows = SAMPLE_CARDS.map((card) => {
      const column = columnByName.get(card.column);
      if (!column) throw new Error(`Unknown column: ${card.column}`);
      const previousKey = lastKeyByColumn.get(column.id) ?? null;
      const position = generateKeyBetween(previousKey, null);
      lastKeyByColumn.set(column.id, position);
      return {
        workspaceId: workspace.id,
        sprintId: sprint.id,
        columnId: column.id,
        title: card.title,
        description: card.description,
        priority: card.priority,
        points: card.points,
        position,
      };
    });

    const inserted = await db.insert(cards).values(rows).returning({
      id: cards.id,
    });
    console.log(`  ${inserted.length} cards`);
  }

  console.log("Seed complete.");
}

// `process.exitCode`, not `process.exit()`: forcing the exit races tsx's loader
// teardown on Windows and aborts with a libuv assertion after a clean seed.
main().catch((error) => {
  console.error("Seed failed:", error);
  process.exitCode = 1;
});
