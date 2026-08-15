import { createHash, randomBytes } from "node:crypto";

/** Lets a leaked key be recognised on sight, in a log or a paste. */
export const KEY_PREFIX = "cdt_";

/**
 * Keys are stored as a plain SHA-256 digest, not bcrypt or argon2.
 *
 * Those exist to make *low-entropy* secrets expensive to guess. This secret is
 * 256 bits from a CSPRNG, so there is no guessing attack to slow down — the
 * work factor would only buy an attacker a way to make every authenticated
 * request cost the server real CPU. A digest also keeps lookup to a single
 * indexed equality on `key_hash`, so authentication cannot become a table scan.
 */
export function hashApiKey(plaintext: string): string {
  return createHash("sha256").update(plaintext, "utf8").digest("hex");
}

export function generateApiKey(): { plaintext: string; hash: string } {
  const plaintext = `${KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
  return { plaintext, hash: hashApiKey(plaintext) };
}

/**
 * Pulls the credential out of an `Authorization` header. Returns null for
 * anything that is not exactly one Bearer token, rather than trying to be
 * lenient — a header this code half-understands is a header it should refuse.
 */
export function readBearer(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;

  const [scheme, ...rest] = header.trim().split(/\s+/);
  if (rest.length !== 1) return null;
  if (scheme.toLowerCase() !== "bearer") return null;

  return rest[0] || null;
}
