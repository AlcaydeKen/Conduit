/**
 * Cross-tenant checks against a running dev server.
 *
 * Run: pnpm dev  (in one terminal)
 *      pnpm verify:tenant
 *
 * Builds a second workspace with its own key, then tries to reach the first
 * workspace's rows with it. Every attempt must come back as the one frozen 404
 * body, and must write nothing. The point is not that access is denied — it is
 * that a caller cannot tell a forbidden id from an id that was never issued,
 * because that difference is what turns sequential ids into a tenant directory.
 */
import { encode } from "@auth/core/jwt";
import { and, asc, eq, inArray } from "drizzle-orm";
import { generateKeyBetween } from "fractional-indexing";

import { db } from "@/db";
import {
  apiKeys,
  cards,
  columns,
  comments,
  sprints,
  users,
  workspaceMembers,
  workspaces,
} from "@/db/schema";
import { generateApiKey } from "@/lib/api/keys";

const BASE_URL = process.env.VERIFY_BASE_URL ?? "http://localhost:3000";
const COOKIE_NAME = "authjs.session-token";
const MARKER = "[tenant-verify]";

let failures = 0;

function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) {
    console.log(`  PASS  ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${label}`, detail ?? "");
  }
}

type Fixture = {
  workspaceId: number;
  columnId: number;
  sprintId: number;
  cardId: number;
  key: string;
};

async function main() {
  const [user] = await db
    .select()
    .from(users)
    .orderBy(asc(users.createdAt))
    .limit(1);
  if (!user) throw new Error("no user — sign in through the browser once first");

  const [tenantA] = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .orderBy(asc(workspaces.id))
    .limit(1);
  if (!tenantA) throw new Error("no workspace — run pnpm db:seed");

  const [cardA] = await db
    .select({ id: cards.id, columnId: cards.columnId })
    .from(cards)
    .where(eq(cards.workspaceId, tenantA.id))
    .orderBy(asc(cards.id))
    .limit(1);
  if (!cardA) throw new Error("no cards — run pnpm db:seed");

  const [sprintA] = await db
    .select({ id: sprints.id })
    .from(sprints)
    .where(eq(sprints.workspaceId, tenantA.id))
    .orderBy(asc(sprints.id))
    .limit(1);
  if (!sprintA) throw new Error("no sprints — run pnpm db:seed");

  const sessionToken = await encode({
    token: { sub: user.id },
    secret: process.env.AUTH_SECRET!,
    salt: COOKIE_NAME,
    maxAge: 600,
  });
  const cookie = `${COOKIE_NAME}=${sessionToken}`;

  let fixture: Fixture | null = null;
  let keyA = "";
  let serviceKey = "";
  let revokedKey = "";
  let revokedKeyId = 0;

  try {
    // ---- fixture -----------------------------------------------------------
    const [workspaceB] = await db
      .insert(workspaces)
      .values({ name: `${MARKER} tenant B`, slug: `tenant-verify-b` })
      .returning({ id: workspaces.id });

    const [columnB] = await db
      .insert(columns)
      .values({ workspaceId: workspaceB.id, name: "To Do", position: 1 })
      .returning({ id: columns.id });

    const [sprintB] = await db
      .insert(sprints)
      .values({ workspaceId: workspaceB.id, name: `${MARKER} sprint`, status: "planned" })
      .returning({ id: sprints.id });

    const [cardB] = await db
      .insert(cards)
      .values({
        workspaceId: workspaceB.id,
        columnId: columnB.id,
        sprintId: sprintB.id,
        title: `${MARKER} card`,
        position: generateKeyBetween(null, null),
      })
      .returning({ id: cards.id });

    const generatedB = generateApiKey();
    await db.insert(apiKeys).values({
      workspaceId: workspaceB.id,
      label: `${MARKER} key B`,
      keyHash: generatedB.hash,
      scopes: [],
    });

    const generatedA = generateApiKey();
    await db.insert(apiKeys).values({
      workspaceId: tenantA.id,
      label: `${MARKER} key A`,
      keyHash: generatedA.hash,
      scopes: [],
    });
    keyA = generatedA.plaintext;

    const generatedService = generateApiKey();
    await db.insert(apiKeys).values({
      workspaceId: null,
      label: `${MARKER} service claim key`,
      keyHash: generatedService.hash,
      scopes: ["ai:claim"],
    });
    serviceKey = generatedService.plaintext;

    const generatedRevoked = generateApiKey();
    const [revokedRow] = await db
      .insert(apiKeys)
      .values({
        workspaceId: tenantA.id,
        label: `${MARKER} revoked key`,
        keyHash: generatedRevoked.hash,
        revoked: true,
        scopes: [],
      })
      .returning({ id: apiKeys.id });
    revokedKey = generatedRevoked.plaintext;
    revokedKeyId = revokedRow.id;

    fixture = {
      workspaceId: workspaceB.id,
      columnId: columnB.id,
      sprintId: sprintB.id,
      cardId: cardB.id,
      key: generatedB.plaintext,
    };

    const asKey = (token: string) => (path: string, init?: RequestInit) =>
      fetch(`${BASE_URL}${path}`, {
        ...init,
        headers: {
          ...init?.headers,
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        redirect: "manual",
      });

    const bearerB = asKey(fixture.key);
    const bearerA = asKey(keyA);

    const withCookie = (path: string, init?: RequestInit) =>
      fetch(`${BASE_URL}${path}`, {
        ...init,
        headers: { ...init?.headers, cookie, "content-type": "application/json" },
        redirect: "manual",
      });

    // ---- 1. the key works at all ------------------------------------------
    console.log("1. a workspace key authenticates");
    const boardB = await bearerB(`/api/v1/board`);
    check("GET /board with a Bearer key is 200", boardB.status === 200, boardB.status);
    const boardBodyB = await boardB.json();
    check(
      "and it is scoped to the key's own workspace",
      boardBodyB.workspace?.id === fixture.workspaceId,
      boardBodyB.workspace,
    );

    const workspacesB = await bearerB(`/api/v1/workspaces`);
    const workspacesBodyB = await workspacesB.json();
    check(
      "GET /workspaces returns only that one workspace",
      workspacesBodyB.workspaces?.length === 1 &&
        workspacesBodyB.workspaces[0].id === fixture.workspaceId,
      workspacesBodyB.workspaces,
    );
    check(
      "and never inherits its creator's role",
      workspacesBodyB.workspaces?.[0]?.role === "member",
      workspacesBodyB.workspaces?.[0],
    );

    // ---- 2. bad credentials ------------------------------------------------
    console.log("\n2. credentials that must not work");
    const anonymous = await fetch(`${BASE_URL}/api/v1/board`, { redirect: "manual" });
    check("no credential is 401", anonymous.status === 401, anonymous.status);

    const garbage = await asKey("cdt_not-a-real-key")(`/api/v1/board`);
    check("an unknown key is 401", garbage.status === 401, garbage.status);

    const revoked = await asKey(revokedKey)(`/api/v1/board`);
    check("a revoked key is 401", revoked.status === 401, revoked.status);

    console.log("\n3. the service claim key is refused everywhere");
    const serviceRoutes: [string, RequestInit][] = [
      ["/api/v1/board", {}],
      ["/api/v1/workspaces", {}],
      ["/api/v1/cards", {}],
      ["/api/v1/sprints", {}],
      [`/api/v1/cards/${fixture.cardId}`, {}],
      [`/api/v1/reports/sprint/${fixture.sprintId}`, {}],
      [
        `/api/v1/cards/${fixture.cardId}/comments`,
        { method: "POST", body: JSON.stringify({ body: "service key" }) },
      ],
    ];
    for (const [path, init] of serviceRoutes) {
      const response = await asKey(serviceKey)(path, init);
      check(`${init.method ?? "GET"} ${path} is 401`, response.status === 401, response.status);
    }

    // ---- 4. cross-tenant reads and writes ----------------------------------
    console.log("\n4. tenant B reaching for tenant A's rows");
    const foreign: [string, RequestInit][] = [
      [`/api/v1/cards/${cardA.id}`, {}],
      [
        `/api/v1/cards/${cardA.id}`,
        { method: "PATCH", body: JSON.stringify({ title: "pwned" }) },
      ],
      [
        `/api/v1/cards/${cardA.id}/move`,
        {
          method: "POST",
          body: JSON.stringify({ column_id: cardA.columnId, prev_card_id: null, next_card_id: null }),
        },
      ],
      [`/api/v1/cards/${cardA.id}/comments`, {}],
      [
        `/api/v1/cards/${cardA.id}/comments`,
        { method: "POST", body: JSON.stringify({ body: "pwned" }) },
      ],
      [`/api/v1/reports/sprint/${sprintA.id}`, {}],
      [`/api/v1/sprints/${sprintA.id}/start`, { method: "POST" }],
      [
        `/api/v1/sprints/${sprintA.id}/complete`,
        { method: "POST", body: JSON.stringify({}) },
      ],
    ];

    const bodies: string[] = [];
    for (const [path, init] of foreign) {
      const response = await bearerB(path, init);
      check(
        `${init.method ?? "GET"} ${path} is 404`,
        response.status === 404,
        response.status,
      );
      bodies.push(await response.text());
    }

    console.log("\n5. a missing id is indistinguishable from a forbidden one");
    const missing = await bearerB(`/api/v1/cards/99999999`);
    check("an id that does not exist is 404", missing.status === 404, missing.status);
    const missingBody = await missing.text();
    check(
      "and every cross-tenant 404 body is byte-identical to it",
      bodies.every((body) => body === missingBody),
      { missingBody, distinct: [...new Set(bodies)] },
    );

    console.log("\n6. nothing was written");
    const [cardAfter] = await db
      .select({ title: cards.title, columnId: cards.columnId, workspaceId: cards.workspaceId })
      .from(cards)
      .where(eq(cards.id, cardA.id))
      .limit(1);
    check("tenant A's card still belongs to tenant A", cardAfter.workspaceId === tenantA.id);
    check("its title was not overwritten", cardAfter.title !== "pwned", cardAfter.title);

    const pwnedComments = await db
      .select({ id: comments.id })
      .from(comments)
      .where(and(eq(comments.cardId, cardA.id), eq(comments.body, "pwned")));
    check("no comment was inserted", pwnedComments.length === 0, pwnedComments);

    const [sprintAfter] = await db
      .select({ status: sprints.status })
      .from(sprints)
      .where(eq(sprints.id, sprintA.id))
      .limit(1);
    check(
      "tenant A's sprint status is untouched",
      sprintAfter.status !== "completed",
      sprintAfter,
    );

    // ---- 7. the workspace hint cannot widen a key --------------------------
    console.log("\n7. ?workspace= is a hint, never an escalation");
    const hinted = await bearerB(`/api/v1/board?workspace=${tenantA.id}`);
    check("pointing a key at another workspace is 404", hinted.status === 404, hinted.status);
    check(
      "and matches the frozen body",
      (await hinted.text()) === missingBody,
    );

    const hintedOwn = await bearerB(`/api/v1/board?workspace=${fixture.workspaceId}`);
    check("its own workspace still resolves", hintedOwn.status === 200, hintedOwn.status);

    const bodyHint = await bearerB(`/api/v1/cards`, {
      method: "POST",
      body: JSON.stringify({
        workspace_id: tenantA.id,
        column_id: cardA.columnId,
        title: `${MARKER} should not exist`,
      }),
    });
    check(
      "a workspace_id in the body cannot redirect a write",
      bodyHint.status === 404,
      bodyHint.status,
    );
    const leaked = await db
      .select({ id: cards.id })
      .from(cards)
      .where(
        and(eq(cards.workspaceId, tenantA.id), eq(cards.title, `${MARKER} should not exist`)),
      );
    check("and wrote nothing into tenant A", leaked.length === 0, leaked);

    // ---- 8. keys cannot mint keys -----------------------------------------
    console.log("\n8. a key cannot manage keys");
    const mint = await bearerA(`/api/v1/keys`, {
      method: "POST",
      body: JSON.stringify({ label: `${MARKER} minted by a key` }),
    });
    check("POST /keys with a Bearer key is 401", mint.status === 401, mint.status);

    const listByKey = await bearerA(`/api/v1/keys?workspace=${tenantA.id}`);
    check("GET /keys with a Bearer key is 401", listByKey.status === 401, listByKey.status);

    const revokeByKey = await bearerA(
      `/api/v1/keys?id=${revokedKeyId}&workspace=${tenantA.id}`,
      { method: "DELETE" },
    );
    check("DELETE /keys with a Bearer key is 401", revokeByKey.status === 401, revokeByKey.status);

    console.log("\n9. the session path still works, and leaks no hashes");
    const listBySession = await withCookie(`/api/v1/keys?workspace=${tenantA.id}`);
    check("GET /keys with a session cookie is 200", listBySession.status === 200, listBySession.status);
    const listBody = await listBySession.text();
    check(
      "the response contains no key material",
      !listBody.includes("key_hash") && !listBody.includes("keyHash"),
    );

    const foreignKeyList = await withCookie(`/api/v1/keys?workspace=${fixture.workspaceId}`);
    check(
      "a workspace the signed-in user is not a member of is 404",
      foreignKeyList.status === 404,
      foreignKeyList.status,
    );

    console.log("\n10. assignees cannot be borrowed from another tenant");
    const foreignAssignee = await bearerB(`/api/v1/cards`, {
      method: "POST",
      body: JSON.stringify({
        column_id: fixture.columnId,
        title: `${MARKER} foreign assignee`,
        assignee_id: user.id,
      }),
    });
    check(
      "assigning a non-member is 404",
      foreignAssignee.status === 404,
      foreignAssignee.status,
    );

    console.log("\n11. the key's own workspace is fully usable");
    const created = await bearerB(`/api/v1/cards`, {
      method: "POST",
      body: JSON.stringify({
        column_id: fixture.columnId,
        sprint_id: fixture.sprintId,
        title: `${MARKER} created by key`,
        priority: "high",
      }),
    });
    check("POST /cards in its own workspace is 200", created.status === 200, created.status);
    const createdBody = await created.json();
    check("the card comes back with a server-assigned position",
      typeof createdBody.card?.position === "string" && createdBody.card.position.length > 0,
      createdBody.card,
    );

    const listOwn = await bearerB(`/api/v1/cards?q=created%20by%20key`);
    const listOwnBody = await listOwn.json();
    check(
      "GET /cards?q= finds it",
      listOwnBody.cards?.some((card: { id: number }) => card.id === createdBody.card.id),
      listOwnBody.cards,
    );

    const report = await bearerB(`/api/v1/reports/sprint/${fixture.sprintId}`);
    check("GET /reports/sprint/:id is 200", report.status === 200, report.status);
    const reportBody = await report.json();
    check(
      "and counts the card it just created",
      reportBody.totals?.cards >= 1,
      reportBody.totals,
    );
  } finally {
    // Children first: `cards.column_id` is ON DELETE RESTRICT, so cascading from
    // the workspace is not guaranteed to unwind in a workable order.
    const marked = await db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.slug, "tenant-verify-b"));

    const ids = marked.map((row) => row.id);
    if (ids.length > 0) {
      await db.delete(cards).where(inArray(cards.workspaceId, ids));
      await db.delete(sprints).where(inArray(sprints.workspaceId, ids));
      await db.delete(columns).where(inArray(columns.workspaceId, ids));
      await db.delete(apiKeys).where(inArray(apiKeys.workspaceId, ids));
      await db.delete(workspaceMembers).where(inArray(workspaceMembers.workspaceId, ids));
      await db.delete(workspaces).where(inArray(workspaces.id, ids));
    }

    // The service key and tenant A's throwaway keys have no workspace to cascade
    // from, so they are removed by label.
    const stragglers = await db
      .select({ id: apiKeys.id, label: apiKeys.label })
      .from(apiKeys);
    const strays = stragglers
      .filter((row) => row.label.startsWith(MARKER))
      .map((row) => row.id);
    if (strays.length > 0) {
      await db.delete(apiKeys).where(inArray(apiKeys.id, strays));
    }

    console.log(
      `\ncleaned up ${ids.length} workspace(s) and ${strays.length} key(s)`,
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
  console.error("verify-tenant failed:", error);
  process.exitCode = 1;
});
