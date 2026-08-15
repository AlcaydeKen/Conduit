# ops

The two pieces of Phase 6 that run on your machine rather than in this repo.

## 1. Ollama

```bash
docker compose -f ops/ollama.compose.yml up -d
docker exec conduit-ollama ollama pull qwen3:4b
docker exec conduit-ollama ollama run qwen3:4b "hi"
```

Then prove n8n can reach it. This is the check that actually matters — the
model answering on the host says nothing about the n8n container being able to
see it:

```bash
docker exec <n8n-container> curl -s http://host.docker.internal:11434/api/tags
```

## 2. The AI job runner workflow

Import `n8n-ai-job-runner.json`, then set two environment variables on the n8n
container:

| Variable | Value |
| --- | --- |
| `CONDUIT_API_URL` | Base URL of the app, no trailing slash |
| `CONDUIT_CLAIM_KEY` | The **service** key — see below |

`CONDUIT_CLAIM_KEY` is *not* the MCP server's `KANBAN_API_KEY`. That one is a
workspace key and every route here refuses it; this one is workspace-less and is
refused by every route *except* the claim. They are deliberately different
credentials with different blast radii, so do not reuse one for the other.

Run it manually once before enabling the schedule.

### Three things to check on first import

None of these can be settled from this repo — they need your n8n instance.

1. **`$env` in expressions is blocked by default.** Both HTTP nodes read
   `$env.CONDUIT_API_URL` and `$env.CONDUIT_CLAIM_KEY`. n8n gates process-env
   access from expressions, so on a default install those resolve to nothing and
   the claim silently posts to `/api/v1/ai/jobs/claim` with no host and no
   credential. Either set `N8N_BLOCK_ENV_ACCESS_IN_NODE=false`, or replace the
   Authorization header with a Header Auth credential and hardcode the base URL.
   Check this first — it is the most likely reason a fresh import does nothing.
2. **`typeVersion` values.** The nodes are pinned at `scheduleTrigger@1.2`,
   `httpRequest@4.2`, `if@2.2` and `noOp@1`. These have not been imported into a
   live instance. If your n8n is newer it will usually load them and offer an
   upgrade; if a node loads with empty parameters, the version is the reason.
3. **The Ollama timeout is deliberately below the sweep threshold.** It is
   480000 ms (8 min) against a 10-minute `STALE_AFTER_MINUTES` on the server. A
   run that outlives the sweep gets its job handed to another runner, and its
   result is then refused with `job_reclaimed` — correct, but wasted compute. If
   you raise the timeout, raise the server's sweep threshold with it.

### Minting the claim key

There is deliberately no UI for this. Settings mints workspace keys; the claim
key is the one credential in the system whose blast radius is not
tenant-bounded, and it should be created consciously rather than from a form
someone can reach by accident:

Generate the pair first, keep the plaintext only in n8n:

```bash
node -e "const c=require('crypto');const p='cdt_'+c.randomBytes(32).toString('base64url');console.log('plaintext:',p);console.log('sha256   :',c.createHash('sha256').update(p).digest('hex'))"
```

```sql
-- key_hash is sha256(plaintext), hex. Everything else takes its default:
-- revoked false, created_at now(), created_by and last_used_at null.
insert into api_keys (workspace_id, label, key_hash, scopes)
values (null, 'n8n claim key', '<sha256-hex>', '["ai:claim"]'::jsonb);
```

`workspace_id IS NULL` is what makes it a service key. Verified: a key inserted
by exactly this statement claims successfully and is refused with 401 on
`/api/v1/board`. Note `scopes` is recorded but not yet enforced anywhere — it
documents intent, and grants nothing.

`workspace_id IS NULL` is what makes it a service key — and what makes every
other endpoint refuse it.

## What the runner is trusted with, and what it is not

- It **can** drain the queue for every workspace and read every job's input.
  That is inherent: one workflow serves all tenants, so its credential is
  cross-workspace by definition. Rate-limit it, keep it off shared hosts, and
  rotate it if the n8n host is ever exposed.
- It **cannot** decide which tenant a result belongs to. The claim response
  carries a 15-minute HMAC token with the workspace signed into it, and
  `POST /ai/jobs/:id/result` authenticates on that token alone — no API key is
  accepted there, not even a valid one. A leaked token is worth one job for
  fifteen minutes.
- It **cannot** report the same job twice. The result handler only matches rows
  still in `claimed`, so a replay inside the token's lifetime is a 409 rather
  than a second write.
- If the runner dies mid-job, nothing is stuck: the next claim sweeps anything
  left `claimed` for over ten minutes back to `pending`, and fails it
  permanently on the fourth attempt rather than feeding the same poison input
  to the model forever.

## Verifying without n8n

`pnpm verify:queue` drives all of the above over HTTP — exactly-once handoff,
the poll floor, token forgery, expiry, replay, and the sweeper — using a
throwaway service key it cleans up afterwards. Run that before blaming the
workflow.
