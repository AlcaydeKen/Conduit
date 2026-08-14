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
import { cards, columns, sprints, users, workspaces } from "@/db/schema";
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

  // Put it back so repeat runs start from the same place.
  await db
    .update(cards)
    .set({ columnId: originalColumnId, position: originalPosition })
    .where(and(eq(cards.id, movingId), eq(cards.workspaceId, workspace.id)));
  console.log(`\nrestored card #${movingId} to column #${originalColumnId}`);

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
