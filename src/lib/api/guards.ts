import { and, asc, eq } from "drizzle-orm";

import { auth } from "@/auth";
import { db } from "@/db";
import { cards, workspaceMembers, workspaces } from "@/db/schema";

export type Actor = {
  kind: "user";
  userId: string;
  /** what gets written to `activity.actor` */
  label: string;
};

/**
 * Browser credential only, for now. Phase 4 adds the Bearer API key branch here
 * so both credential types resolve to the same `Actor` shape.
 */
export async function resolveActor(): Promise<Actor | null> {
  const session = await auth();
  if (!session?.user?.id) return null;
  return {
    kind: "user",
    userId: session.user.id,
    label: session.user.id,
  };
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
 * Loads a card with the tenant predicate in the same statement. There is
 * deliberately no variant that fetches by id alone — the boundary cannot be a
 * separate step a caller might forget.
 */
export async function loadCardScoped(cardId: number, workspaceId: number) {
  const [card] = await db
    .select()
    .from(cards)
    .where(and(eq(cards.id, cardId), eq(cards.workspaceId, workspaceId)))
    .limit(1);

  return card ?? null;
}

export function parseIntParam(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}
