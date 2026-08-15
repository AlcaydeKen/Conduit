/**
 * Drives the built MCP server over stdio, the same way Claude Code will.
 *
 * Run: pnpm dev        (in one terminal)
 *      pnpm mcp:build
 *      pnpm verify:mcp
 *
 * Mints a throwaway workspace key, spawns `node mcp/dist/index.js` with it,
 * exercises every tool through a real MCP client, and removes what it made.
 * Testing the bundle rather than the source is the point: the bundle is what
 * gets registered, and a build that drops an import fails here rather than in
 * someone's editor.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { asc, eq, inArray } from "drizzle-orm";

import { db } from "@/db";
import { apiKeys, cards, comments, workspaces } from "@/db/schema";
import { generateApiKey } from "@/lib/api/keys";

const BASE_URL = process.env.VERIFY_BASE_URL ?? "http://localhost:3000";
const LABEL = "[mcp-verify] key";
const MARKER = "[mcp-verify]";

const EXPECTED_TOOLS = [
  "assign_card",
  "comment_card",
  "create_card",
  "get_board",
  "get_card",
  "list_sprints",
  "list_workspaces",
  "move_card",
  "search_cards",
  "update_card",
];

let failures = 0;

function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) {
    console.log(`  PASS  ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${label}`, detail ?? "");
  }
}

type ToolResult = {
  isError?: boolean;
  content?: { type: string; text?: string }[];
};

function textOf(result: ToolResult): string {
  return (result.content ?? [])
    .map((part) => part.text ?? "")
    .join("\n");
}

/**
 * Tool payloads are JSON whose shape the server owns. Re-declaring every
 * response type here would only assert that this file agrees with itself, and
 * a wrong assertion would fail the check rather than the server — which is
 * backwards for a verification script.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function jsonOf(result: ToolResult): any {
  return JSON.parse(textOf(result));
}

async function main() {
  const [workspace] = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .orderBy(asc(workspaces.id))
    .limit(1);
  if (!workspace) throw new Error("no workspace — run pnpm db:seed");

  const generated = generateApiKey();
  await db.insert(apiKeys).values({
    workspaceId: workspace.id,
    label: LABEL,
    keyHash: generated.hash,
    scopes: ["board:read", "board:write"],
  });

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["mcp/dist/index.js"],
    env: {
      ...(process.env as Record<string, string>),
      KANBAN_API_URL: BASE_URL,
      KANBAN_API_KEY: generated.plaintext,
    },
    stderr: "pipe",
  });

  const client = new Client({ name: "verify-mcp", version: "0.1.0" });
  let createdCardId: number | null = null;

  try {
    await client.connect(transport);

    console.log("1. the server advertises exactly the agreed tools");
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name).sort();
    check(
      `all ten tools present (${names.length})`,
      JSON.stringify(names) === JSON.stringify(EXPECTED_TOOLS),
      names,
    );
    check(
      "every tool carries a description",
      tools.every((tool) => (tool.description ?? "").length > 40),
      tools.filter((tool) => (tool.description ?? "").length <= 40).map((t) => t.name),
    );
    check(
      "move_card advertises neighbour intent, not a position",
      /neighbour|between/i.test(
        tools.find((tool) => tool.name === "move_card")?.description ?? "",
      ) &&
        !Object.keys(
          (tools.find((tool) => tool.name === "move_card")?.inputSchema
            ?.properties ?? {}) as object,
        ).includes("position"),
    );

    console.log("\n2. reads");
    const workspacesResult = (await client.callTool({
      name: "list_workspaces",
      arguments: {},
    })) as ToolResult;
    check("list_workspaces succeeds", !workspacesResult.isError, textOf(workspacesResult));
    const workspacesBody = jsonOf(workspacesResult);
    check(
      "a key sees exactly one workspace",
      workspacesBody.workspaces?.length === 1,
      workspacesBody.workspaces,
    );

    const sprintsResult = (await client.callTool({
      name: "list_sprints",
      arguments: {},
    })) as ToolResult;
    check("list_sprints succeeds", !sprintsResult.isError, textOf(sprintsResult));
    const sprintId = jsonOf(sprintsResult).sprints?.[0]?.id;
    check("it returned a sprint", typeof sprintId === "number", sprintId);

    const boardResult = (await client.callTool({
      name: "get_board",
      arguments: {},
    })) as ToolResult;
    check("get_board succeeds", !boardResult.isError, textOf(boardResult));
    const board = jsonOf(boardResult);
    const columnId = board.columns?.[0]?.id;
    check("the board carries columns", typeof columnId === "number", board.columns);
    check(
      "cards arrive in position order",
      Array.isArray(board.cards) &&
        board.cards.every(
          (card: { position: string }, index: number) =>
            index === 0 || board.cards[index - 1].position <= card.position,
        ),
    );

    console.log("\n3. writes");
    const createResult = (await client.callTool({
      name: "create_card",
      arguments: {
        column_id: columnId,
        sprint_id: sprintId,
        title: `${MARKER} card`,
        priority: "high",
        points: 3,
      },
    })) as ToolResult;
    check("create_card succeeds", !createResult.isError, textOf(createResult));
    const created = jsonOf(createResult).card;
    createdCardId = created?.id ?? null;
    check("it returns a server-assigned position", typeof created?.position === "string");
    check("and the priority it was given", created?.priority === "high", created);

    const getResult = (await client.callTool({
      name: "get_card",
      arguments: { card_id: createdCardId },
    })) as ToolResult;
    check("get_card finds it", !getResult.isError && jsonOf(getResult).card?.id === createdCardId);

    const updateResult = (await client.callTool({
      name: "update_card",
      arguments: { card_id: createdCardId, title: `${MARKER} renamed`, points: 5 },
    })) as ToolResult;
    check("update_card succeeds", !updateResult.isError, textOf(updateResult));
    check("the title changed", jsonOf(updateResult).card?.title === `${MARKER} renamed`);

    const assignResult = (await client.callTool({
      name: "assign_card",
      arguments: { card_id: createdCardId, assignee_id: null },
    })) as ToolResult;
    check("assign_card can unassign", !assignResult.isError, textOf(assignResult));
    check("assignee is null", jsonOf(assignResult).card?.assignee === null);

    const targetColumn = board.columns?.[1]?.id ?? columnId;
    const moveResult = (await client.callTool({
      name: "move_card",
      arguments: {
        card_id: createdCardId,
        column_id: targetColumn,
        prev_card_id: null,
        next_card_id: null,
      },
    })) as ToolResult;
    check("move_card succeeds", !moveResult.isError, textOf(moveResult));
    check(
      "the card is in the destination column",
      jsonOf(moveResult).card?.column_id === targetColumn,
      jsonOf(moveResult).card,
    );

    const commentResult = (await client.callTool({
      name: "comment_card",
      arguments: { card_id: createdCardId, body: `${MARKER} hello` },
    })) as ToolResult;
    check("comment_card succeeds", !commentResult.isError, textOf(commentResult));

    const searchResult = (await client.callTool({
      name: "search_cards",
      arguments: { q: `${MARKER} renamed` },
    })) as ToolResult;
    check("search_cards finds the card", !searchResult.isError);
    check(
      "by substring",
      jsonOf(searchResult).cards?.some(
        (card: { id: number }) => card.id === createdCardId,
      ),
      jsonOf(searchResult).cards?.length,
    );

    console.log("\n4. failures arrive as errors, not crashes");
    const missing = (await client.callTool({
      name: "get_card",
      arguments: { card_id: 99999999 },
    })) as ToolResult;
    check("a missing id is reported as an error", missing.isError === true);
    check(
      "and the message refuses to distinguish missing from forbidden",
      /does not exist, or it belongs to a workspace/i.test(textOf(missing)),
      textOf(missing),
    );

    const badColumn = (await client.callTool({
      name: "create_card",
      arguments: { column_id: 99999999, title: `${MARKER} should not exist` },
    })) as ToolResult;
    check("a foreign column id is an error", badColumn.isError === true, textOf(badColumn));

    const invalid = (await client.callTool({
      name: "create_card",
      arguments: { column_id: columnId, title: "   " },
    })) as ToolResult;
    check("schema validation rejects a blank title", invalid.isError === true);

    console.log("\n5. the connection survives all of that");
    const stillAlive = (await client.callTool({
      name: "list_workspaces",
      arguments: {},
    })) as ToolResult;
    check("the server is still responding", !stillAlive.isError);
  } finally {
    await client.close().catch(() => {});

    const titled = await db
      .select({ id: cards.id, title: cards.title })
      .from(cards)
      .where(eq(cards.workspaceId, workspace.id));
    const toDelete = titled
      .filter((row) => row.title.startsWith(MARKER))
      .map((row) => row.id);

    if (toDelete.length > 0) {
      await db.delete(comments).where(inArray(comments.cardId, toDelete));
      await db.delete(cards).where(inArray(cards.id, toDelete));
    }
    await db.delete(apiKeys).where(eq(apiKeys.label, LABEL));

    console.log(`\ncleaned up ${toDelete.length} card(s) and the throwaway key`);
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exitCode = 1;
  } else {
    console.log("\nall checks passed");
  }
}


main().catch((error) => {
  console.error("verify-mcp failed:", error);
  process.exitCode = 1;
});
