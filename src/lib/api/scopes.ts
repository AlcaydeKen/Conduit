/**
 * What an API key is allowed to do, beyond which workspace it belongs to.
 *
 * Scopes and tenancy answer different questions, and they fail differently on
 * purpose. Tenancy answers "does this row exist for you" and must always be
 * 404, because distinguishing "absent" from "someone else's" turns sequential
 * ids into a directory of other tenants. A scope answers "may this credential
 * do this at all", which is a fact about the caller's own key and reveals
 * nothing about anyone else's data — so it is a 403, and it is checked before
 * any row is loaded, so a refusal never depends on what exists.
 */
export const SCOPES = {
  /** Read boards, cards, sprints, comments, reports. */
  BOARD_READ: "board:read",
  /** Create and change cards, comments, sprints, and queue AI jobs. */
  BOARD_WRITE: "board:write",
  /** Drain the job queue. Only ever held by the workspace-less service key. */
  AI_CLAIM: "ai:claim",
} as const;

export type Scope = (typeof SCOPES)[keyof typeof SCOPES];

/** What a key minted through settings gets unless it is marked read-only. */
export const FULL_WORKSPACE_SCOPES: Scope[] = [
  SCOPES.BOARD_READ,
  SCOPES.BOARD_WRITE,
];

export const READ_ONLY_SCOPES: Scope[] = [SCOPES.BOARD_READ];

/**
 * Write implies read. Without this every caller has to remember to grant both,
 * and a key that can create a card but not read one back is not a useful thing
 * to be able to mint by accident.
 */
export function hasScope(granted: string[], required: Scope): boolean {
  if (granted.includes(required)) return true;
  if (required === SCOPES.BOARD_READ) {
    return granted.includes(SCOPES.BOARD_WRITE);
  }
  return false;
}

export function describeScopes(granted: string[]): string {
  if (granted.includes(SCOPES.AI_CLAIM)) return "claim only";
  if (granted.includes(SCOPES.BOARD_WRITE)) return "read & write";
  if (granted.includes(SCOPES.BOARD_READ)) return "read only";
  return "none";
}
