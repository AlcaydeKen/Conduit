import { asc, eq } from "drizzle-orm";

import { db } from "@/db";
import { users, workspaceMembers } from "@/db/schema";
import {
  parseIntParam,
  resolveActor,
  resolveWorkspace,
} from "@/lib/api/guards";
import { notFound, ok } from "@/lib/api/response";
import { SCOPES } from "@/lib/api/scopes";

/**
 * The workspace roster, read-only.
 *
 * This exists because the assignee picker needs one. Before it, the only list of
 * people available to the client was derived from the cards already on the board
 * (`collectAssignees` in `src/lib/board-filters.ts`), which means a colleague who
 * has never been assigned anything cannot be assigned anything — exactly the
 * state a new workspace is in.
 *
 * Deliberately **read-only, and deliberately not a member-management route.**
 * Adding or removing a member is still a hand-written SQL statement, and that is
 * load-bearing: an API key is a delegation of its creator's membership, expiring
 * with it via the `CREATOR_STILL_A_MEMBER` predicate in `resolveKeyActor`. That
 * predicate runs on every authenticate precisely so nothing depends on an
 * application code path having fired. A POST or DELETE here would create the
 * illusion that offboarding is something the app does, which is the assumption
 * the design refuses to make.
 *
 * `email` is not returned. An assignee picker needs a name, a face and an id;
 * handing every API key in the workspace a list of addresses is a wider
 * disclosure than the feature asks for.
 */
export async function GET(request: Request) {
  const auth = await resolveActor(request, SCOPES.BOARD_READ);
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const workspace = await resolveWorkspace(
    auth.actor,
    parseIntParam(url.searchParams.get("workspace")),
  );
  if (!workspace) return notFound();

  // The tenant predicate is on the join itself. `workspace.id` came from
  // `resolveWorkspace`, which proved the actor's access to it in a single
  // statement, so there is nothing here to re-check afterwards.
  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      image: users.image,
      role: workspaceMembers.role,
    })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(eq(workspaceMembers.workspaceId, workspace.id))
    .orderBy(asc(users.name), asc(users.id));

  return ok({
    workspace: { id: workspace.id, name: workspace.name },
    members: rows,
  });
}
