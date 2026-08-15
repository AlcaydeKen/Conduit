import { and, desc, eq, inArray, lt, notLike } from "drizzle-orm";

import { db } from "@/db";
import { activity, apiKeys, cards, users } from "@/db/schema";
import {
  parseIntParam,
  resolveActor,
  resolveWorkspace,
} from "@/lib/api/guards";
import { notFound, ok } from "@/lib/api/response";
import { SCOPES } from "@/lib/api/scopes";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * `activity.actor` is deliberately opaque text: a user id for a person,
 * `key:<id>` for a machine, `job:<id>` for the AI queue. Those namespaces are
 * not joinable, and pretending otherwise is what would let one impersonate
 * another — the reason the column stopped storing key *labels* in the first
 * place.
 *
 * So resolution happens here, per namespace, and the response always carries the
 * id alongside whatever human name was found. A key whose label reads like a
 * colleague's name is still visibly key #7.
 */
type ResolvedActor =
  | { kind: "user"; id: string; name: string | null; image: string | null }
  | { kind: "key"; id: number; label: string | null; revoked: boolean }
  | { kind: "job"; id: number }
  | { kind: "unknown"; raw: string };

function classify(raw: string): { kind: "user" | "key" | "job"; id: string } {
  if (raw.startsWith("key:")) return { kind: "key", id: raw.slice(4) };
  if (raw.startsWith("job:")) return { kind: "job", id: raw.slice(4) };
  return { kind: "user", id: raw };
}

export async function GET(request: Request) {
  const auth = await resolveActor(request, SCOPES.BOARD_READ);
  if (!auth.ok) return auth.response;
  const actor = auth.actor;

  const url = new URL(request.url);
  const workspace = await resolveWorkspace(
    actor,
    parseIntParam(url.searchParams.get("workspace")),
  );
  if (!workspace) return notFound();

  const limit = Math.min(
    parseIntParam(url.searchParams.get("limit")) ?? DEFAULT_LIMIT,
    MAX_LIMIT,
  );
  const before = parseIntParam(url.searchParams.get("before"));

  /*
   * `?card=` narrows to one card's history, for the drawer.
   *
   * It can only ever narrow. The workspace predicate below is what enforces
   * tenancy, and it is unconditional — so a card id from another tenant matches
   * no rows and returns an empty page rather than leaking that the card exists.
   * That is why this is a plain equality and not a join up to `cards`: there is
   * nothing for a join to prove that the workspace predicate has not already
   * settled.
   */
  const cardId = parseIntParam(url.searchParams.get("card"));

  /*
   * A key never sees key management.
   *
   * `/api/v1/keys` is session-only so that a machine credential cannot
   * enumerate credentials — one leaked key must not become a map of every other
   * key in the workspace. This endpoint would have handed that map over anyway:
   * `api_key.create` carries `{key_id, label, scopes}`, so diffing creates
   * against revokes reconstructs the live inventory, complete with which key
   * holds write access. The restriction on `/keys` would have been decorative.
   *
   * The filter is here rather than in `logActivity` because a *member* reading
   * the audit log should absolutely see who minted what. Redacting at write
   * time would destroy that for everyone in order to withhold it from machines,
   * and the whole point of an audit trail is that key management is in it.
   */
  const hideKeyAdmin =
    actor.kind === "key" ? notLike(activity.action, "api_key.%") : undefined;

  // Keyset pagination on the primary key. An offset would drift as new rows
  // land, which on an append-only log means silently repeating or skipping
  // entries while someone reads.
  const rows = await db
    .select({
      id: activity.id,
      actor: activity.actor,
      action: activity.action,
      payload: activity.payload,
      createdAt: activity.createdAt,
      cardId: activity.cardId,
      cardTitle: cards.title,
    })
    .from(activity)
    .leftJoin(cards, eq(cards.id, activity.cardId))
    .where(
      and(
        eq(activity.workspaceId, workspace.id),
        hideKeyAdmin,
        cardId ? eq(activity.cardId, cardId) : undefined,
        before ? lt(activity.id, before) : undefined,
      ),
    )
    .orderBy(desc(activity.id))
    .limit(limit + 1);

  const page = rows.slice(0, limit);

  const classified = page.map((row) => classify(row.actor));
  const userIds = [
    ...new Set(classified.filter((c) => c.kind === "user").map((c) => c.id)),
  ];
  const keyIds = [
    ...new Set(
      classified
        .filter((c) => c.kind === "key")
        .map((c) => Number(c.id))
        .filter(Number.isInteger),
    ),
  ];

  const [userRows, keyRows] = await Promise.all([
    userIds.length > 0
      ? db
          .select({ id: users.id, name: users.name, image: users.image })
          .from(users)
          .where(inArray(users.id, userIds))
      : Promise.resolve([]),
    keyIds.length > 0
      ? db
          .select({
            id: apiKeys.id,
            label: apiKeys.label,
            revoked: apiKeys.revoked,
          })
          .from(apiKeys)
          // Scoped to this workspace even though the id came from our own log:
          // a key id is only meaningful inside the tenant that owns it, and a
          // lookup that ignored the boundary would be one more place to get it
          // wrong later.
          .where(
            and(
              inArray(apiKeys.id, keyIds),
              eq(apiKeys.workspaceId, workspace.id),
            ),
          )
      : Promise.resolve([]),
  ]);

  const usersById = new Map(userRows.map((row) => [row.id, row]));
  const keysById = new Map(keyRows.map((row) => [row.id, row]));

  function resolve(raw: string): ResolvedActor {
    const { kind, id } = classify(raw);

    if (kind === "key") {
      const numeric = Number(id);
      const found = keysById.get(numeric);
      return Number.isInteger(numeric)
        ? {
            kind: "key",
            id: numeric,
            label: found?.label ?? null,
            revoked: found?.revoked ?? false,
          }
        : { kind: "unknown", raw };
    }

    if (kind === "job") {
      const numeric = Number(id);
      return Number.isInteger(numeric)
        ? { kind: "job", id: numeric }
        : { kind: "unknown", raw };
    }

    const found = usersById.get(id);
    // A user row can be deleted; the log entry outlives it on purpose, so the
    // id is still reported rather than the row being dropped from history.
    return {
      kind: "user",
      id,
      name: found?.name ?? null,
      image: found?.image ?? null,
    };
  }

  return ok({
    entries: page.map((row) => ({
      id: row.id,
      action: row.action,
      actor: resolve(row.actor),
      card: row.cardId ? { id: row.cardId, title: row.cardTitle } : null,
      payload: row.payload,
      created_at: row.createdAt.toISOString(),
    })),
    // Keyset cursor: pass back as `before`.
    next_before: rows.length > limit ? page[page.length - 1]?.id : null,
  });
}
