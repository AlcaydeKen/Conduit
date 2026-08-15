#!/usr/bin/env node
/**
 * Conduit MCP server — stdio transport.
 *
 * Every tool is a thin wrapper over exactly one `/api/v1/*` endpoint. Nothing
 * here decides tenancy, ordering, or validity: the API key is scoped to one
 * workspace server-side, positions are computed server-side from neighbour
 * intent, and a rejected call comes back as a message rather than a crash.
 *
 * Registration, per developer, each with their own key so `activity` attributes
 * actions correctly:
 *
 *   claude mcp add conduit \
 *     --env KANBAN_API_URL=https://your-app \
 *     --env KANBAN_API_KEY=cdt_... \
 *     -- node ./mcp/dist/index.js
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { ConduitClient, describeError, readConfig } from "./client.js";

const PRIORITIES = ["low", "medium", "high", "urgent"] as const;

const config = readConfig(process.env);
const client = new ConduitClient(config);

const server = new McpServer({
  name: "conduit",
  version: "0.1.0",
});

/** One shape for every tool result, so failures never look like data. */
function ok(payload: unknown) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(payload, null, 2) },
    ],
  };
}

function fail(error: unknown) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: describeError(error) }],
  };
}

async function call<T>(run: () => Promise<T>) {
  try {
    return ok(await run());
  } catch (error) {
    return fail(error);
  }
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                       */
/* -------------------------------------------------------------------------- */

server.registerTool(
  "list_workspaces",
  {
    title: "List workspaces",
    description:
      "Lists the workspaces this API key can see. A key is issued for exactly " +
      "one workspace, so this returns a single entry — use it to learn that " +
      "workspace's id and name. Wraps GET /api/v1/workspaces.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => call(() => client.request("GET", "/workspaces")),
);

server.registerTool(
  "list_sprints",
  {
    title: "List sprints",
    description:
      "Lists every sprint in the workspace with its status (planned, active, " +
      "or completed). At most one sprint is active at a time. Wraps " +
      "GET /api/v1/sprints.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => call(() => client.request("GET", "/sprints")),
);

server.registerTool(
  "get_board",
  {
    title: "Get board",
    description:
      "Returns the board for one sprint: its columns in left-to-right order, " +
      "the cards in each, and the backlog alongside. Cards arrive sorted by " +
      "position — preserve that order, and never compute a position yourself. " +
      "Omit `sprint` for the active sprint, or pass \"backlog\" to view the " +
      "backlog as the board. Wraps GET /api/v1/board.",
    inputSchema: {
      sprint: z
        .union([z.number().int().positive(), z.literal("backlog")])
        .optional()
        .describe("Sprint id, or \"backlog\". Defaults to the active sprint."),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ sprint }) =>
    call(() =>
      client.request("GET", "/board", {
        query: { sprint: sprint === undefined ? undefined : String(sprint) },
      }),
    ),
);

server.registerTool(
  "search_cards",
  {
    title: "Search cards",
    description:
      "Finds cards in the workspace. Every filter is optional and they " +
      "combine with AND. `q` matches title and description, case-insensitively, " +
      "as a literal substring — %  and _ are not wildcards. Results are capped; " +
      "the response reports `truncated` when there were more. Wraps " +
      "GET /api/v1/cards.",
    inputSchema: {
      q: z.string().trim().min(1).optional().describe("Substring of title or description."),
      sprint: z
        .union([z.number().int().positive(), z.literal("backlog")])
        .optional()
        .describe("Sprint id, or \"backlog\" for unassigned cards."),
      column: z.number().int().positive().optional().describe("Column id."),
      assignee: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe("User id, or \"unassigned\"."),
      limit: z.number().int().min(1).max(200).optional().describe("Default 100, max 200."),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ q, sprint, column, assignee, limit }) =>
    call(() =>
      client.request("GET", "/cards", {
        query: {
          q,
          sprint: sprint === undefined ? undefined : String(sprint),
          column,
          assignee,
          limit,
        },
      }),
    ),
);

server.registerTool(
  "get_card",
  {
    title: "Get card",
    description:
      "Returns one card with its labels. A card in another workspace and a " +
      "card that does not exist both return the same not-found error. Wraps " +
      "GET /api/v1/cards/:id.",
    inputSchema: {
      card_id: z.number().int().positive(),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ card_id }) => call(() => client.request("GET", `/cards/${card_id}`)),
);

/* -------------------------------------------------------------------------- */
/* Writes                                                                      */
/* -------------------------------------------------------------------------- */

server.registerTool(
  "create_card",
  {
    title: "Create card",
    description:
      "Creates a card at the end of a column. Call get_board first to learn " +
      "the column ids — a column id from another workspace is rejected as " +
      "not-found. Omit `sprint_id` to put the card in the backlog. The " +
      "position is assigned by the server. Wraps POST /api/v1/cards.",
    inputSchema: {
      column_id: z.number().int().positive(),
      title: z.string().trim().min(1).max(300),
      description: z.string().max(20_000).optional(),
      sprint_id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Omit for the backlog."),
      priority: z.enum(PRIORITIES).optional().describe("Defaults to medium."),
      points: z.number().int().min(0).max(1000).optional(),
      assignee_id: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe("Must be a member of this workspace."),
    },
  },
  async (input) => call(() => client.request("POST", "/cards", { body: input })),
);

server.registerTool(
  "update_card",
  {
    title: "Update card",
    description:
      "Edits a card's content. Only the fields you pass are changed. This " +
      "cannot move a card between columns or sprints — use move_card, which " +
      "computes the ordering key server-side. Wraps PATCH /api/v1/cards/:id.",
    inputSchema: {
      card_id: z.number().int().positive(),
      title: z.string().trim().min(1).max(300).optional(),
      description: z.string().max(20_000).nullable().optional(),
      priority: z.enum(PRIORITIES).optional(),
      points: z.number().int().min(0).max(1000).nullable().optional(),
    },
  },
  async ({ card_id, ...patch }) =>
    call(() => client.request("PATCH", `/cards/${card_id}`, { body: patch })),
);

server.registerTool(
  "move_card",
  {
    title: "Move card",
    description:
      "Moves a card to a column and position. You state *intent*, not a " +
      "position: give the ids of the cards it should sit between, and the " +
      "server computes the key. Both neighbours must already be in the " +
      "destination column and sprint. Omit both to append to the end. Pass " +
      "sprint_id: null to move the card to the backlog; omit sprint_id to " +
      "leave the sprint unchanged. Call get_board first for current " +
      "neighbour ids. Wraps POST /api/v1/cards/:id/move.",
    inputSchema: {
      card_id: z.number().int().positive(),
      column_id: z.number().int().positive(),
      prev_card_id: z
        .number()
        .int()
        .positive()
        .nullable()
        .optional()
        .describe("The card it should sit after. Null or omitted means first."),
      next_card_id: z
        .number()
        .int()
        .positive()
        .nullable()
        .optional()
        .describe("The card it should sit before. Null or omitted means last."),
      sprint_id: z
        .number()
        .int()
        .positive()
        .nullable()
        .optional()
        .describe("Null moves it to the backlog. Omit to leave unchanged."),
    },
  },
  async ({ card_id, ...body }) =>
    call(() => client.request("POST", `/cards/${card_id}/move`, { body })),
);

server.registerTool(
  "assign_card",
  {
    title: "Assign card",
    description:
      "Sets or clears a card's assignee. The user must be a member of this " +
      "workspace; anyone else is rejected as not-found. Pass assignee_id: null " +
      "to unassign. Wraps PATCH /api/v1/cards/:id.",
    inputSchema: {
      card_id: z.number().int().positive(),
      assignee_id: z
        .string()
        .trim()
        .min(1)
        .nullable()
        .describe("User id, or null to unassign."),
    },
  },
  async ({ card_id, assignee_id }) =>
    call(() =>
      client.request("PATCH", `/cards/${card_id}`, {
        body: { assignee_id },
      }),
    ),
);

server.registerTool(
  "comment_card",
  {
    title: "Comment on card",
    description:
      "Appends a comment to a card. The body is rendered as Markdown, and raw " +
      "HTML in it stays inert text. Comments made with an API key have no user " +
      "author; the key is recorded in the activity log instead. Wraps " +
      "POST /api/v1/cards/:id/comments.",
    inputSchema: {
      card_id: z.number().int().positive(),
      body: z.string().trim().min(1).max(10_000),
    },
  },
  async ({ card_id, body }) =>
    call(() =>
      client.request("POST", `/cards/${card_id}/comments`, { body: { body } }),
    ),
);

/* -------------------------------------------------------------------------- */

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is the protocol channel — anything written there corrupts the
  // stream, so diagnostics go to stderr.
  console.error(`conduit-mcp connected to ${config.baseUrl}`);
}

main().catch((error) => {
  console.error("conduit-mcp failed to start:", describeError(error));
  process.exit(1);
});
