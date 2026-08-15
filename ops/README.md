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

Run it manually once before enabling the schedule.

### Minting the claim key

There is deliberately no UI for this. Settings mints workspace keys; the claim
key is the one credential in the system whose blast radius is not
tenant-bounded, and it should be created consciously rather than from a form
someone can reach by accident:

```sql
-- key_hash is sha256(plaintext). Generate the plaintext yourself, store it in
-- n8n, and keep no other copy.
insert into api_keys (workspace_id, label, key_hash, scopes)
values (null, 'n8n claim key', '<sha256-hex>', '["ai:claim"]'::jsonb);
```

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
