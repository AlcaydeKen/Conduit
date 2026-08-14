/**
 * Exercises sprint management and backlog moves over HTTP against `pnpm dev`.
 *
 * Run: pnpm dev  (in one terminal)
 *      pnpm verify:sprints
 *
 * Creates a throwaway sprint and moves one seeded card to the backlog and back.
 * Restores everything it touched.
 */
import { encode } from "@auth/core/jwt";
import { and, asc, eq } from "drizzle-orm";

import { db } from "@/db";
import { cards, sprints, users, workspaces } from "@/db/schema";

const BASE_URL = process.env.VERIFY_BASE_URL ?? "http://localhost:3000";
const COOKIE_NAME = "authjs.session-token";

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
  const [user] = await db.select().from(users).orderBy(asc(users.createdAt)).limit(1);
  if (!user) throw new Error("no user — sign in through the browser once first");

  const [workspace] = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .orderBy(asc(workspaces.id))
    .limit(1);
  if (!workspace) throw new Error("no workspace — run pnpm db:seed");

  const token = await encode({
    token: { sub: user.id },
    secret: process.env.AUTH_SECRET!,
    salt: COOKIE_NAME,
    maxAge: 600,
  });
  const cookie = `${COOKIE_NAME}=${token}`;

  const authed = (path: string, init?: RequestInit) =>
    fetch(`${BASE_URL}${path}`, {
      ...init,
      headers: { ...init?.headers, cookie, "content-type": "application/json" },
      redirect: "manual",
    });

  const [activeSprint] = await db
    .select({ id: sprints.id, name: sprints.name })
    .from(sprints)
    .where(
      and(eq(sprints.workspaceId, workspace.id), eq(sprints.status, "active")),
    )
    .limit(1);

  let throwawaySprintId: number | null = null;
  const [sampleCard] = await db
    .select({ id: cards.id, columnId: cards.columnId, sprintId: cards.sprintId })
    .from(cards)
    .where(eq(cards.workspaceId, workspace.id))
    .orderBy(asc(cards.id))
    .limit(1);

  try {
    console.log("1. authentication");
    const anon = await fetch(`${BASE_URL}/api/v1/sprints`, { redirect: "manual" });
    check("anonymous GET /api/v1/sprints is 401", anon.status === 401, anon.status);

    console.log("\n2. creating a sprint");
    const createResponse = await authed("/api/v1/sprints", {
      method: "POST",
      body: JSON.stringify({
        workspace_id: workspace.id,
        name: "[verify] throwaway sprint",
        goal: "created by verify:sprints",
      }),
    });
    check("create is 200", createResponse.status === 200, createResponse.status);
    const created = await createResponse.json();
    throwawaySprintId = created.sprint?.id ?? null;
    check("new sprint is planned", created.sprint?.status === "planned", created.sprint);
    check("it has an id", typeof throwawaySprintId === "number");

    console.log("\n3. validation");
    const noName = await authed("/api/v1/sprints", {
      method: "POST",
      body: JSON.stringify({ workspace_id: workspace.id, name: "   " }),
    });
    check("blank name is 400", noName.status === 400, noName.status);

    const badDates = await authed("/api/v1/sprints", {
      method: "POST",
      body: JSON.stringify({
        workspace_id: workspace.id,
        name: "[verify] bad dates",
        starts_at: "2026-09-01T00:00:00.000Z",
        ends_at: "2026-08-01T00:00:00.000Z",
      }),
    });
    check("ends before starts is 400", badDates.status === 400, badDates.status);
    check(
      "and names the reason",
      (await badDates.json()).error === "ends_at_before_starts_at",
    );

    console.log("\n4. one active sprint at a time");
    if (activeSprint) {
      const startWhileActive = await authed(
        `/api/v1/sprints/${throwawaySprintId}/start`,
        { method: "POST" },
      );
      check(
        `starting a second sprint while "${activeSprint.name}" is active is 409`,
        startWhileActive.status === 409,
        startWhileActive.status,
      );
      check(
        "and names the reason",
        (await startWhileActive.json()).error === "active_sprint_exists",
      );

      const createActive = await authed("/api/v1/sprints", {
        method: "POST",
        body: JSON.stringify({
          workspace_id: workspace.id,
          name: "[verify] would-be active",
          activate: true,
        }),
      });
      check(
        "creating with activate:true is also 409",
        createActive.status === 409,
        createActive.status,
      );
    } else {
      console.log("  SKIP  no active sprint in the workspace");
    }

    console.log("\n5. unknown ids are 404, not 403");
    const missingStart = await authed("/api/v1/sprints/999999/start", {
      method: "POST",
    });
    const missingComplete = await authed("/api/v1/sprints/999999/complete", {
      method: "POST",
      body: JSON.stringify({}),
    });
    check("start of unknown sprint is 404", missingStart.status === 404, missingStart.status);
    check("complete of unknown sprint is 404", missingComplete.status === 404, missingComplete.status);
    check(
      "both 404 bodies are byte-identical",
      (await missingStart.text()) === (await missingComplete.text()),
    );

    console.log("\n6. dragging a card to the backlog and back");
    if (!sampleCard) throw new Error("no cards — run pnpm db:seed");

    const toBacklog = await authed(`/api/v1/cards/${sampleCard.id}/move`, {
      method: "POST",
      body: JSON.stringify({
        column_id: sampleCard.columnId,
        sprint_id: null,
        prev_card_id: null,
        next_card_id: null,
      }),
    });
    check("move to backlog is 200", toBacklog.status === 200, toBacklog.status);
    const backlogBody = await toBacklog.json();
    check("response reports sprint_id null", backlogBody.card?.sprint_id === null, backlogBody.card);

    const [afterBacklog] = await db
      .select({ sprintId: cards.sprintId })
      .from(cards)
      .where(eq(cards.id, sampleCard.id))
      .limit(1);
    check("database agrees", afterBacklog.sprintId === null, afterBacklog);

    const boardResponse = await authed("/api/v1/board");
    const boardBody = await boardResponse.json();
    check(
      "card now appears in the board payload's backlog",
      boardBody.backlog?.some((card: { id: number }) => card.id === sampleCard.id),
      boardBody.backlog?.map((c: { id: number }) => c.id),
    );
    check(
      "and no longer in the sprint columns",
      !boardBody.cards?.some((card: { id: number }) => card.id === sampleCard.id),
    );

    if (sampleCard.sprintId !== null) {
      const backToSprint = await authed(`/api/v1/cards/${sampleCard.id}/move`, {
        method: "POST",
        body: JSON.stringify({
          column_id: sampleCard.columnId,
          sprint_id: sampleCard.sprintId,
          prev_card_id: null,
          next_card_id: null,
        }),
      });
      check("move back into the sprint is 200", backToSprint.status === 200, backToSprint.status);
      const [restored] = await db
        .select({ sprintId: cards.sprintId })
        .from(cards)
        .where(eq(cards.id, sampleCard.id))
        .limit(1);
      check("database agrees", restored.sprintId === sampleCard.sprintId, restored);
    }

    console.log("\n7. completing a sprint");
    const complete = await authed(`/api/v1/sprints/${throwawaySprintId}/complete`, {
      method: "POST",
      body: JSON.stringify({ carry_over_to: "backlog" }),
    });
    check("complete is 200", complete.status === 200, complete.status);
    const completeBody = await complete.json();
    check("status is completed", completeBody.sprint?.status === "completed", completeBody.sprint);
    check("it reports what it carried", typeof completeBody.carried_over === "number");

    const recomplete = await authed(`/api/v1/sprints/${throwawaySprintId}/complete`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    check("completing twice is 400", recomplete.status === 400, recomplete.status);

    const startCompleted = await authed(`/api/v1/sprints/${throwawaySprintId}/start`, {
      method: "POST",
    });
    check("starting a completed sprint is 400", startCompleted.status === 400, startCompleted.status);

    const selfCarry = await authed(`/api/v1/sprints/${activeSprint?.id ?? 0}/complete`, {
      method: "POST",
      body: JSON.stringify({ carry_over_to: activeSprint?.id ?? 0 }),
    });
    check(
      "carrying a sprint over to itself is 400",
      selfCarry.status === 400,
      selfCarry.status,
    );
  } finally {
    // Remove every sprint this script created, and anything it might have
    // parked in them.
    const throwaways = await db
      .select({ id: sprints.id })
      .from(sprints)
      .where(eq(sprints.workspaceId, workspace.id));
    const names = await db
      .select({ id: sprints.id, name: sprints.name })
      .from(sprints)
      .where(eq(sprints.workspaceId, workspace.id));
    const toDelete = names
      .filter((row) => row.name.startsWith("[verify]"))
      .map((row) => row.id);

    for (const id of toDelete) {
      await db
        .update(cards)
        .set({ sprintId: null })
        .where(eq(cards.sprintId, id));
      await db.delete(sprints).where(eq(sprints.id, id));
    }
    console.log(
      `\ncleaned up ${toDelete.length} throwaway sprint(s); ${throwaways.length - toDelete.length} remain`,
    );
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exitCode = 1;
  } else {
    console.log("\nall checks passed");
  }
}

main().catch((error) => {
  console.error("verify-sprints failed:", error);
  process.exitCode = 1;
});
