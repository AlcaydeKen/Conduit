# conduit-mcp

Stdio MCP server exposing the Conduit board to Claude Code. Every tool is a thin
wrapper over one `/api/v1/*` endpoint — tenancy, ordering and validation stay on
the server, so the tool surface has no second opinion about rules that only have
one answer.

## Build

```bash
pnpm mcp:build          # from the repo root; writes mcp/dist/index.js
```

`dist/` is generated and gitignored. Build before registering.

## Register

Each developer uses their own key, so `activity` attributes actions to the right
person. Mint one at **Settings → API keys** in the app.

```bash
claude mcp add conduit \
  --env KANBAN_API_URL=https://your-app \
  --env KANBAN_API_KEY=cdt_... \
  -- node ./mcp/dist/index.js
```

The repo also ships a project-scoped `.mcp.json` that reads `KANBAN_API_URL` and
`KANBAN_API_KEY` from the environment, so it holds no secret of its own.

## Tools

| Tool | Endpoint |
| --- | --- |
| `list_workspaces` | `GET /workspaces` |
| `list_sprints` | `GET /sprints` |
| `get_board` | `GET /board` |
| `search_cards` | `GET /cards` |
| `get_card` | `GET /cards/:id` |
| `create_card` | `POST /cards` |
| `update_card` | `PATCH /cards/:id` |
| `move_card` | `POST /cards/:id/move` |
| `assign_card` | `PATCH /cards/:id` |
| `comment_card` | `POST /cards/:id/comments` |

`assign_card` and `update_card` share an endpoint deliberately: assignment is
worth its own tool because it has a distinct failure mode — a user who is not a
member of the workspace — and folding it into a general edit hides that.

## Notes

- A key is scoped to one workspace, so `list_workspaces` returns exactly one
  entry. There is no workspace argument on any tool.
- `move_card` takes neighbour ids, never a position. The server computes the
  fractional key; a client that computed one would be working from stale board
  state.
- A card in another workspace and a card that does not exist return the same
  error, deliberately. The tool descriptions say so, so the model does not treat
  a 404 as an invitation to enumerate ids.
- Diagnostics go to stderr. stdout is the protocol channel.

## Verify

```bash
pnpm dev                # in one terminal
pnpm mcp:build
pnpm verify:mcp         # 28 checks: drives the built bundle over stdio
```
