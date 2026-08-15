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

## 2. Minting the claim key

Do this before importing the workflow — the credential has to exist first.

```bash
pnpm claim-key:mint
```

It prints the plaintext once. That value goes into n8n and nowhere else; the
column holds a SHA-256 digest, so it is not recoverable afterwards. If a live
claim key already exists the script refuses rather than adding a second one —
two live keys means revoking the leaked one does not end the leak unless you
know which leaked. Pass `--revoke-existing` to rotate.

There is deliberately no UI for this. Settings mints workspace keys; the claim
key is the one credential in the system whose blast radius is not
tenant-bounded, so it is created from a terminal by someone who meant to.

What the script writes, and why each part matters:

| Column | Value | Why |
| --- | --- | --- |
| `workspace_id` | `null` | This *is* the service-key definition. `resolveKeyActor` excludes it with `IS NOT NULL`, `resolveClaimKey` requires it with `IS NULL`. |
| `scopes` | `["ai:claim"]` | Required, not decorative. A workspace-less key without it authenticates as nothing. |
| `created_by` | `null` | The membership predicate that expires workspace keys does not apply — there is no member behind this one. |

The claim key is *not* the MCP server's `KANBAN_API_KEY`. That one is a
workspace key and every route here refuses it; this one is workspace-less and is
refused by every route *except* the claim. Different blast radii, so do not
reuse one for the other.

## 3. The AI job runner workflow

Create the credential first, then import — n8n links them by name.

1. **Credentials → New → Header Auth**, named exactly `Conduit claim key`.
   - Name: `Authorization`
   - Value: `Bearer cdt_...` (the whole line the mint script printed)
2. **Import `n8n-ai-job-runner.json`**, then open *Claim a job* and pick
   `Conduit claim key` in the credential dropdown. The JSON carries no
   credential reference on purpose: credential ids are per-instance, so a
   hardcoded one imports as a dangling reference and the node fails with
   "Credentials not found" rather than matching by name.
3. **Run it manually once** before enabling the schedule.

   Read the *Claim a job* node's output rather than trusting the green ticks.
   You want `statusCode: 200` and `body: {"job": null}` on an empty queue. See
   "The failure that looks like success" below for why the canvas cannot tell
   you this.

The base URL is hardcoded to `http://host.docker.internal:3000` in the two
Conduit nodes. Change both if the app is not on the host's port 3000.

### The failure that looks like success

`Anything to do?` branches on whether `body.job.id` exists. A `401` has no
`body.job` either — so an unauthenticated runner took the *same* branch as an
idle one, landed on *Queue empty*, and reported a clean green execution every
minute forever. Nothing on the canvas distinguished "no work" from "no
credential", and the queue quietly filled up.

`Claim accepted?` now sits between them and tests `statusCode === 200`.
Anything else goes to a `stopAndError` that fails the execution with the status
and body attached, so it shows up red in Executions and can drive n8n's error
workflow. `429` is included deliberately: the claim endpoint enforces a
5-second floor per key, and hitting it on a 1-minute schedule means two runners
are sharing one credential.

This is the same shape as the `$env` problem below — a misconfiguration that
produces silence rather than an error. Both were worth an extra node.

### Why a credential rather than `$env`

An earlier version read `$env.CONDUIT_API_URL` and `$env.CONDUIT_CLAIM_KEY`.
That requires `N8N_BLOCK_ENV_ACCESS_IN_NODE=false`, which unblocks the *whole*
process environment for *every* workflow expression on the instance — and this
n8n is shared with unrelated projects. The credential is encrypted at rest in
n8n's own store and masked in execution logs; an env var is neither, and sits in
plaintext in `docker inspect`.

### Two things left to check on your instance

1. **`typeVersion` values.** The nodes are pinned at `scheduleTrigger@1.2`,
   `httpRequest@4.2`, `if@2.2` and `noOp@1`. If a node loads with empty
   parameters after import, the version is the reason — n8n usually loads older
   versions fine and offers an upgrade.
2. **The Ollama timeout is deliberately below the sweep threshold.** It is
   480000 ms (8 min) against a 10-minute `STALE_AFTER_MINUTES` on the server. A
   run that outlives the sweep gets its job handed to another runner, and its
   result is then refused with `job_reclaimed` — correct, but wasted compute. If
   you raise the timeout, raise the server's sweep threshold with it.

The claim endpoint also enforces a 5-second floor between polls per key
(`MIN_POLL_INTERVAL_SECONDS`), which the 1-minute schedule is comfortably
inside. Two runners sharing one key is what that floor exists to catch.

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
