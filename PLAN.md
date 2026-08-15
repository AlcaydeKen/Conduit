# Implementation Roadmap: Conduit

> **Current Phase:** Phase 7: closing the gap between the API and the UI
> **Status:** Phases 1–6 complete; the queue has run end to end against a live n8n and
> Ollama. Phase 7 round 1 is done — the board can now create, edit, search and audit cards
> from the browser, which it could not before.
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
- **Correction: the accessibility DOM was never missing.** An earlier note here recorded
  that `DndContext` rendered no hidden ARIA elements on the board page — no `display:none`
  instructions div, no live region — and carried it forward for three phases. It was wrong.
  Re-measured on a clean dev server, `#board` is present and holds the screen-reader
  instructions, `aria-describedby` resolves to it, and `#DndLiveRegion-0` is there with
  `role="status"`. The original readings were taken while `pnpm build` was clobbering
  `.next` underneath a running `pnpm dev`, which is the same root cause as the phantom
  500s in Phase 4 — diagnosed correctly there and not applied here. A measurement taken
  against a half-replaced bundle is not evidence, and "verified in the browser" is worth
  nothing if the browser was served stale chunks.
- Drag announcements are explicit. dnd-kit's defaults name things by id — "Draggable item
  3 was moved over droppable area column:2" — which is precisely the information a screen
  reader user lacks. Ours say the card's title and the column's name. There is deliberately
  no hand-rendered `<div id="board">`: dnd-kit renders its own with that id, and a second
  would point one `aria-describedby` at two nodes.

---

## Phase 4: Machine API & Tenant Isolation
- [x] Build REST API endpoints under `/api/v1/*` (`/workspaces`, `/sprints`, `/board`, `/cards`, `/reports`).
      Added `GET|POST /cards`, `GET|PATCH /cards/:id`, `GET /reports/sprint/:id`, and `/keys`.
- [x] Build API Key management UI in settings with hashed keys in `api_keys`.
- [x] Enforce Tenant Rule 1: Single query join up to workspace boundary.
- [x] Enforce Tenant Rule 2: Fail closed with `404 Not Found` (never 403) on cross-tenant requests.
- [x] Implement activity logging for machine and human actions.
- [x] **Verification:** Run cross-tenant checks (byte-identical 404 on invalid vs unauthorized ids).
  - `pnpm verify:tenant` — 74 checks over HTTP. Stands up a second workspace with its own key,
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

- `activity.actor` records `key:<id>` for a machine, never the key's label. The label is
  free text its creator chose, and a user actor is recorded as a bare user id — so a member
  could mint a key labelled with a colleague's user id and have everything it did attributed
  to them. `key:<id>` cannot collide with a user id, and it identifies the key rather than a
  name that is neither unique nor stable across revoke-and-recreate. Reading the log now
  needs a join to `api_keys` to show something human, which is the same indirection a user
  id already needs.

- `api_keys.scopes` is enforced. `board:read`, `board:write` (which implies read), and
  `ai:claim`. The scope is a **required argument of `resolveActor`**, which returns
  `{ok: true, actor}` or `{ok: false, response}` — so a route cannot obtain an `Actor`
  without having said what it is for. The first version exported a separate `requireScope`
  that each route called, which was the wrong shape for the same reason an optional
  `request` would have been: omitting it was valid TypeScript and produced a working,
  silently unscoped endpoint. Omitting the scope is now `TS2554`, verified by compiling a
  throwaway route that leaves it out. Settings can mint a read-only key, because a scope nobody can choose is
  the same dead surface under a new name.
  - **Scope failures are 403, and that does not contradict the 404 rule.** Tenancy answers
    "does this row exist for you" and must be 404, because separating "absent" from
    "someone else's" turns sequential ids into a tenant directory. A scope answers "may
    this credential do this at all" — a fact about the caller's own key that reveals
    nothing about anyone else's data. The check runs *before* any row is loaded, so a 403
    can never depend on what exists; `verify:tenant` asserts that a read-only key writing
    to another tenant's card gets 403 on scope, not 404 on tenancy.
  - Enforcement is a breaking change for keys minted before it. `scripts/migrate-key-scopes.ts`
    backfills `[]` to full workspace access, or `ai:claim` for a workspace-less key, and is
    idempotent. Anything that inserts into `api_keys` directly — the verify scripts, the
    `ops/README.md` SQL — must now supply scopes.

### Carried into Phase 5+
- **A key is a delegation of its creator's access, decided rather than inherited.** Key
  authentication now carries an `EXISTS` against `workspace_members` for `created_by`, in
  the same statement that looks the key up, so removing someone from a workspace stops
  every key they minted on the next request.
  - The alternative — revoking keys from a membership-removal handler — cannot work here:
    there is no member-management endpoint, so removal is a manual `DELETE`, and a cleanup
    hook would sit in a function nothing calls. Putting the question inside authentication
    is the only version that cannot be skipped, whatever route the removal takes.
  - Nothing is written on removal. `revoked` stays false and membership is the source of
    truth, so restoring a membership restores the keys — verified. A key that was
    deliberately revoked stays revoked, because that is a separate column.
  - **A missing creator is a dead key, not a system key.** The first cut carved out
    `created_by IS NULL` as "nobody to offboard". That inverted the model, because
    `created_by` is `ON DELETE SET NULL`: removing someone's *membership* killed their keys,
    while deleting their *account* nulled the column and so preserved them — scrubbing the
    provenance in the same motion. The more drastic administrative act produced the weaker
    outcome. Requiring a live creator makes that FK behaviour fail closed, and both removals
    now end the key. `verify:tenant` asserts the account-deletion path explicitly by nulling
    `created_by` directly.
  - Consequence: every workspace key needs a creator who is a current member, including ones
    minted by hand in SQL. Service keys are unaffected — no workspace, and they authenticate
    through `resolveClaimKey`.
  - Cost: one `EXISTS` on a primary-key index per machine request, folded into the existing
    statement rather than added as a second round trip.
- `activity` is readable: `GET /api/v1/activity` and an Audit log table in settings. It
  resolves each `actor` per namespace — a user id to a name and avatar, `key:<id>` to the
  key, `job:<id>` to the AI job — and always shows the key **id** beside its label, never
  the label alone. That is the point of the namespacing: a key labelled with a colleague's
  user id still reads as `key #7`, and `verify:tenant` asserts it by minting exactly such a
  key and checking the log resolves it to its own id.
  - Keyset pagination on `activity.id`, not an offset. On an append-only log an offset
    silently repeats or skips rows as new ones land while someone is reading.
  - A deleted user or a deleted key still resolves — as the bare id, or "deleted key". The
    log outlives its subjects on purpose, so an entry is never dropped from history because
    the thing it refers to is gone.
  - **A key actor never sees `api_key.*` entries.** `/api/v1/keys` is session-only so a
    machine credential cannot enumerate credentials, and this endpoint would have handed
    over the same inventory by another route: `api_key.create` carries
    `{key_id, label, scopes}`, so diffing creates against revokes rebuilds the live list
    including which key holds write access. The filter is on the read, not on
    `logActivity`, because a *member* reading the log is exactly who should see who minted
    what — redacting at write time would destroy that for everyone to withhold it from
    machines. Both halves are asserted: a key sees no `api_key.*` but still sees `card.*`,
    and a session sees the `api_key.create` event a key is denied.
- The `ALLOWED_EMAILS` allowlist is still only enforced in the `signIn` callback, so
  removing an address does not end a live JWT and `updateAge` re-issues on activity. Now
  more visible than it was: a person removed from the allowlist also keeps every API key
  they created, since a key's validity is independent of its creator's.

---

## Phase 5: MCP Server Implementation (`mcp/`)
- [x] Scaffold `@modelcontextprotocol/sdk` stdio server in `mcp/` directory.
- [x] Implement tools: `list_workspaces`, `list_sprints`, `get_board`, `search_cards`, `get_card`, `create_card`, `update_card`, `move_card`, `assign_card`, `comment_card`.
- [x] Wire tools to wrap REST API endpoints using `KANBAN_API_KEY`.
- [x] **Verification:** Register in local `.mcp.json` and test tool execution from Claude Code.
  - `pnpm verify:mcp` — 28 checks. Mints a throwaway key, spawns the built
    `mcp/dist/index.js` over stdio, and drives all ten tools through a real MCP client:
    tool list, reads, the full write path, and that failures arrive as tool errors rather
    than crashes. Requires `pnpm dev` and `pnpm mcp:build`.

### Phase 5 notes
- The verification drives the **built bundle**, not the source. The bundle is what gets
  registered, so a build that drops an import has to fail here rather than in someone's
  editor a week later.
- `mcp/` is a pnpm workspace package (`packages: ["mcp"]`), so one `pnpm install` at the
  root covers both. It bundles with esbuild to a single ESM file, which means
  `node ./mcp/dist/index.js` works from any cwd without resolving `node_modules`.
- Diagnostics go to stderr. stdout is the protocol channel, and a stray `console.log`
  corrupts the stream — which is why `readConfig` throws with the registration command in
  the message instead of printing advice.
- Tool descriptions state that a card in another workspace and a card that does not exist
  return the same error. Without that, a model reads 404 as an invitation to try nearby
  ids, and turns a deliberately silent boundary into an enumeration loop.
- `move_card` advertises neighbour intent and has no `position` in its schema, and
  `verify:mcp` asserts both. `update_card` refuses column and sprint for the same reason —
  two tools that can move a card would mean one of them skips the ordering machinery.
- `assign_card` and `update_card` share `PATCH /cards/:id` deliberately. Assignment has a
  distinct failure mode — a user who is not a member of the workspace — and folding it into
  a general edit hides that from the model.
- `dist/` is gitignored. `.mcp.json` is committed but holds no secret: it reads
  `KANBAN_API_URL` and `KANBAN_API_KEY` from the environment.

---

## Phase 6: Asynchronous AI Queue & n8n
- [x] Build `POST /api/v1/ai/jobs/claim` using `FOR UPDATE SKIP LOCKED` and return 15-min HMAC token.
- [x] Build `POST /api/v1/ai/jobs/:id/result` validating HMAC execution token.
- [x] Deploy/configure Ollama container running `qwen3:4b`. *(`ops/ollama.compose.yml`, up
      and serving on 11434; reachability proven from inside the n8n container, which is the
      check that matters — the model answering on the host says nothing about that)*
- [x] Configure n8n polling workflow (1-min schedule) to claim jobs, run Ollama, and submit
      results. *(`ops/n8n-ai-job-runner.json` imported and published; claim key minted with
      `pnpm claim-key:mint`)*
- [x] **Verification:** Queue draft job in UI, run n8n workflow, verify card updates
      asynchronously. *(job #87 on card #3: enqueued from the drawer, claimed by n8n,
      generated by `qwen3:4b`, written back on the signed token, rendered in the open
      drawer without a reload)*
  - `pnpm verify:queue` — 45 checks over HTTP. Exactly-once handoff, the poll floor, a
    workspace key refused on both endpoints, forged and expired tokens, a token presented
    against another job, the replay conflict, the fencing case below, and the sweeper's
    requeue-then-fail path.

### Phase 6 notes
- The claim is one statement, and it has to be. neon-http gives every statement its own
  transaction, so `SELECT ... FOR UPDATE SKIP LOCKED` followed by a separate `UPDATE` would
  release the lock between the two and hand the same job to two runners. The locking select
  is nested inside the update instead.
- `SKIP LOCKED` here does not contradict the no-locking stance on card moves. A work queue
  genuinely needs exactly-once handoff; card ordering does not, and would pay for locks it
  cannot benefit from.
- `POST /ai/jobs/:id/result` accepts **no API key at all**, not even a valid workspace one.
  n8n drains the queue for every tenant, so any credential it holds is cross-workspace by
  definition — if a key could authorise this call, a workspace-2 key could post a result
  onto a workspace-1 job and inject model output into another tenant's card. The tenant
  comes from the signed token payload: not the body, not the URL, not the credential.
- Single use is enforced by `status = 'claimed'` in the update's WHERE, so the first result
  moves the row out of reach and a replay matches nothing. No separate nonce table.
- **The token is a fencing token.** It carries the claim generation — `attempts` at the
  moment of the claim — and the result update matches on it. Status alone was not enough:
  the sweep threshold is ten minutes and the token lives fifteen, so a runner that is slow
  rather than dead outlives its own claim. Its job gets swept back to `pending`, another
  runner picks it up, and the first runner's token is still signed and unexpired. Matching
  only on `status = 'claimed'` let the *superseded* runner write over the live claim, and
  the legitimate runner then got the 409 — the zombie won and the live runner was refused.
  Clamping the TTL below the sweep threshold would also close it, but would refuse slow
  runs nobody superseded; fencing accepts a result whenever the runner still holds the
  claim and refuses it exactly when it does not. A superseded runner now gets
  `job_reclaimed`, distinct from `job_already_resolved`, because "you ran twice" and "you
  ran too slowly and lost the job" are different operator problems.
- The signature is checked *before* the payload is parsed. Parsing attacker-controlled JSON
  first would mean deciding what to do with a payload there is no reason to trust.
- `AI_JOB_SECRET` is separate from `AUTH_SECRET` deliberately: rotating one must not
  invalidate the other, and a queue token and a session cookie must not be forgeable from
  the same stolen value.
- A rate-limited poll answers 429, not 401. Conflating them would send an operator hunting
  a credential problem that does not exist. The floor is enforced inside the authenticating
  statement so two racing requests cannot both pass it.
- The sweeper runs inside the claim handler rather than as its own cron. The runner polls
  every minute anyway, so a job whose runner died is retried — or failed permanently at the
  fourth attempt — the next time anyone asks for work.
- Postgres 42804: a `CASE` over two bare enum literals is typed `text` and will not assign
  to an enum column. Both branches need `::ai_job_status`. Found at runtime, not by
  typecheck — Drizzle's `sql` template is opaque to it.

### Carried into Phase 6 completion
- The card drawer now has a "Generate AI draft" button, `POST /api/v1/ai/jobs` to enqueue,
  and `GET /api/v1/ai/jobs?card=` for the drawer to poll. The workspace comes from the card,
  proven in the same statement that loads it — never from the body — because that id is what
  the result callback's signed token is later minted from.
- One open job per card and kind, enforced by a **partial unique index**
  (`ai_jobs (card_id, kind) WHERE status IN ('pending','claimed')`) plus
  `onConflictDoNothing`, not by a check in the route. The select-then-insert this replaced
  was a TOCTOU: two overlapping clicks both saw an empty result and both inserted, so the
  guard held for sequential clicks and failed for the case it existed for. Partial, so
  finished jobs accumulate freely — the constraint is on what is outstanding, not on the
  card's history. `verify:queue` fires two genuinely concurrent requests and asserts exactly
  one 200, one 409, and one surviving row.
- A finished job is shown in the drawer, **not** written to the card. A model should not
  silently overwrite a human's description; applying a draft should be a separate,
  deliberate action.
- **Verified in the browser, including the done state.** The button enqueues, the badge shows
  "Queued", the button disables while a job is open, and the draft replaces the spinner on
  its own when the job settles. That last one held up the longest for a reason unrelated to
  the code: SWR suspends `refreshInterval` while `document.visibilityState === "hidden"`, and
  an automation-driven tab is always hidden, so it could only ever be confirmed from a
  human-driven tab. Focus-dispatch is not a workaround — focus revalidation is gated on
  visibility too.

### What the live run cost, and what it changed

- `ops/n8n-ai-job-runner.json` has now been imported into a live instance. Three things only
  that could surface:
  - A hardcoded credential id imports as a *dangling reference*, not an empty field — n8n
    fails the node with "Credentials not found". The JSON now carries no credential and the
    importer selects it.
  - `Anything to do?` branched on `body.job.id` existing. A 401 has no `body.job` either, so
    an unauthenticated runner took the same branch as an idle one and reported a clean green
    execution every minute while the queue filled. `Claim accepted?` now tests
    `statusCode === 200` first and a `stopAndError` carries the status and body. 429 is in
    scope on purpose: the 5s poll floor tripping on a 1-minute schedule means two runners
    share a credential.
  - The job's `input` was `{}`, so the prompt described a card the model had never seen. The
    enqueue now embeds the title and description from the row `loadCardForActor` proved,
    server-side — see the note on self-describing rows above; the runner holds a claim-only
    credential and *cannot* read a card.
- `qwen3:4b` on CPU: ~2m10s for ~850 tokens. Inside the node's 8-min timeout and the server's
  10-min sweep, but that is the real per-job cost, not the tens of seconds a warm GPU suggests.
- Leave Ollama's thinking **on**. `think: false` is accepted, but qwen3 reasons regardless and
  emits it into `response` instead of `thinking` — 991 tokens of "We are writing a clear task
  description…" that would have landed in the card. With it on, Ollama separates the two.
- `pnpm queue:status` is the server's own view: `last_used_at` moves only on a successful
  authenticate, so it is evidence a green n8n execution is not.
---

## Phase 7: closing the gap between the API and the UI

The audit that started this phase found the barebones feeling was not a missing-features
problem. `POST /cards`, `PATCH /cards/:id` and `?q=` search were all written, validated and
tenant-safe, and nothing in `src/components/` called any of them — a human could not add a
card to their own board without minting an API key.

### Round 1 — done

- [x] Card create: an inline composer in every column header and the backlog rail. Title
      only; everything else is editable the moment the card exists. No `position` is sent —
      the create route owns key generation exactly as the move route does.
- [x] Card edit in place in the drawer: title, description, priority, points, assignee.
      `PATCH` still refuses `column_id`, `sprint_id` and `position`, so ordering keeps one
      entry point.
- [x] `GET /api/v1/members` — read-only, no email. Without it the assignee picker could only
      offer people who already held cards, which is exactly nobody on a new workspace.
- [x] Search as a fourth filter dimension, client-side over the loaded payload.
- [x] `KeyboardSensor`, so the drag announcements written in Phase 3 reach someone who can
      act on them. Empty columns *are* reachable, contrary to the note first written here:
      `sortableKeyboardCoordinates` walks every registered droppable rather than the sortable
      items, and each column registers one. Browser first, then the implementation — the
      original claim came from reasoning alone and was wrong.
- [x] Per-card history in the drawer, via `?card=` on the activity route.
- [x] Collapsible columns, and the column grid became a flex row so collapsing reclaims width.
- [x] `restrictToWindowEdges` and a drop animation that stops the overlay flickering.

### Notes

- **Search had to be a filter, not a fetch.** A server-backed search returns a *different
  list of cards*, and a move computed against that list sends neighbour ids that are not
  neighbours. As a filter it inherits the Phase 3 rule for free: `allCards` stays whole and
  `resolveDrop` runs against the unfiltered list. `verify:filters` now carries a query in
  the "no legal move can hide a card" sweep, which is what that check was written for.
- **`ActorCell` is shared** between the settings audit log and the drawer. It carries a rule,
  not a layout: a key is shown by id, never by label alone, because a label is free text its
  creator chose. Two copies would be two places to relax it.
- **`GET /members` is deliberately not member management.** An API key is a delegation of its
  creator's membership and expires with it, enforced in `resolveKeyActor` on every
  authenticate. Adding or removing a member stays a hand-written SQL statement precisely so
  nothing depends on an application code path having fired.
- **`verify:queue` was unsafe to run against a live queue, and did real damage.** The claim
  endpoint hands out the oldest pending job across every workspace — correct, one runner
  serves all tenants — so the suite cannot ask for its own. A run claimed card #2's real
  queued draft, wrote `[queue-verify] model output` over it, and failed its own "the job is
  one of ours" check; the following run passed because the evidence had been consumed. It now
  refuses to start while any job is outstanding. Aborting rather than draining: draining
  destroys the same work more politely, and filtering claims client-side cannot help, because
  by the time a claim returns the job has been handed out and its attempt counter bumped.

### Round 1b — partial edits

- [x] The edit form sends only the fields that changed, diffed against a snapshot taken when
      the form opened rather than against the live `card` prop — the board polls every five
      seconds, so the prop moves under an open form whenever anyone else touches the row.
- [x] `PATCH` refuses a body naming no editable field. Every field is optional, so `{}` and
      `{"position": "zzz"}` both parsed and reached the UPDATE as `SET updated_at = now()`:
      a write that changed nothing, bumped the column any future concurrency check would key
      on, and appended an empty `card.update` to the card's history.

This is not concurrency control. Two people editing the same field still race and the last
writer wins. What it removes is clobbering a field you never touched — the case that happens
by accident. Real optimistic locking is harder here than usual because `POST /cards/:id/move`
also writes `updated_at`, so an unrelated drag would 409 an edit; a version token would have
to be scoped to editable fields, which is most of this diff again.

It also makes the audit log honest as a side effect: `card.update` records `Object.keys(body)`
and nothing else — no before, no after — so a full-form submit reported all five fields as
edited every time, and a clobbered title left no trace of its old value anywhere.

### Not done, in priority order

- Labels are still half-built: schema, join table, board payload and both render paths exist,
  and nothing can create or attach one.
- No card removal. Archive (`cards.archived_at`), not delete — `comments`, `activity` and
  `ai_jobs` all reference cards and `activity` cascades.
- Due dates, column management, checklists. Then swimlanes, bulk actions, a command palette.
- Column sorting is declined, not deferred: sort order and drag order are the same axis, so a
  sorted board cannot honour a drop without rewriting the sort key or discarding the drop.
- Cover images are declined: blob storage that does not exist, on Hobby, for three people.
