import { db } from "@/db";
import { activity } from "@/db/schema";
import type { Actor } from "@/lib/api/guards";

/**
 * One row per state change, attributed to whoever caused it — a user id for a
 * person, a key label for a machine. `activity.actor` is text for exactly that
 * reason: the two namespaces are not joinable and should not pretend to be.
 *
 * `workspaceId` is passed in rather than derived from `cardId`, so a log write
 * can never be the thing that resolves a tenant.
 */
export async function logActivity(entry: {
  workspaceId: number;
  cardId?: number | null;
  actor: Actor;
  action: string;
  payload?: unknown;
}): Promise<void> {
  try {
    await db.insert(activity).values({
      workspaceId: entry.workspaceId,
      cardId: entry.cardId ?? null,
      actor: entry.actor.label,
      action: entry.action,
      payload: entry.payload ?? null,
    });
  } catch (error) {
    // The audit trail must not be able to fail the action it describes. A move
    // that succeeded and went unlogged is a gap in history; a move rolled back
    // because its log row failed is lost work.
    console.error("activity log failed", entry.action, error);
  }
}
