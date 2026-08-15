import { and, asc, eq, isNotNull, isNull, sql } from "drizzle-orm";

import { auth } from "@/auth";
import { db } from "@/db";
import {
  apiKeys,
  cards,
  sprints,
  workspaceMembers,
  workspaces,
} from "@/db/schema";
import { hashApiKey, readBearer } from "@/lib/api/keys";
import { insufficientScope, unauthorized } from "@/lib/api/response";
import { SCOPES, hasScope, type Scope } from "@/lib/api/scopes";

export type Actor =
  | {
      kind: "user";
      userId: string;
      /** what gets written to `activity.actor` */
      label: string;
    }
  | {
      kind: "key";
      keyId: number;
      /** Never null here — see the service-key note on `resolveActor`. */
      workspaceId: number;
      label: string;
      scopes: string[];
    };

/**
 * Resolves either credential to the same shape. A Bearer header wins over a
 * session cookie when both are present: a request that presents a machine
 * credential is a machine request, and silently falling back to whoever happens
 * to be signed in to the same browser would attribute its writes to a person.
 *
 * A service-scoped key — `workspace_id IS NULL`, the one n8n uses to claim jobs
 * — resolves to null here, so every route built on `resolveActor` refuses it
 * with a 401. Phase 6's claim endpoint gets its own resolver. That way the
 * exemption is something a route has to opt into, not something every route has
 * to remember to exclude.
 */
export type ActorResult =
  | { ok: true; actor: Actor }
  | { ok: false; response: Response };

/**
 * `scope` is a required argument for the same reason `request` is: a route that
 * forgets it must fail to compile, not silently grant.
 *
 * The earlier design exported a separate `requireScope` that each route had to
 * remember to call. Omitting it was valid TypeScript and produced a working,
 * unscoped endpoint — a read-only key could write, and nothing would say so.
 * Folding the check into the only function that hands out an `Actor` means
 * there is no way to obtain one without having stated what it is for.
 */
export async function resolveActor(
  request: Request,
  scope: Scope,
): Promise<ActorResult> {
  const bearer = readBearer(request);
  const actor = bearer ? await resolveKeyActor(bearer) : await resolveSessionActor();

  if (!actor) return { ok: false, response: unauthorized() };

  // Before any row is loaded, so a refusal can never depend on what exists.
  if (actor.kind === "key" && !hasScope(actor.scopes, scope)) {
    return { ok: false, response: insufficientScope(scope) };
  }

  return { ok: true, actor };
}

/**
 * The cookie half on its own, for server components, which have no `Request` to
 * read a header from. `request` is required on `resolveActor` precisely so a
 * route cannot forget to pass it and quietly lose Bearer support; a page has
 * nothing to forget.
 */
export async function resolveSessionActor(): Promise<Actor | null> {
  const session = await auth();
  if (!session?.user?.id) return null;
  return {
    kind: "user",
    userId: session.user.id,
    label: session.user.id,
  };
}

async function resolveKeyActor(bearer: string): Promise<Actor | null> {
  // Lookup and touch in one statement. Splitting them would add a round trip to
  // every machine request for a column nothing reads synchronously. The
  // `workspace_id IS NOT NULL` predicate is what excludes the service key, and
  // it lives in the query rather than in a check afterwards.
  const [row] = await db
    .update(apiKeys)
    .set({ lastUsedAt: sql`now()` })
    .where(
      and(
        eq(apiKeys.keyHash, hashApiKey(bearer)),
        eq(apiKeys.revoked, false),
        isNotNull(apiKeys.workspaceId),
      ),
    )
    .returning({
      id: apiKeys.id,
      workspaceId: apiKeys.workspaceId,
      label: apiKeys.label,
      scopes: apiKeys.scopes,
    });

  if (!row?.workspaceId) return null;

  return {
    kind: "key",
    keyId: row.id,
    workspaceId: row.workspaceId,
    // Namespaced by id, never the raw label. `activity.actor` holds a user id
    // for a person, and `label` is free text its creator chose — so a member
    // could mint a key labelled with a colleague's user id and have every
    // action it takes recorded as that colleague's. `key:<id>` cannot collide
    // with a user id, and identifies the key itself rather than a name that is
    // neither unique nor stable across revoke-and-recreate.
    label: `key:${row.id}`,
    scopes: row.scopes,
  };
}

export type ClaimKey = { keyId: number; label: string };

export type ClaimOutcome =
  | { ok: true; key: ClaimKey }
  | { ok: false; reason: "unauthorized" | "rate_limited" };

/**
 * The one credential `resolveActor` deliberately refuses: the service-scoped
 * claim key, `workspace_id IS NULL`.
 *
 * Only `/ai/jobs/claim` may call this. Its blast radius is genuinely not
 * tenant-bounded — whoever holds it can drain the queue for every workspace and
 * read every job's input — which is why it is confined to one endpoint, rate
 * limited here, and never able to say which tenant a *result* belongs to. That
 * is what the signed execution token is for.
 *
 * The floor is enforced in the same statement that authenticates, so a caller
 * cannot spin faster than it by racing two requests.
 */
export async function resolveClaimKey(
  request: Request,
  minIntervalSeconds: number,
): Promise<ClaimOutcome> {
  const bearer = readBearer(request);
  if (!bearer) return { ok: false, reason: "unauthorized" };

  const hash = hashApiKey(bearer);

  const [row] = await db
    .update(apiKeys)
    .set({ lastUsedAt: sql`now()` })
    .where(
      and(
        eq(apiKeys.keyHash, hash),
        eq(apiKeys.revoked, false),
        isNull(apiKeys.workspaceId),
        sql`(${apiKeys.lastUsedAt} IS NULL OR ${apiKeys.lastUsedAt} < now() - make_interval(secs => ${minIntervalSeconds}))`,
      ),
    )
    .returning({
      id: apiKeys.id,
      label: apiKeys.label,
      scopes: apiKeys.scopes,
    });

  if (row) {
    // A workspace-less key still has to hold the scope. Otherwise any service
    // key ever minted for some future purpose could drain the queue, and the
    // column would be describing an intent it does not enforce.
    if (!hasScope(row.scopes, SCOPES.AI_CLAIM)) {
      return { ok: false, reason: "unauthorized" };
    }
    return { ok: true, key: { keyId: row.id, label: row.label } };
  }

  // No row matched, which is either a bad credential or one that is simply
  // early. Only the failure path pays for the distinction, and the two must not
  // be conflated: answering 401 to a valid-but-early poll would send an
  // operator hunting a credential problem that does not exist.
  const [exists] = await db
    .select({ id: apiKeys.id })
    .from(apiKeys)
    .where(
      and(
        eq(apiKeys.keyHash, hash),
        eq(apiKeys.revoked, false),
        isNull(apiKeys.workspaceId),
      ),
    )
    .limit(1);

  return { ok: false, reason: exists ? "rate_limited" : "unauthorized" };
}

/**
 * Resolves the workspace an actor is operating in.
 *
 * `hint` is whatever the client asked for (`?workspace=`) and is treated as a
 * hint only: membership is proven by the join, in this same query. An
 * unreadable, missing, or other-tenant hint resolves to null, which callers
 * turn into a 404.
 */
export async function resolveWorkspace(
  actor: Actor,
  hint?: number | null,
): Promise<{ id: number; name: string; slug: string } | null> {
  // A key carries its own tenant. A hint naming a different workspace is not an
  // error to explain — it is a probe, and it gets the same answer as a
  // workspace that does not exist.
  if (actor.kind === "key") {
    if (hint && hint !== actor.workspaceId) return null;

    const [workspace] = await db
      .select({
        id: workspaces.id,
        name: workspaces.name,
        slug: workspaces.slug,
      })
      .from(workspaces)
      .where(eq(workspaces.id, actor.workspaceId))
      .limit(1);

    return workspace ?? null;
  }

  const membership = eq(workspaceMembers.userId, actor.userId);

  const [workspace] = await db
    .select({ id: workspaces.id, name: workspaces.name, slug: workspaces.slug })
    .from(workspaces)
    .innerJoin(
      workspaceMembers,
      and(eq(workspaceMembers.workspaceId, workspaces.id), membership),
    )
    .where(hint ? eq(workspaces.id, hint) : undefined)
    .orderBy(asc(workspaces.id))
    .limit(1);

  return workspace ?? null;
}

/** Every workspace the actor can see, for the switcher. */
export async function listWorkspaces(actor: Actor) {
  // A key sees exactly the one workspace it was issued for, never the roster of
  // whoever created it. `role` is reported as "member" because a key holds no
  // membership — it must not inherit its creator's ownership.
  if (actor.kind === "key") {
    const rows = await db
      .select({
        id: workspaces.id,
        name: workspaces.name,
        slug: workspaces.slug,
      })
      .from(workspaces)
      .where(eq(workspaces.id, actor.workspaceId))
      .limit(1);

    return rows.map((workspace) => ({ ...workspace, role: "member" as const }));
  }

  return db
    .select({
      id: workspaces.id,
      name: workspaces.name,
      slug: workspaces.slug,
      role: workspaceMembers.role,
    })
    .from(workspaces)
    .innerJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.workspaceId, workspaces.id),
        eq(workspaceMembers.userId, actor.userId),
      ),
    )
    .orderBy(asc(workspaces.id));
}

/**
 * Loads a card with the tenant predicate in the same statement, in whichever
 * form the actor's credential proves it: a membership join for a person, an
 * equality against the key's own workspace for a machine. There is deliberately
 * no variant that fetches by id alone — the boundary cannot be a separate step
 * a caller might forget, and a caller must not have to remember which kind of
 * credential it is holding.
 *
 * A row in another tenant and a row that does not exist both come back null, so
 * callers can only produce the one 404.
 */
export async function loadCardForActor(actor: Actor, cardId: number) {
  const projection = {
    id: cards.id,
    workspaceId: cards.workspaceId,
    columnId: cards.columnId,
    sprintId: cards.sprintId,
    position: cards.position,
  };

  if (actor.kind === "key") {
    const [card] = await db
      .select(projection)
      .from(cards)
      .where(
        and(eq(cards.id, cardId), eq(cards.workspaceId, actor.workspaceId)),
      )
      .limit(1);

    return card ?? null;
  }

  const [card] = await db
    .select(projection)
    .from(cards)
    .innerJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.workspaceId, cards.workspaceId),
        eq(workspaceMembers.userId, actor.userId),
      ),
    )
    .where(eq(cards.id, cardId))
    .limit(1);

  return card ?? null;
}

/** The same contract as `loadCardForActor`, for sprints. */
export async function loadSprintForActor(actor: Actor, sprintId: number) {
  const projection = {
    id: sprints.id,
    workspaceId: sprints.workspaceId,
    name: sprints.name,
    status: sprints.status,
    startsAt: sprints.startsAt,
    endsAt: sprints.endsAt,
  };

  if (actor.kind === "key") {
    const [sprint] = await db
      .select(projection)
      .from(sprints)
      .where(
        and(eq(sprints.id, sprintId), eq(sprints.workspaceId, actor.workspaceId)),
      )
      .limit(1);

    return sprint ?? null;
  }

  const [sprint] = await db
    .select(projection)
    .from(sprints)
    .innerJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.workspaceId, sprints.workspaceId),
        eq(workspaceMembers.userId, actor.userId),
      ),
    )
    .where(eq(sprints.id, sprintId))
    .limit(1);

  return sprint ?? null;
}

/** The user id to attribute a row to, or null when a machine acted. */
export function authorIdOf(actor: Actor): string | null {
  return actor.kind === "user" ? actor.userId : null;
}

export function parseIntParam(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}
