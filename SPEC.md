# Custom Kanban Board — Multi-Workspace, Sprints, AI, MCP, n8n

## Context

You and two dev colleagues need a shared Kanban board with multiple workspaces and sprints. Off-the-shelf tools (Jira, Linear) either cost money per seat or can't be driven from Claude Code. You already have n8n running locally in Docker (`n8n` container, port 5678, SQLite in the `n8n_data` volume, no public URL), so the board should be automatable from day one.

Goal: a free, self-owned board that (a) runs on Vercel's free tier, (b) is enriched by a small local open-source model, (c) is fully controllable from Claude Code via MCP, and (d) uses your existing n8n as the automation engine.

Confirmed decisions: personal/non-commercial use (Vercel Hobby is fine), Ollama in Docker for AI, polling instead of realtime, MCP with read + write.

---

## Feasibility answers up front

**Vercel free — yes, with caveats.**
- Hobby tier hosts the Next.js app fine for 3 users. It is non-commercial only; that matches your answer.
- Vercel has no database. Use **Neon** free Postgres (serverless, scales to zero, ~0.5 GB) as a separate service.
- Hobby cron jobs are limited (small count, daily granularity). **Put all scheduling in n8n**, not in Vercel cron.
- Serverless functions have a short default timeout. Nothing slow runs on Vercel in this design — AI work happens in n8n.

**Small open-source model — yes, but not on Vercel.** No GPU and a hard bundle size limit make local inference on Vercel impossible. Ollama runs in your Docker beside n8n. `qwen3:4b` (or `llama3.2:3b` on a weaker machine) is enough for the tasks below.

**MCP to Claude Code — yes.** A small stdio MCP server calls the board's REST API with a per-developer API key. Each dev adds it to their own `.mcp.json`.

**n8n — it becomes the automation brain.** Critical constraint: your n8n is local-only, so **Vercel cannot call n8n**. The design therefore uses a **pull model** — n8n polls the board API on a schedule. No Cloudflare Tunnel required. A tunnel can be added later if instant reactions become worth it.

---

## Architecture

```
Browser (3 devs) ──▶ Next.js on Vercel ──▶ Neon Postgres
                          ▲
                          │ REST /api/v1 + Bearer API key
              ┌───────────┴───────────┐
              │                       │
   MCP server (stdio, local)     n8n (local Docker)
   from Claude Code                    │
                                       ▼
                              Ollama (local Docker, qwen3:4b)
```

Every automated actor (MCP, n8n) talks to the same versioned machine API with an API key. Browser sessions use cookie auth. One authorization layer, two credential types.

---

## Stack

| Concern | Choice | Why |
|---|---|---|
| App | Next.js 15 App Router + TypeScript | Best free Vercel target |
| DB | Neon Postgres (free) | Scales to zero, no 7-day pause |
| ORM | Drizzle | Lightweight, good serverless story, easy migrations |
| Auth (humans) | Auth.js v5 + GitHub OAuth, 3-email allowlist | Free, no vendor, no password handling |
| Auth (machines) | Hashed API keys in `api_keys` table | Same for MCP and n8n |
| UI | Tailwind + shadcn/ui + dnd-kit | Standard, fast to build |
| Data fetching | SWR with `refreshInterval` | Polling, optimistic drag updates |
| Card ordering | Fractional indexing (`fractional-indexing`), computed **server-side** | Move a card = one row update, no reindex |
| AI | Ollama `qwen3:4b`, JSON-mode prompts | Free, private, offline-capable |
| Automation | Existing n8n, Schedule Trigger polling | Works with local-only n8n |

---

## Data model

Tables (Drizzle schema in `src/db/schema.ts`):

- `users` — id, email, name, avatar
- `workspaces` — id, name, slug, created_by
- `workspace_members` — workspace_id, user_id, role (`owner` | `member`)
- `sprints` — id, workspace_id, name, goal, starts_at, ends_at, status (`planned` | `active` | `completed`)
- `columns` — id, workspace_id, name, position, wip_limit (nullable)
- `cards` — id, workspace_id, sprint_id (nullable = backlog), column_id, title, description, assignee_id, priority, points, position (text, fractional index), created_at, updated_at
- `comments` — id, card_id, author_id, body, created_at
- `labels` / `card_labels`
- `activity` — id, workspace_id, card_id, actor (user id or api key label), action, payload jsonb, created_at
- `api_keys` — id, workspace_id (nullable — null means the service-scoped claim key), label, key_hash, scopes, last_used_at
- `ai_jobs` — id, workspace_id, card_id, kind, status (`pending` | `claimed` | `done` | `failed`), input jsonb, result jsonb, claimed_at, attempts — **this is the queue n8n drains**

Note `ai_jobs` carries its own `workspace_id`. Do not resolve the tenant by joining through `card_id` at callback time; the job row must be self-describing.

---

## Tenant isolation rules (non-negotiable)

These are the rules that keep multi-workspace honest. They are easy to get wrong in a way that looks like working code.

**1. One scoped query, never fetch-then-check.** The tenant predicate belongs in the same query as the lookup. Child entities (`comments`, `ai_jobs`) have no workspace of their own, so the query joins up to the boundary:

```ts
const [validCard] = await db
  .select({ id: cards.id })
  .from(cards)
  .where(and(
    eq(cards.id, reqCardId),
    eq(cards.workspaceId, authWorkspaceId),   // tenant boundary, same query
  ))
  .limit(1);
if (!validCard) throw new NotFoundError();
```

The forbidden shape is `findFirst({ where: eq(cards.id, id) })` followed by a separate `if (card.workspaceId !== auth)`. It works until someone forgets the second half, and forgetting it is an IDOR that writes into another team's board.

**2. Fail closed with 404, never 403.** A 403 confirms the row exists in someone else's workspace, which turns sequential ids into a tenant enumeration oracle. Cross-boundary and not-found must be indistinguishable.

**3. The tenant id comes from the session or the API key, never from the request body or query string.** A client-supplied `workspace_id` is a hint at most, and must still be checked against membership.

---

## Machine API (`/api/v1/*`)

Shared by MCP and n8n. Bearer token, scoped to one workspace.

- `GET /workspaces`, `GET /sprints?workspace=`, `GET /board?sprint=`
- `GET /cards?sprint=&column=&assignee=&q=`, `GET /cards/:id`
- `POST /cards`, `PATCH /cards/:id`, `POST /cards/:id/move`, `POST /cards/:id/comments`
- `POST /ai/jobs/claim` and `POST /ai/jobs/:id/result` — the n8n queue endpoints (see below)
- `GET /reports/sprint/:id` — counts by column, points burned, stale cards

Responses stay small and flat; MCP and n8n both consume them raw.

### Move endpoint takes intent, not a position

Clients never compute a position string. They send neighbors:

```json
POST /api/v1/cards/8891/move
{ "column_id": 3, "prev_card_id": 55, "next_card_id": 56 }
```

The handler reads the current positions of the two neighbors and calls `generateKeyBetween` server-side. A client that computed the key itself would be computing it from board state up to 5s stale, which is how cards land in the wrong gap.

**Concurrency stance: no locking.** Two devs dropping into the same gap within the same instant both generate the same key. That is accepted. It is a duplicate key, not lost data and not a wrong column. Every ordered read therefore uses a deterministic tie-breaker:

```sql
ORDER BY position ASC, id ASC
```

`SELECT ... FOR UPDATE` on the neighbors would prevent the duplicate, and is deliberately rejected: on serverless it means blocked invocations holding pooled connections, plus real deadlock risk (`40P01`) when two moves lock overlapping neighbor pairs in different orders. That is guaranteed operational cost to prevent a cosmetic tie that three people will hit approximately never. Revisit only if devs actually report cards visibly swapping.

Separately and unrelated to concurrency: repeated drops into the same gap grow the key length. Rebalance a column's keys when the longest exceeds ~40 characters. Do the rebalance with the same `position ASC, id ASC` sort so the visible order is preserved exactly.

---

## AI features (sized for a 4B model)

Each is a short prompt with strict JSON output (`format: "json"` in the Ollama call). Do not ask a 4B model for long free-form reasoning.

1. **Draft card** — title in, description + acceptance criteria out
2. **Suggest labels + priority** — classification, the thing small models do best
3. **Rough point estimate** — description in, 1/2/3/5/8 out, always shown as a suggestion, never auto-applied
4. **Split epic into subtasks** — returns an array of titles
5. **Standup digest** — yesterday's activity rows in, 5-bullet summary out
6. **Sprint retro summary** — completed vs carried-over cards in, themes out

Flow: user clicks "AI: draft" → app inserts an `ai_jobs` row (`pending`) → n8n claims it within a minute → Ollama → `POST /ai/jobs/:id/result` → UI polling shows it. The UI must be honest that this is asynchronous (a "queued" state on the card), because it is.

### Queue auth: n8n is untrusted compute

The workspace-scoped API key model does not fit n8n. One shared workflow drains jobs for *every* workspace, so any key it holds is cross-workspace by definition. Two rejected alternatives:

- **N keys, one per workspace** — creating a 4th workspace at 11pm silently stalls its AI jobs until a human edits the n8n workflow. Onboarding becomes manual toil.
- **One god key with cross-tenant write** — if n8n is compromised, a community node misbehaves, or an execution log leaks, the attacker owns every workspace's jobs.

Instead, **per-job signed execution tokens**:

1. n8n calls `POST /ai/jobs/claim` with the service key. The handler atomically claims one `pending` row (`UPDATE ... SET status='claimed', claimed_at=now() WHERE id = (SELECT id ... FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`), and returns the job plus a token.
2. The token is an HMAC over `{ job_id, workspace_id, exp: now+15m }`, signed with a server secret. Single use.
3. n8n runs Ollama, then calls `POST /ai/jobs/:id/result` presenting the token. The handler verifies the signature and expiry, and takes `workspace_id` **from the token payload, not from the request body and not from the key**.

A leaked token is worth one job for fifteen minutes. Without this, any workspace-2 key could `POST /ai/jobs/4500/result` and inject arbitrary model output into workspace 1's card — state poisoning, not just a read leak.

**Residual risk, stated plainly:** the claim key is still one cross-workspace credential, and claiming is a write. Whoever holds it can drain the queue for every workspace and read every job's prompt and card content. Mitigate by scoping it to the claim endpoint only, rate-limiting it, and rotating it if the n8n host is ever exposed. This is the one credential in the system whose blast radius is not tenant-bounded.

`FOR UPDATE SKIP LOCKED` on the claim is correct and is not a contradiction of the no-locking stance on card moves — a work queue genuinely requires exactly-once handoff; card ordering does not.

---

## n8n workflows

Ollama runs as a separate container publishing `11434`; n8n reaches it at `http://host.docker.internal:11434`. This leaves your existing n8n container untouched — no compose migration, no volume risk.

Workflows to build:

1. **AI job runner** — Schedule Trigger (1 min) → `POST /ai/jobs/claim` (service key) → switch on `kind` → Ollama HTTP request → `POST /ai/jobs/:id/result` carrying the execution token from the claim response. On Ollama failure, post a `failed` result with the same token rather than letting the row sit in `claimed` forever; a sweeper marks jobs `claimed` for >10 min back to `pending` and increments `attempts`, failing permanently at 3.
2. **Sprint rollover** — daily → find sprints past `ends_at` → close them, move unfinished cards to the next sprint or backlog, post a summary
3. **Standup digest** — weekday mornings → `GET /reports/sprint/:id` + recent activity → Ollama summary → Discord/Slack/email to the three of you
4. **Stale card nudge** — daily → cards untouched >3 days in `In Progress` → ping assignee
5. **Git sync (optional)** — GitHub/GitLab webhook or poll → branch name containing card id moves the card to `In Review`

---

## MCP server

Location: `mcp/` in the same repo, its own `package.json`, `@modelcontextprotocol/sdk`, stdio transport. Reads `KANBAN_API_URL` and `KANBAN_API_KEY` from env — each dev uses their own key, so `activity` attributes actions correctly.

Tools: `list_workspaces`, `list_sprints`, `get_board`, `search_cards`, `get_card`, `create_card`, `update_card`, `move_card`, `assign_card`, `comment_card`.

Every tool is a thin wrapper over one API endpoint. Keep tool descriptions concrete (e.g. `move_card` states valid column names) — that is what makes Claude Code use them correctly.

Registration per dev:

```bash
claude mcp add kanban --env KANBAN_API_URL=https://your-app.vercel.app --env KANBAN_API_KEY=xxx -- node ./mcp/dist/index.js
```

A remote MCP endpoint hosted on Vercel (`mcp-handler`) is a later option — stdio is simpler and avoids the OAuth dance for three people.

---

## Build order

1. **Scaffold + DB + auth** — Next.js, Drizzle schema, Neon connection, Auth.js with GitHub and email allowlist, seed script creating one workspace, default columns, and one sprint
2. **Board UI** — workspace switcher, sprint selector, columns, cards, dnd-kit drag with optimistic update, card detail panel, comments; SWR polling at 5s
3. **Backlog + sprint management** — backlog view, create/start/complete sprint, drag cards from backlog into a sprint
4. **Machine API + API keys** — `/api/v1/*`, key generation UI in settings, activity logging
5. **MCP server** — build, register locally, verify against the deployed API
6. **Ollama + n8n** — start the Ollama container, pull `qwen3:4b`, build the AI job runner, then the scheduled workflows
7. **Deploy** — Vercel project, env vars, Neon production branch

Phases 1–4 are the real product. 5 and 6 are additive and can slip without blocking the team.

---

## Verification

- **Local**: `pnpm dev`, sign in with GitHub, seed data visible; drag a card, hard refresh, confirm the position persisted; open a second browser profile as a different user and confirm the move appears within ~5s
- **Isolation** (do these as real tests, not by eye):
  - Create a second workspace. With a workspace-2 key, `POST /api/v1/cards/<workspace-1-card-id>/comments` must return **404**, not 403, and must insert nothing
  - Same call against a card id that exists nowhere must return an identical 404 body — the two responses must be byte-identical
  - With a workspace-2 key, `POST /api/v1/ai/jobs/<workspace-1-job-id>/result` must 404 even with a well-formed payload
  - A valid execution token replayed after `exp` must 401; replayed twice inside `exp` must 409 on the second call
- **Machine API**: `curl -H "Authorization: Bearer $KEY" https://.../api/v1/board?sprint=1` returns cards; a bad key returns 401; the service claim key must be rejected on every endpoint except `/ai/jobs/claim`
- **Ordering**: fire two concurrent `POST /cards/:id/move` with identical `prev`/`next` neighbors, confirm both succeed, both land the same position string, and every subsequent read returns the same order on both clients (tie-breaker working)
- **MCP**: after `claude mcp add`, ask Claude Code "what's in my current sprint?" then "create a card X and move it to In Progress" — verify both in the browser UI
- **Ollama**: `docker exec ollama ollama run qwen3:4b "hi"` responds; then `curl http://localhost:11434/api/generate` from inside the n8n container to prove reachability
- **n8n**: queue an AI job from the UI, run the workflow manually once, confirm `ai_jobs.status` becomes `done` and the result renders on the card; then enable the schedule
- **Deploy**: Vercel preview build passes, migrations applied to Neon, all three devs can sign in

---

## Known limits to accept

- AI only works while your machine and Docker are running. Cards queue silently otherwise — the UI shows "queued", which is accurate.
- Polling means up to ~5s of staleness. Fine for three people; revisit only if it actually annoys you.
- Two simultaneous drops into the same gap produce a duplicate position key. Accepted by design — the `id ASC` tie-breaker keeps every client's view identical.
- The n8n claim key is cross-workspace. Bounded by scope and rate limit, not by tenancy. Documented above; don't let it spread to other endpoints.
- Vercel Hobby is non-commercial. If this ever becomes company work, move to a VPS with Coolify or upgrade the plan.
- A 4B model writes mediocre prose. Use it for classification and structure, treat generated text as a first draft.
