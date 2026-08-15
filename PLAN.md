# Implementation Roadmap: Conduit

> **Current Phase:** Phase 5: MCP Server Implementation
> **Status:** Phases 1–4 complete.
> **Reference Spec:** See `SPEC.md` for schema, security rules, and endpoints.

---

## Phase 1: Scaffold, DB Schema & Auth
- [x] Initialize Next.js 15 App Router with TypeScript, Tailwind CSS, and shadcn/ui.
- [x] Create Drizzle ORM schema (`src/db/schema.ts`) covering all 11 tables (`users`, `workspaces`, `workspace_members`, `sprints`, `columns`, `cards`, `comments`, `labels`, `card_labels`, `activity`, `api_keys`, `ai_jobs`).
- [x] Set up Auth.js v5 with GitHub OAuth and 3-email allowlist constraint.
- [x] Create seed script (`src/db/seed.ts`) creating default workspace, columns, and initial sprint.
- [x] **Verification:** Run `pnpm dev`, verify seed data, check DB connection.
  - `pnpm typecheck`, `pnpm lint`, `pnpm build` all clean.
  - `pnpm db:push` applied 15 tables (11 domain + `users` + 3 Auth.js) to Neon.
  - `pnpm db:seed` created workspace #1, 4 columns, 4 labels, Sprint 1 (active), 5 cards.
    Idempotent across repeat runs. Fractional index chains restart per column.
  - GitHub sign-in end to end: `POST /signin` 303, OAuth callback 302, `GET /` 200.
    Wrote one `users` row, one `accounts` row, and `workspace_members(ws#1, owner)`.
    `sessions` stays empty, confirming the JWT strategy leaves the adapter write-only.

### Phase 1 notes
- Seed env loads via `tsx --env-file=.env.local`, not `dotenv` inside `seed.ts`: ES module
  imports are hoisted, so an in-file `config()` runs after `@/db` has read `process.env`.
- Seed sets `process.exitCode` instead of calling `process.exit(0)`, which raced tsx's
  loader teardown on Windows and aborted with a libuv assertion after a clean run.
- `events.signIn` catches its own errors. `@auth/core` bare-awaits it before returning
  session cookies, so a throw there aborts sign-in entirely with `?error=Configuration`,
  even for users who already have a membership row.
- Known gap, deferred: the `ALLOWED_EMAILS` allowlist is enforced only in the `signIn`
  callback. Removing an address blocks new logins but not a live JWT, and `updateAge`
  re-issues on activity, so an active session never ages out. Closing it means checking
  the allowlist (or `workspace_members`) in the `jwt` callback. Natural fit for Phase 4.

---

## Phase 2: Board UI & Server-Side Drag-and-Drop
- [x] Build workspace switcher, sprint selector, columns, and cards UI.
- [x] Integrate `dnd-kit` for drag-and-drop with optimistic updates.
- [x] Set up SWR polling with 5-second `refreshInterval`.
- [x] Implement `POST /api/v1/cards/:id/move` taking neighbor intent (`prev_card_id`, `next_card_id`) and running `generateKeyBetween` server-side.
- [x] Handle equal neighbor positions in the move handler. SPEC line 133 calls a duplicate
      position key "a cosmetic tie" — it is not. Once two cards share a position,
      `generateKeyBetween(a, a)` throws, the route 500s, and the optimistic drag rubber-bands.
      A slot between two equal keys is un-representable, since only `id` separates them.
      Detect `prev.position === next.position` and rebalance the column before computing,
      rather than letting the accepted duplicate arm a latent 500.
      Note the thrown message is `" >= "` — both operands are empty. `fractional-indexing`
      throws from `midpoint()` on the *fractional* remainder, and a short key like `a5` is
      all integer part with nothing after it. So this failure carries no card id, no key,
      and nothing greppable in a production log. Verified by `pnpm verify:ordering`.
- [x] Enforce `ORDER BY position ASC, id ASC` sorting on card queries.
- [x] Build Card Details slide-over panel with Markdown comments.
- [x] **Verification:** Verify move endpoint updates DB; test multi-browser sync under 5s polling.
  - `pnpm verify:ordering` — 10 checks. Proves `generateKeyBetween(a, a)` throws, that the
    move path rebalances instead, that displayed order is preserved exactly, that the new
    key sorts strictly between the two former duplicates, and that inverted neighbors are
    refused rather than guessed at.
  - `pnpm verify:api` — 15 checks over HTTP against `pnpm dev`. Mints a session cookie with
    the app's own AUTH_SECRET so middleware, auth, and the tenant guards are all exercised.
    Covers 401 when anonymous, ordered board reads, a real move persisting to the database,
    and 400/404 refusals with byte-identical 404 bodies.
  - Browser: drag moved card #2 across columns, `POST /cards/2/move` returned 200, server
    computed key `Zz` (correctly ahead of `a0`), database and UI agree. Card panel opens,
    comments post and render as Markdown, and a raw-HTML payload stays inert text.

### Phase 2 notes
- SWR pauses `refreshInterval` while `document.visibilityState === "hidden"`, and skips the
  mount revalidation because `fallbackData` is supplied by the server render. A background
  tab therefore issues zero polls, which is the behavior we want on Neon's free tier.
  Verified live by dispatching `focus` and watching the revalidation land.
- `@auth/core` is a direct devDependency pinned to 0.40.0 to match what next-auth resolves.
  `scripts/verify-api.ts` imports its `encode`, and pnpm's strict layout will not resolve a
  transitive package from application code.
- `rebalanceColumn` is one `UPDATE ... FROM (VALUES ...)` statement. neon-http has no
  interactive transaction, so a per-row loop would be N unrelated HTTP requests with no
  atomicity — a partial rebalance is worse than the duplicate key it set out to fix.
- Comment bodies render through react-markdown with no `rehype-raw`. Do not add it.

---

## Phase 3: Backlog & Sprint Management
- [x] Build Backlog view and UI for moving cards between backlog and sprints.
- [x] Implement Sprint management UI (Create, Start, Complete sprints).
- [x] Build card filtering by column, assignee, and priority. Filtering is a render-time
      derivation only: the full board payload stays whole in memory, and a drop is still
      resolved against the unfiltered list. Anything else silently corrupts ordering —
      see the Phase 3 notes.
- [x] **Verification:** `pnpm build` succeeds without type errors.
  - `pnpm verify:ordering` — 14 checks, now including board/backlog scope independence.
  - `pnpm verify:sprints` — 25 checks over HTTP: create, validation, the one-active-sprint
    rule, byte-identical 404s on unknown sprint ids, a card dragged to the backlog and back,
    completion with carry-over, and the double-complete and carry-to-self refusals.
  - `pnpm verify:api` — 15 checks, re-run after the move endpoint was reworked.
  - `pnpm verify:filters` — 38 checks. Pure functions, so it needs neither the dev server
    nor the database. Proves the filter predicates, proves that a drop under a filter
    hands the server a pair that is *adjacent in the full list* — including that the pair
    the visible list would have produced is not — and proves no legal move can hide a card
    that was visible.
  - Browser: card dragged into the backlog rail and back, sprint created through the form,
    and the 409 surfaced as readable copy rather than a raw status.
  - Browser, filtering: with two of four cards hidden in a column, a card dropped on the
    last visible one landed at `a3V`, strictly between the hidden `a3` and the visible
    `a4`; the hidden rows kept their keys. Dragged to the backlog and back under the same
    filter. Created a sprint with a filter active — the dialog closed, the navigation
    landed, and the filter survived it.

### Phase 3 notes
- Position keys are scoped to what is displayed together, not to a column. A column holds
  cards from every sprint plus the backlog, so `OrderScope` is either
  `{ board, columnId, sprintId }` or `{ backlog }`. Sharing one space across sprints would
  make relative keys meaningless and let one sprint's rebalance rewrite another's rows.
- `sprint_id` belongs on the move endpoint rather than a separate assign call: dropping a
  card into the backlog still needs a position within the backlog. Omitted leaves the sprint
  alone, explicit null means the backlog.
- Sprint completion treats the right-most column as done. That is a convention, not a schema
  fact — there is no done flag on `columns` — so it is derived from `position`, not from a
  name match on "Done" that a rename would silently break.
- `createSprint` and `completeSprint` wrap their dialog close in `flushSync`. `router.replace`
  runs inside a transition, and a pending transition defers every other queued update, so the
  dialog stayed on screen while its portal was torn down by the navigation. Found in the
  browser, not by any type or lint check.
- base-ui triggers ignore synthetic `.click()`. Browser checks against dialogs and selects
  need real pointer events, or they report a false failure.
- A filter must never reach the move path. A move sends neighbour ids, and nothing
  downstream requires them to be adjacent: `cards/[id]/move` checks only that both
  neighbours exist and sit in the destination scope, and `computePosition` only refuses
  when `prev >= next`. So a pair taken from a filtered list is accepted, and the card
  lands at an arbitrary point inside the hidden run. Measured: with `a0 a1 a2 a3` and the
  middle two hidden, the visible pair mints exactly `a1` — a duplicate of a hidden row,
  re-arming the Phase 2 trap. `resolveDrop` therefore takes the unfiltered list, and
  `verify:filters` asserts the resulting pair is adjacent for every drop target.
- The filter anchors to the card under the pointer, so a drop "between" two visible cards
  lands past the whole hidden run rather than before it. Anchoring to the visible card
  above would be equally well defined but would stop matching an unfiltered drag; both
  yield an adjacent pair, which is the property that matters.
- Filter state is `useState`, deliberately not a URL param. Putting it in the URL means a
  `router.replace` per chip, and that re-runs the page server component — a database
  round-trip to re-render a list the client already holds.
- Column and rail counts read `visible / total`, and a WIP breach is computed from the
  total. A filter that could switch off a WIP warning would be a filter that lies.
- `DndContext` now has an explicit `id`. dnd-kit's fallback comes from a module-global
  counter that survives between requests on the server, so the `aria-describedby` it
  stamps on every card drifted out of step with the client's and failed hydration.
  Pre-existing and dev-only — confirmed against the previous commit, where the server was
  handing out `-3` while the client sat at `-2`. Note `useUniqueId(prefix, value)` returns
  `value` verbatim, so the attribute becomes `"board"`, not `"DndDescribedBy-board"`.
- There is deliberately no "your card is now hidden" notice, because a visible card cannot
  be dragged out of sight. To be dragged at all it must be visible, so `matchesCard` is
  already true and its column is rendered; a move changes only `column_id` and `sprint_id`,
  never priority or assignee; and the only drop targets are columns the filter is showing,
  or the rail, which the column filter never touches. Written and then reverted once —
  `verify:filters` now asserts the invariant across every filter shape and destination, so
  if a future filter dimension keys on something a move *can* change, the check fails and
  the notice becomes necessary.

### Carried into Phase 4
- **`DndContext` renders no accessibility DOM on the board page.** Every card carries
  `aria-describedby="board"`, and no element with that id exists, so screen readers get no
  drag instructions. Measured, not inferred: no `display:none` div, no `[aria-live]`, no
  `[role="status"]`, and the instruction string is absent from `innerHTML`.
  Not dnd-kit's fault and not caused by the `id` pin — a throwaway route with a bare
  `DndContext` renders `#DndDescribedBy-0` plus `#DndLiveRegion-0` correctly, and still
  does after being given the board's exact `id` / `sensors` / `collisionDetection` /
  handler / `DragOverlay` configuration, where the target resolves as `<div id="board">`.
  So the suppression comes from something in the board page's composition — the `Suspense`
  boundary, SWR, or the card panel — and `Accessibility` bails at its only `return null`,
  meaning `mounted` never flips. Do not paper over this by hand-rendering a
  `<div id="board">`: dnd-kit renders its own element with that exact id, so the two would
  collide the moment the underlying cause is fixed.

---

## Phase 4: Machine API & Tenant Isolation
- [x] Build REST API endpoints under `/api/v1/*` (`/workspaces`, `/sprints`, `/board`, `/cards`, `/reports`).
      Added `GET|POST /cards`, `GET|PATCH /cards/:id`, `GET /reports/sprint/:id`, and `/keys`.
- [x] Build API Key management UI in settings with hashed keys in `api_keys`.
- [x] Enforce Tenant Rule 1: Single query join up to workspace boundary.
- [x] Enforce Tenant Rule 2: Fail closed with `404 Not Found` (never 403) on cross-tenant requests.
- [x] Implement activity logging for machine and human actions.
- [x] **Verification:** Run cross-tenant checks (byte-identical 404 on invalid vs unauthorized ids).
  - `pnpm verify:tenant` — 44 checks over HTTP. Stands up a second workspace with its own key,
    then reaches for the first workspace's rows with it: every route 404s, every body is
    byte-identical to a genuinely missing id, and nothing is written. Also covers the
    revoked key, the unknown key, the service key, the `?workspace=` and body-`workspace_id`
    hints, and that a Bearer key cannot reach key management.
  - `verify:api`, `verify:sprints`, `verify:ordering`, `verify:filters` all still green.

### Phase 4 notes
- `Actor` is a union, and that is what made the migration safe. Widening it broke every
  route that reached for `actor.userId` to prove tenancy — six compile errors that were
  each a real hole, not a chore. They are now `loadCardForActor` / `loadSprintForActor`,
  which carry the boundary in the primary statement for both credential kinds.
- `resolveActor(request)` takes the request as a *required* argument. An optional one would
  let a route silently lose Bearer support by forgetting to pass it. Server components use
  `resolveSessionActor()`, which has nothing to forget.
- A service-scoped key (`workspace_id IS NULL`) resolves to null, so every route built on
  `resolveActor` refuses it. The Phase 6 claim endpoint will get its own resolver. The
  exemption is opt-in rather than something each route has to remember to exclude, and the
  predicate lives in the lookup query rather than in a check after it.
- Key lookup is a single `UPDATE ... RETURNING` that authenticates and stamps `last_used_at`
  at once, rather than a select followed by a write — one round trip instead of two on
  every machine request.
- Keys are stored as a plain SHA-256 digest. bcrypt and argon2 exist to slow down guessing
  a *low-entropy* secret; this one is 256 bits from a CSPRNG, so a work factor would only
  make every authenticated request cost the server CPU.
- `/api/v1/keys` uses `resolveSessionActor`, so a Bearer token cannot list, mint, or revoke
  keys. A machine credential able to issue further credentials turns one leaked key into
  self-renewing access that revoking the original would not end.
- `PATCH /cards/:id` deliberately refuses `column_id`, `sprint_id` and `position`. Moving is
  `POST /cards/:id/move`, which takes neighbour intent; accepting a column on the patch
  would be a second way to move a card, and the one that skips the ordering machinery.
- Assignees are checked against `workspace_members` before a write. Without it a caller
  could pin a card to any user id in the system, which both reveals whether that id exists
  and puts a stranger's name on a tenant's board.
- `q=` escapes `\`, `%` and `_` before going into `ILIKE`, so a search for "100%" is a
  search for a literal "100%" and not for everything.
- `logActivity` swallows its own failures. A move that succeeded but went unlogged is a gap
  in history; a move rolled back because its log row failed is lost work.
- `pnpm build` now writes to `.next-build` instead of `.next`. Building while `pnpm dev` was
  running left the dev server serving half-replaced chunks, and every route returned a 500
  that read like an application bug. It cost three separate debugging detours across
  Phases 2–4 before being fixed at the source.
- The `security-auditor` pass over all eleven routes and the shared guards found no
  violation of the tenant rules: no fetch-then-check, no 403 anywhere in the API surface,
  no `workspace_id` reaching a query from a body or query string without being re-derived
  from the credential, and `q=` not injectable at either the SQL or the LIKE-wildcard level.
  Two things it raised that are not violations:
  - `api_keys.scopes` is written as `[]` and read by nothing. It is dead authorisation
    surface: harmless today because it grants nothing, but it must either be enforced or
    removed before scopes are described anywhere as a real restriction. Carried below.
  - `GET /cards/:id` and the comments GET run a second read keyed on the card id after
    `loadCardForActor` has already proven tenancy. That is enrichment on an id already
    established as safe, not a second boundary — and no write depends on it.

### Carried into Phase 5+
- `api_keys.scopes` grants nothing and is checked nowhere. Enforce it or drop the column.
- The `ALLOWED_EMAILS` allowlist is still only enforced in the `signIn` callback, so
  removing an address does not end a live JWT and `updateAge` re-issues on activity. Now
  more visible than it was: a person removed from the allowlist also keeps every API key
  they created, since a key's validity is independent of its creator's.
- `DndContext` renders no accessibility DOM on the board page — see the Phase 3 note.

---

## Phase 5: MCP Server Implementation (`mcp/`)
- [ ] Scaffold `@modelcontextprotocol/sdk` stdio server in `mcp/` directory.
- [ ] Implement tools: `list_workspaces`, `list_sprints`, `get_board`, `search_cards`, `get_card`, `create_card`, `update_card`, `move_card`, `assign_card`, `comment_card`.
- [ ] Wire tools to wrap REST API endpoints using `KANBAN_API_KEY`.
- [ ] **Verification:** Register in local `.mcp.json` and test tool execution from Claude Code.

---

## Phase 6: Asynchronous AI Queue & n8n
- [ ] Build `POST /api/v1/ai/jobs/claim` using `FOR UPDATE SKIP LOCKED` and return 15-min HMAC token.
- [ ] Build `POST /api/v1/ai/jobs/:id/result` validating HMAC execution token.
- [ ] Deploy/configure Ollama container running `qwen3:4b`.
- [ ] Configure n8n polling workflow (1-min schedule) to claim jobs, run Ollama, and submit results.
- [ ] **Verification:** Queue draft job in UI, run n8n workflow, verify card updates asynchronously.