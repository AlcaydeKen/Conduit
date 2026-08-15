/**
 * One frozen body, serialized one way. Cross-tenant access and a genuinely
 * missing row must be byte-identical on the wire — anything that varies between
 * the two turns sequential ids into a tenant enumeration oracle.
 */
const NOT_FOUND_BODY = JSON.stringify({ error: "not_found" });

const JSON_HEADERS = { "content-type": "application/json" } as const;

/** The only 404 in the system. Never add a `reason` to this. */
export function notFound(): Response {
  return new Response(NOT_FOUND_BODY, { status: 404, headers: JSON_HEADERS });
}

export function unauthorized(): Response {
  return Response.json({ error: "unauthorized" }, { status: 401 });
}

export function badRequest(error: string, detail?: unknown): Response {
  return Response.json({ error, detail }, { status: 400 });
}

export function conflict(error: string): Response {
  return Response.json({ error }, { status: 409 });
}

/**
 * The only 403 in the system, and it is not a tenancy answer.
 *
 * It says "your key may not do this", which is a fact about the caller's own
 * credential. It is returned before any row is loaded, so it can never stand in
 * for the 404 that a missing-or-other-tenant row must always produce.
 */
export function insufficientScope(required: string): Response {
  return Response.json(
    { error: "insufficient_scope", required },
    { status: 403 },
  );
}

export function ok<T>(data: T): Response {
  return Response.json(data, {
    status: 200,
    headers: { "cache-control": "no-store" },
  });
}
