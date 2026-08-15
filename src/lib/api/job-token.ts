import { createHmac, timingSafeEqual } from "node:crypto";

import { env } from "@/lib/env";

/** Long enough for a slow model, short enough that a leak is not a foothold. */
export const TOKEN_TTL_SECONDS = 15 * 60;

export type JobTokenPayload = {
  job_id: number;
  workspace_id: number;
  exp: number;
};

/**
 * A per-job bearer for the result callback.
 *
 * The workspace id is *inside the signed payload* rather than read from the
 * request body or from whatever credential n8n holds. That is the whole point:
 * n8n is untrusted compute draining one queue for every workspace, so its own
 * credential cannot be allowed to say which tenant a result belongs to. A
 * leaked token is worth exactly one job for fifteen minutes.
 */
export function signJobToken(payload: JobTokenPayload): string {
  const body = base64url(JSON.stringify(payload));
  return `${body}.${sign(body)}`;
}

export type VerifyResult =
  | { ok: true; payload: JobTokenPayload }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" };

export function verifyJobToken(token: string, now = Date.now()): VerifyResult {
  const parts = token.split(".");
  if (parts.length !== 2) return { ok: false, reason: "malformed" };

  const [body, signature] = parts as [string, string];

  // Signature first. Parsing attacker-controlled JSON before proving it is ours
  // means deciding what to do about a payload we have no reason to trust.
  if (!verifySignature(body, signature)) {
    return { ok: false, reason: "bad_signature" };
  }

  let payload: JobTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }

  if (
    !Number.isInteger(payload?.job_id) ||
    !Number.isInteger(payload?.workspace_id) ||
    !Number.isInteger(payload?.exp)
  ) {
    return { ok: false, reason: "malformed" };
  }

  if (payload.exp * 1000 <= now) return { ok: false, reason: "expired" };

  return { ok: true, payload };
}

function sign(body: string): string {
  return createHmac("sha256", env().AI_JOB_SECRET).update(body).digest("base64url");
}

function verifySignature(body: string, signature: string): boolean {
  const expected = Buffer.from(sign(body), "utf8");
  const actual = Buffer.from(signature, "utf8");
  // Length must match before timingSafeEqual, which throws otherwise — and the
  // length of a signature is not a secret.
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

function base64url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}
