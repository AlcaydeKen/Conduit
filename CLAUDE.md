# Kanban Project Guidelines & Constraints

## Tech Stack
- Next.js 15 App Router + TypeScript + Tailwind + shadcn/ui + dnd-kit
- Neon Postgres + Drizzle ORM + Auth.js v5 (GitHub provider)
- SWR for data fetching (5s polling)
- MCP SDK (`@modelcontextprotocol/sdk`) stdio transport in `mcp/`

## Non-Negotiable Rules

### 1. Multi-Tenant Isolation & Security
- NEVER run a separate `findFirst` followed by an `if (item.workspaceId !== auth)`.
- ALWAYS enforce tenant isolation in the primary query using an `INNER JOIN` up to `workspace_id`.
- ALWAYS fail closed with a `404 Not Found` (NEVER `403 Forbidden`) when a resource is not found or belongs to another workspace. This prevents tenant enumeration attacks.
- The `workspace_id` MUST originate from the authenticated session or API key, NEVER from request bodies or query parameters.

### 2. Card Ordering & Concurrency
- Card moves take neighbor IDs (`prev_card_id`, `next_card_id`), NOT client-calculated strings.
- Compute position midpoints strictly on the server using `fractional-indexing`.
- DO NOT use `SELECT ... FOR UPDATE` or pessimistic locking on card moves.
- ALWAYS sort ordered reads using `ORDER BY position ASC, id ASC` as a deterministic tie-breaker.

### 3. Worker Auth & AI Queue
- `ai_jobs` must be self-describing (`workspace_id` present on the row).
- Queue worker `POST /ai/jobs/claim` uses a claim-only, rate-limited key.
- Hand off a short-lived (15 min) HMAC-signed execution token upon job claim.
- `POST /ai/jobs/:id/result` authenticates SOLELY via the signed job token.

## Commands
- Build: `pnpm build`
- Typecheck: `pnpm typecheck`
- DB Push: `pnpm drizzle-kit push`