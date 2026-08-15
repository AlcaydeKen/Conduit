/**
 * Exercises the AI job queue over HTTP against `pnpm dev`.
 *
 * Run: pnpm dev  (in one terminal)
 *      pnpm verify:queue
 *
 * The checks that matter here are the ones SPEC calls out by name: a claim
 * hands each job to exactly one runner, a workspace key cannot post a result,
 * an expired token is refused, and a replay inside the token's lifetime is a
 * conflict rather than a second write.
 */
import { and, asc, eq, inArray, like } from "drizzle-orm";

import { db } from "@/db";
import { aiJobs, apiKeys, cards, workspaces } from "@/db/schema";
import { signJobToken } from "@/lib/api/job-token";
import { generateApiKey } from "@/lib/api/keys";

const BASE_URL = process.env.VERIFY_BASE_URL ?? "http://localhost:3000";
const MARKER = "[queue-verify]";

let failures = 0;

function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) {
    console.log(`  PASS  ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${label}`, detail ?? "");
  }
}

const post = (path: string, token: string | null, body?: unknown) =>
  fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });

async function main() {
  const [workspace] = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .orderBy(asc(workspaces.id))
    .limit(1);
  if (!workspace) throw new Error("no workspace — run pnpm db:seed");

  const [card] = await db
    .select({ id: cards.id })
    .from(cards)
    .where(eq(cards.workspaceId, workspace.id))
    .orderBy(asc(cards.id))
    .limit(1);

  const service = generateApiKey();
  const scoped = generateApiKey();

  try {
    await db.insert(apiKeys).values([
      {
        workspaceId: null,
        label: `${MARKER} service`,
        keyHash: service.hash,
        scopes: ["ai:claim"],
      },
      {
        workspaceId: workspace.id,
        label: `${MARKER} scoped`,
        keyHash: scoped.hash,
        scopes: [],
      },
    ]);

    const queued = await db
      .insert(aiJobs)
      .values([
        {
          workspaceId: workspace.id,
          cardId: card?.id ?? null,
          kind: "estimate_points",
          status: "pending",
          input: { marker: MARKER, n: 1 },
        },
        {
          workspaceId: workspace.id,
          cardId: card?.id ?? null,
          kind: "split_epic",
          status: "pending",
          input: { marker: MARKER, n: 2 },
        },
      ])
      .returning({ id: aiJobs.id });
    const queuedIds = queued.map((row) => row.id);

    console.log("0. enqueueing from the app side");
    if (card) {
      const enqueue = await post("/api/v1/ai/jobs", scoped.plaintext, {
        card_id: card.id,
        kind: "draft_card",
        input: { marker: MARKER },
      });
      check("POST /ai/jobs is 200", enqueue.status === 200, enqueue.status);
      const enqueued = (await enqueue.json()).job;
      check("it comes back pending", enqueued?.status === "pending", enqueued);

      const duplicate = await post("/api/v1/ai/jobs", scoped.plaintext, {
        card_id: card.id,
        kind: "draft_card",
      });
      check(
        "a second draft for the same card is 409, not a duplicate run",
        duplicate.status === 409,
        duplicate.status,
      );

      // Sequential rejection is the easy half. A select-then-insert passes the
      // check above and still lets two overlapping clicks both through, so the
      // guard has to be exercised concurrently to mean anything.
      await db.delete(aiJobs).where(eq(aiJobs.id, enqueued.id as number));
      const [raceA, raceB] = await Promise.all([
        post("/api/v1/ai/jobs", scoped.plaintext, {
          card_id: card.id,
          kind: "draft_card",
        }),
        post("/api/v1/ai/jobs", scoped.plaintext, {
          card_id: card.id,
          kind: "draft_card",
        }),
      ]);
      const raceStatuses = [raceA.status, raceB.status].sort();
      check(
        "two simultaneous clicks yield exactly one 200 and one 409",
        raceStatuses[0] === 200 && raceStatuses[1] === 409,
        raceStatuses,
      );

      const openRows = await db
        .select({ id: aiJobs.id })
        .from(aiJobs)
        .where(
          and(
            eq(aiJobs.cardId, card.id),
            eq(aiJobs.kind, "draft_card"),
            inArray(aiJobs.status, ["pending", "claimed"]),
          ),
        );
      check(
        "and exactly one open job exists afterwards",
        openRows.length === 1,
        openRows.length,
      );

      const readBack = await fetch(
        `${BASE_URL}/api/v1/ai/jobs?card=${card.id}`,
        { headers: { authorization: `Bearer ${scoped.plaintext}` } },
      );
      check("GET /ai/jobs?card= is 200", readBack.status === 200, readBack.status);
      check(
        "and returns the job the drawer polls",
        (await readBack.json()).job?.id === openRows[0]?.id,
      );

      const foreignCard = await post("/api/v1/ai/jobs", scoped.plaintext, {
        card_id: 99999999,
        kind: "draft_card",
      });
      check(
        "queueing against an unknown card is 404",
        foreignCard.status === 404,
        foreignCard.status,
      );

      const badKind = await post("/api/v1/ai/jobs", scoped.plaintext, {
        card_id: card.id,
        kind: "draft_description",
      });
      check(
        "an unknown kind is rejected rather than stored",
        badKind.status === 400,
        badKind.status,
      );

      // Leave the queue as the rest of the script expects.
      await db
        .delete(aiJobs)
        .where(and(eq(aiJobs.cardId, card.id), eq(aiJobs.kind, "draft_card")));
    } else {
      console.log("  SKIP  no card in the workspace");
    }

    console.log("\n1. only the service key may claim");
    const anonymous = await post("/api/v1/ai/jobs/claim", null);
    check("no credential is 401", anonymous.status === 401, anonymous.status);

    const withScoped = await post("/api/v1/ai/jobs/claim", scoped.plaintext);
    check(
      "a workspace key is 401 on the claim endpoint",
      withScoped.status === 401,
      withScoped.status,
    );

    const withGarbage = await post("/api/v1/ai/jobs/claim", "cdt_nope");
    check("an unknown key is 401", withGarbage.status === 401, withGarbage.status);

    console.log("\n2. the claim hands out one job and a token");
    const first = await post("/api/v1/ai/jobs/claim", service.plaintext);
    check("claim is 200", first.status === 200, first.status);
    const firstBody = await first.json();
    check("it returned a job", typeof firstBody.job?.id === "number", firstBody);
    check(
      "the job is one of ours",
      queuedIds.includes(firstBody.job?.id),
      { got: firstBody.job?.id, queuedIds },
    );
    check("with a token", typeof firstBody.token === "string" && firstBody.token.includes("."));
    check("and an expiry", typeof firstBody.expires_at === "string");
    check("attempts was incremented", firstBody.job?.attempts === 1, firstBody.job);

    console.log("\n3. the same job is never handed out twice");
    // The rate limiter is deliberate; clear it so the next poll is allowed.
    await db
      .update(apiKeys)
      .set({ lastUsedAt: null })
      .where(eq(apiKeys.keyHash, service.hash));

    const second = await post("/api/v1/ai/jobs/claim", service.plaintext);
    const secondBody = await second.json();
    check("a second claim is 200", second.status === 200, second.status);
    check(
      "and returns a different job",
      secondBody.job?.id !== firstBody.job?.id,
      { first: firstBody.job?.id, second: secondBody.job?.id },
    );

    await db
      .update(apiKeys)
      .set({ lastUsedAt: null })
      .where(eq(apiKeys.keyHash, service.hash));
    const third = await post("/api/v1/ai/jobs/claim", service.plaintext);
    const thirdBody = await third.json();
    check(
      "an empty queue returns job: null, not an error",
      third.status === 200 && thirdBody.job === null,
      { status: third.status, body: thirdBody },
    );

    console.log("\n4. the poll floor is enforced");
    const rapid = await post("/api/v1/ai/jobs/claim", service.plaintext);
    check("polling again immediately is 429", rapid.status === 429, rapid.status);
    check(
      "and says how long to wait",
      rapid.headers.get("retry-after") !== null,
      rapid.headers.get("retry-after"),
    );

    console.log("\n5. results authenticate on the token alone");
    const jobId = firstBody.job.id as number;
    const token = firstBody.token as string;

    const noToken = await post(`/api/v1/ai/jobs/${jobId}/result`, null, {
      status: "done",
      result: { text: "x" },
    });
    check("no token is 401", noToken.status === 401, noToken.status);

    const keyInstead = await post(
      `/api/v1/ai/jobs/${jobId}/result`,
      scoped.plaintext,
      { status: "done", result: { text: "x" } },
    );
    check(
      "a valid workspace key is still 401",
      keyInstead.status === 401,
      keyInstead.status,
    );

    const tampered = await post(
      `/api/v1/ai/jobs/${jobId}/result`,
      `${token.split(".")[0]}.AAAA`,
      { status: "done", result: { text: "x" } },
    );
    check("a tampered signature is 401", tampered.status === 401, tampered.status);

    const expired = signJobToken({
      job_id: jobId,
      workspace_id: workspace.id,
      attempt: 1,
      exp: Math.floor(Date.now() / 1000) - 60,
    });
    const expiredResponse = await post(
      `/api/v1/ai/jobs/${jobId}/result`,
      expired,
      { status: "done", result: { text: "x" } },
    );
    check(
      "a correctly signed but expired token is 401",
      expiredResponse.status === 401,
      expiredResponse.status,
    );

    console.log("\n6. a token is bound to its own job");
    const otherJobId = secondBody.job.id as number;
    const wrongJob = await post(`/api/v1/ai/jobs/${otherJobId}/result`, token, {
      status: "done",
      result: { text: "x" },
    });
    check(
      "presenting a token against another job is 404",
      wrongJob.status === 404,
      wrongJob.status,
    );

    const [untouched] = await db
      .select({ status: aiJobs.status })
      .from(aiJobs)
      .where(eq(aiJobs.id, otherJobId))
      .limit(1);
    check(
      "and that job was not written",
      untouched?.status === "claimed",
      untouched,
    );

    console.log("\n7. the happy path, then the replay");
    const done = await post(`/api/v1/ai/jobs/${jobId}/result`, token, {
      status: "done",
      result: { text: `${MARKER} model output` },
    });
    check("posting a result is 200", done.status === 200, done.status);
    check("the job reports done", (await done.json()).job?.status === "done");

    const [stored] = await db
      .select({ status: aiJobs.status, result: aiJobs.result })
      .from(aiJobs)
      .where(eq(aiJobs.id, jobId))
      .limit(1);
    check("the database agrees", stored?.status === "done", stored);
    check(
      "and stored the result",
      JSON.stringify(stored?.result).includes("model output"),
      stored?.result,
    );

    const replay = await post(`/api/v1/ai/jobs/${jobId}/result`, token, {
      status: "failed",
      error: "second write",
    });
    check(
      "replaying the same token inside its lifetime is 409",
      replay.status === 409,
      replay.status,
    );

    const [afterReplay] = await db
      .select({ status: aiJobs.status, error: aiJobs.error })
      .from(aiJobs)
      .where(eq(aiJobs.id, jobId))
      .limit(1);
    check(
      "and the first result stands",
      afterReplay?.status === "done" && afterReplay?.error === null,
      afterReplay,
    );

    console.log("\n7b. a superseded runner cannot report back");
    // The exact shape of the bug this exists for: a runner that is slow rather
    // than dead. The sweeper returns its job after ten minutes and someone else
    // claims it, but the first runner's token is still signed and unexpired for
    // another five. Without a fence, its result lands on the live claim.
    await db
      .update(aiJobs)
      .set({
        status: "claimed",
        claimedAt: new Date(Date.now() - 30 * 60 * 1000),
        attempts: 1,
        result: null,
        error: null,
      })
      .where(eq(aiJobs.id, otherJobId));

    const staleToken = signJobToken({
      job_id: otherJobId,
      workspace_id: workspace.id,
      attempt: 1,
      exp: Math.floor(Date.now() / 1000) + 600,
    });

    await db
      .update(apiKeys)
      .set({ lastUsedAt: null })
      .where(eq(apiKeys.keyHash, service.hash));
    const reclaim = await post("/api/v1/ai/jobs/claim", service.plaintext);
    const reclaimBody = await reclaim.json();
    check(
      "the sweeper hands the job to a second runner",
      reclaimBody.job?.id === otherJobId && reclaimBody.job?.attempts === 2,
      reclaimBody.job,
    );

    const zombie = await post(`/api/v1/ai/jobs/${otherJobId}/result`, staleToken, {
      status: "done",
      result: { text: `${MARKER} zombie output` },
    });
    check(
      "the superseded runner's still-valid token is refused",
      zombie.status === 409,
      zombie.status,
    );
    check(
      "and is told it lost the job, not that the job is finished",
      (await zombie.json()).error === "job_reclaimed",
    );

    const live = await post(
      `/api/v1/ai/jobs/${otherJobId}/result`,
      reclaimBody.token,
      { status: "done", result: { text: `${MARKER} live output` } },
    );
    check("the current claimant is still accepted", live.status === 200, live.status);

    const [afterFence] = await db
      .select({ result: aiJobs.result })
      .from(aiJobs)
      .where(eq(aiJobs.id, otherJobId))
      .limit(1);
    check(
      "and its result is the one stored",
      JSON.stringify(afterFence?.result).includes("live output"),
      afterFence?.result,
    );

    console.log("\n8. abandoned jobs come back");
    await db
      .update(aiJobs)
      .set({
        status: "claimed",
        claimedAt: new Date(Date.now() - 30 * 60 * 1000),
        attempts: 1,
      })
      .where(eq(aiJobs.id, otherJobId));
    await db
      .update(apiKeys)
      .set({ lastUsedAt: null })
      .where(eq(apiKeys.keyHash, service.hash));

    const sweep = await post("/api/v1/ai/jobs/claim", service.plaintext);
    const sweepBody = await sweep.json();
    check(
      "a job stuck in claimed is swept back and re-handed out",
      sweepBody.job?.id === otherJobId,
      sweepBody.job,
    );
    check("with attempts incremented", sweepBody.job?.attempts === 2, sweepBody.job);

    await db
      .update(aiJobs)
      .set({
        status: "claimed",
        claimedAt: new Date(Date.now() - 30 * 60 * 1000),
        attempts: 3,
      })
      .where(eq(aiJobs.id, otherJobId));
    await db
      .update(apiKeys)
      .set({ lastUsedAt: null })
      .where(eq(apiKeys.keyHash, service.hash));

    const exhausted = await post("/api/v1/ai/jobs/claim", service.plaintext);
    check("a fourth attempt is not handed out", (await exhausted.json()).job === null);
    const [dead] = await db
      .select({ status: aiJobs.status, error: aiJobs.error })
      .from(aiJobs)
      .where(eq(aiJobs.id, otherJobId))
      .limit(1);
    check("it is failed permanently", dead?.status === "failed", dead);
    check("with a reason", (dead?.error ?? "").includes("abandoned"), dead?.error);
  } finally {
    const strays = await db
      .select({ id: aiJobs.id, input: aiJobs.input })
      .from(aiJobs)
      .where(eq(aiJobs.workspaceId, workspace.id));
    const ids = strays
      .filter((row) => JSON.stringify(row.input ?? {}).includes(MARKER))
      .map((row) => row.id);
    if (ids.length > 0) await db.delete(aiJobs).where(inArray(aiJobs.id, ids));
    await db.delete(apiKeys).where(like(apiKeys.label, `${MARKER}%`));
    console.log(`\ncleaned up ${ids.length} job(s) and 2 key(s)`);
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exitCode = 1;
  } else {
    console.log("\nall checks passed");
  }
}

main().catch((error) => {
  console.error("verify-queue failed:", error);
  process.exitCode = 1;
});
