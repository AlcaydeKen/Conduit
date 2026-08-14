import { and, asc, eq } from "drizzle-orm";

import { db } from "@/db";
import { workspaceMembers, workspaces } from "@/db/schema";
import { allowedEmails } from "@/lib/env";

/**
 * Gives a freshly signed-in developer access to the seeded workspace.
 *
 * The first address in ALLOWED_EMAILS is the owner; everyone else joins as a
 * member. Runs on every sign-in and is idempotent, so re-seeding or adding a
 * third dev needs no manual SQL.
 */
export async function ensureDefaultMembership(
  userId: string,
  email: string,
): Promise<void> {
  const [defaultWorkspace] = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .orderBy(asc(workspaces.id))
    .limit(1);

  if (!defaultWorkspace) return; // not seeded yet

  const [existing] = await db
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, defaultWorkspace.id),
        eq(workspaceMembers.userId, userId),
      ),
    )
    .limit(1);

  if (existing) return;

  const isFirstAllowlistedEmail =
    allowedEmails()[0] === email.trim().toLowerCase();

  // The select above is advisory, not a guard: the same user finishing OAuth in
  // two tabs races it. The composite primary key settles the tie.
  await db
    .insert(workspaceMembers)
    .values({
      workspaceId: defaultWorkspace.id,
      userId,
      role: isFirstAllowlistedEmail ? "owner" : "member",
    })
    .onConflictDoNothing();
}
