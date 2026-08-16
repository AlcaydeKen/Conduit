/**
 * Exercises the live move endpoint over HTTP against a running `pnpm dev`.
 *
 * Run: pnpm dev  (in one terminal)
 *      pnpm verify:api
 *
 * Mints a session cookie locally with the app's own AUTH_SECRET so the real
 * route — middleware, auth, tenant guards and all — is what gets tested.
 */
import { encode } from "@auth/core/jwt";
import { and, asc, eq } from "drizzle-orm";

import { db } from "@/db";
import { cards, columns, labels, sprints, users, workspaces } from "@/db/schema";
import { readOrder, type OrderScope } from "@/lib/ordering";

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

async function sessionCookie(userId: string): Promise<string> {
  const token = await encode({
    token: { sub: userId },
    secret: process.env.AUTH_SECRET!,
    // Auth.js derives its encryption key from the cookie name.
    salt: COOKIE_NAME,
    maxAge: 60 * 10,
  });
  return `${COOKIE_NAME}=${token}`;
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

  const cookie = await sessionCookie(user.id);
  const authed = (path: string, init?: RequestInit) =>
    fetch(`${BASE_URL}${path}`, {
      ...init,
      headers: { ...init?.headers, cookie, "content-type": "application/json" },
      redirect: "manual",
    });

  console.log("1. authentication is required");
  const anon = await fetch(`${BASE_URL}/api/v1/board`, { redirect: "manual" });
  check("anonymous GET /api/v1/board is 401", anon.status === 401, anon.status);

  console.log("\n2. board reads");
  const boardResponse = await authed("/api/v1/board");
  check("authenticated GET /api/v1/board is 200", boardResponse.status === 200);
  const board = await boardResponse.json();
  check("board carries columns", Array.isArray(board.columns) && board.columns.length > 0);
  check("board carries cards", Array.isArray(board.cards));

  const positions = board.cards.map((card: { position: string }) => card.position);
  const sorted = [...board.cards].sort(
    (a: { position: string; id: number }, b: { position: string; id: number }) =>
      a.position === b.position ? a.id - b.id : a.position < b.position ? -1 : 1,
  );
  check(
    "cards arrive in position ASC, id ASC order",
    JSON.stringify(board.cards.map((c: { id: number }) => c.id)) ===
      JSON.stringify(sorted.map((c: { id: number }) => c.id)),
    positions,
  );

  console.log("\n3. move endpoint");
  const columnRows = await db
    .select({ id: columns.id, name: columns.name })
    .from(columns)
    .where(eq(columns.workspaceId, workspace.id))
    .orderBy(asc(columns.position));

  const [sourceColumn, targetColumn] = columnRows;

  const [activeSprint] = await db
    .select({ id: sprints.id })
    .from(sprints)
    .where(eq(sprints.workspaceId, workspace.id))
    .orderBy(asc(sprints.id))
    .limit(1);
  if (!activeSprint) throw new Error("no sprint — run pnpm db:seed");

  const boardScope = (columnId: number): OrderScope => ({ kind: "board", workspaceId: workspace.id, columnId, sprintId: activeSprint.id });
  const sourceCards = await readOrder(boardScope(sourceColumn.id));
  if (sourceCards.length === 0) throw new Error("source column empty — run pnpm db:seed");

  const movingId = sourceCards[0].id;
  const targetBefore = await readOrder(boardScope(targetColumn.id));
  const originalColumnId = sourceColumn.id;
  const originalPosition = sourceCards[0].position;

  // Land it at the very top of the target column.
  const moveResponse = await authed(`/api/v1/cards/${movingId}/move`, {
    method: "POST",
    body: JSON.stringify({
      column_id: targetColumn.id,
      prev_card_id: null,
      next_card_id: targetBefore[0]?.id ?? null,
    }),
  });
  check(`move to "${targetColumn.name}" is 200`, moveResponse.status === 200, moveResponse.status);
  const moveBody = await moveResponse.json();

  const [movedRow] = await db
    .select({ columnId: cards.columnId, position: cards.position })
    .from(cards)
    .where(and(eq(cards.id, movingId), eq(cards.workspaceId, workspace.id)))
    .limit(1);

  check("database column changed", movedRow.columnId === targetColumn.id, movedRow);
  check(
    "response position matches the row",
    moveBody.card?.position === movedRow.position,
    { response: moveBody.card?.position, row: movedRow.position },
  );

  const targetAfter = await readOrder(boardScope(targetColumn.id));
  check("card is now first in the target column", targetAfter[0]?.id === movingId, targetAfter);
  check(
    "client never sent a position string",
    typeof moveBody.card?.position === "string" && moveBody.card.position.length > 0,
  );

  console.log("\n4. bad input is refused");
  const selfNeighbor = await authed(`/api/v1/cards/${movingId}/move`, {
    method: "POST",
    body: JSON.stringify({ column_id: targetColumn.id, prev_card_id: movingId }),
  });
  check("card as its own neighbour is 400", selfNeighbor.status === 400, selfNeighbor.status);

  const missingCard = await authed(`/api/v1/cards/999999/move`, {
    method: "POST",
    body: JSON.stringify({ column_id: targetColumn.id }),
  });
  check("move of a nonexistent card is 404", missingCard.status === 404, missingCard.status);

  const foreignColumn = await authed(`/api/v1/cards/${movingId}/move`, {
    method: "POST",
    body: JSON.stringify({ column_id: 999999 }),
  });
  check("move into a nonexistent column is 404", foreignColumn.status === 404, foreignColumn.status);

  const missingBody = await missingCard.text();
  const foreignBody = await foreignColumn.text();
  check(
    "both 404 bodies are byte-identical",
    missingBody === foreignBody,
    { missingBody, foreignBody },
  );

  console.log("\n5. the surfaces the browser now uses");

  // 5a. The roster the assignee picker is fed.
  const members = await authed(`/api/v1/members?workspace=${workspace.id}`);
  check("GET /members is 200", members.status === 200, members.status);
  const roster = (await members.json()).members as {
    id: string;
    name: string | null;
    role: string;
  }[];
  check(
    "it contains the signed-in user",
    roster.some((person) => person.id === user.id),
    roster.map((person) => person.id),
  );
  check(
    "and does not hand out email addresses",
    roster.every((person) => !("email" in person)),
    roster[0],
  );

  // 5b. Create and edit, the two things the UI could not do before.
  const created = await authed("/api/v1/cards", {
    method: "POST",
    body: JSON.stringify({
      column_id: targetColumn.id,
      sprint_id: null,
      title: "[verify-api] throwaway",
    }),
  });
  check("POST /cards is 200", created.status === 200, created.status);
  const newCard = (await created.json()).card as {
    id: number;
    title: string;
    position: string;
    priority: string;
  };
  check(
    "the server assigned the position, not the client",
    typeof newCard.position === "string" && newCard.position.length > 0,
    newCard.position,
  );
  check("and the default priority", newCard.priority === "medium", newCard.priority);

  const edited = await authed(`/api/v1/cards/${newCard.id}`, {
    method: "PATCH",
    body: JSON.stringify({
      title: "[verify-api] renamed",
      priority: "urgent",
      points: 5,
      assignee_id: null,
    }),
  });
  check("PATCH /cards/:id is 200", edited.status === 200, edited.status);
  const patched = (await edited.json()).card as {
    title: string;
    priority: string;
    points: number | null;
    position: string;
  };
  check("the title changed", patched.title === "[verify-api] renamed", patched.title);
  check("the priority changed", patched.priority === "urgent", patched.priority);
  check("points can be set", patched.points === 5, patched.points);
  check(
    "and the position is untouched — editing is not moving",
    patched.position === newCard.position,
    { before: newCard.position, after: patched.position },
  );

  // The edit form must never be able to reorder. If PATCH ever starts honouring
  // these, ordering has two entry points and only one of them generates keys.
  const smuggled = await authed(`/api/v1/cards/${newCard.id}`, {
    method: "PATCH",
    body: JSON.stringify({ position: "zzz", column_id: 999999, sprint_id: 999999 }),
  });
  const afterSmuggle = await db
    .select({ position: cards.position, columnId: cards.columnId })
    .from(cards)
    .where(eq(cards.id, newCard.id));
  check(
    "PATCH ignores position, column_id and sprint_id",
    afterSmuggle[0]?.position === newCard.position &&
      afterSmuggle[0]?.columnId === targetColumn.id,
    { status: smuggled.status, row: afterSmuggle[0] },
  );
  check(
    "and refuses the request rather than reporting success",
    smuggled.status === 400,
    smuggled.status,
  );

  /*
   * A partial PATCH must leave everything it does not name alone. This is the
   * whole reason the edit form sends only changed fields: a full-form submit
   * built from a snapshot silently reverts whatever someone else changed while
   * the drawer sat open, and `card.update` logs field *names* only, so the old
   * value survives nowhere.
   */
  const before = await db
    .select({ title: cards.title, points: cards.points, priority: cards.priority })
    .from(cards)
    .where(eq(cards.id, newCard.id));
  const partial = await authed(`/api/v1/cards/${newCard.id}`, {
    method: "PATCH",
    body: JSON.stringify({ points: 8 }),
  });
  const after = await db
    .select({ title: cards.title, points: cards.points, priority: cards.priority })
    .from(cards)
    .where(eq(cards.id, newCard.id));
  check(
    "a one-field PATCH changes that field",
    partial.status === 200 && after[0]?.points === 8,
    { status: partial.status, points: after[0]?.points },
  );
  check(
    "and touches nothing it did not name",
    after[0]?.title === before[0]?.title &&
      after[0]?.priority === before[0]?.priority,
    { before: before[0], after: after[0] },
  );

  const empty = await authed(`/api/v1/cards/${newCard.id}`, {
    method: "PATCH",
    body: JSON.stringify({}),
  });
  check(
    "an empty PATCH is 400, not a no-op write",
    empty.status === 400,
    empty.status,
  );

  // 5c. The drawer's history.
  const cardHistory = await authed(
    `/api/v1/activity?workspace=${workspace.id}&card=${newCard.id}&limit=25`,
  );
  check("GET /activity?card= is 200", cardHistory.status === 200, cardHistory.status);
  const historyEntries = (await cardHistory.json()).entries as {
    action: string;
    card: { id: number } | null;
  }[];
  check(
    "every entry belongs to the card asked for",
    historyEntries.length > 0 &&
      historyEntries.every((entry) => entry.card?.id === newCard.id),
    historyEntries.map((entry) => entry.card?.id),
  );
  check(
    "and the create is in it",
    historyEntries.some((entry) => entry.action === "card.create"),
    historyEntries.map((entry) => entry.action),
  );

  const unknownCardHistory = await authed(
    `/api/v1/activity?workspace=${workspace.id}&card=999999`,
  );
  check(
    "an unknown card yields an empty page, not an error",
    unknownCardHistory.status === 200 &&
      ((await unknownCardHistory.json()).entries as unknown[]).length === 0,
  );

  console.log("\n6. labels and archiving");

  const labelList = await authed(`/api/v1/labels?workspace=${workspace.id}`);
  check("GET /labels is 200", labelList.status === 200, labelList.status);
  const workspaceLabels = (await labelList.json()).labels as {
    id: number;
    name: string;
    color: string;
  }[];

  const labelName = `[verify-api] label ${newCard.id}`;
  const madeLabel = await authed("/api/v1/labels", {
    method: "POST",
    body: JSON.stringify({ workspace_id: workspace.id, name: labelName }),
  });
  check("POST /labels is 200", madeLabel.status === 200, madeLabel.status);
  const label = (await madeLabel.json()).label as { id: number; color: string };
  check("it defaults to a colour", /^#[0-9a-f]{6}$/i.test(label.color), label.color);

  // Unique on (workspace_id, name), enforced by the index rather than a SELECT,
  // so two people racing the same name cannot both win.
  const dupe = await authed("/api/v1/labels", {
    method: "POST",
    body: JSON.stringify({ workspace_id: workspace.id, name: labelName }),
  });
  check("the same name twice is 409", dupe.status === 409, dupe.status);

  const attached = await authed(`/api/v1/cards/${newCard.id}`, {
    method: "PATCH",
    body: JSON.stringify({ label_ids: [label.id] }),
  });
  const attachedCard = (await attached.json()).card as {
    labels: { id: number }[];
  };
  check(
    "PATCH label_ids attaches, and the card reports it",
    attached.status === 200 &&
      attachedCard.labels.map((item) => item.id).join(",") === String(label.id),
    attachedCard.labels,
  );

  // Replace-set, not a delta: an empty array is how a card is cleared.
  const cleared = await authed(`/api/v1/cards/${newCard.id}`, {
    method: "PATCH",
    body: JSON.stringify({ label_ids: [] }),
  });
  check(
    "an empty label_ids clears them",
    cleared.status === 200 &&
      ((await cleared.json()).card.labels as unknown[]).length === 0,
  );

  const unknownLabel = await authed(`/api/v1/cards/${newCard.id}`, {
    method: "PATCH",
    body: JSON.stringify({ label_ids: [999999] }),
  });
  check(
    "a label that does not exist is 404, not a partial attach",
    unknownLabel.status === 404,
    unknownLabel.status,
  );

  // Archive, then prove it leaves the board without leaving the database.
  const archived = await authed(`/api/v1/cards/${newCard.id}`, {
    method: "PATCH",
    body: JSON.stringify({ archived: true }),
  });
  check("PATCH archived:true is 200", archived.status === 200, archived.status);
  check(
    "and the card reports itself archived",
    (await archived.json()).card.archived === true,
  );

  const boardAfter = await authed(`/api/v1/board?workspace=${workspace.id}`);
  const boardCards = (await boardAfter.json()) as {
    cards: { id: number }[];
    backlog: { id: number }[];
    labels: unknown[];
  };
  check(
    "an archived card is off the board",
    ![...boardCards.cards, ...boardCards.backlog].some(
      (item) => item.id === newCard.id,
    ),
  );
  check(
    "the board payload carries the workspace's labels",
    Array.isArray(boardCards.labels) && boardCards.labels.length > 0,
    boardCards.labels?.length,
  );

  const liveList = await authed(`/api/v1/cards?workspace=${workspace.id}`);
  check(
    "and out of the default card list",
    !((await liveList.json()).cards as { id: number }[]).some(
      (item) => item.id === newCard.id,
    ),
  );

  const archivedList = await authed(
    `/api/v1/cards?workspace=${workspace.id}&archived=true`,
  );
  check(
    "but findable with ?archived=true — otherwise this is deletion",
    ((await archivedList.json()).cards as { id: number }[]).some(
      (item) => item.id === newCard.id,
    ),
  );

  const restored = await authed(`/api/v1/cards/${newCard.id}`, {
    method: "PATCH",
    body: JSON.stringify({ archived: false }),
  });
  check(
    "restoring puts it back",
    restored.status === 200 &&
      (await restored.json()).card.archived === false,
  );

  const cardHistoryAfter = await authed(
    `/api/v1/activity?workspace=${workspace.id}&card=${newCard.id}&limit=25`,
  );
  const historyActions = (
    (await cardHistoryAfter.json()).entries as { action: string }[]
  ).map((entry) => entry.action);
  check(
    "archive and restore are their own actions in the log",
    historyActions.includes("card.archive") &&
      historyActions.includes("card.restore"),
    historyActions,
  );

  // Put everything back so repeat runs start from the same place.
  await db.delete(labels).where(eq(labels.id, label.id));
  check(
    "the pre-existing labels were left alone",
    workspaceLabels.every((item) => item.id !== label.id),
  );
  await db.delete(cards).where(eq(cards.id, newCard.id));
  await db
    .update(cards)
    .set({ columnId: originalColumnId, position: originalPosition })
    .where(and(eq(cards.id, movingId), eq(cards.workspaceId, workspace.id)));
  console.log(
    `\nrestored card #${movingId} to column #${originalColumnId}; removed throwaway card #${newCard.id}`,
  );

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exitCode = 1;
  } else {
    console.log("\nall checks passed");
  }
}

main().catch((error) => {
  console.error("verify-api failed:", error);
  process.exitCode = 1;
});
