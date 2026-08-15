/**
 * The REST client every tool goes through. Deliberately thin: the server owns
 * ordering, tenancy and validation, and duplicating any of that here would give
 * the MCP surface a second opinion about rules that only have one answer.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail?: unknown,
  ) {
    super(`${status} ${code}`);
    this.name = "ApiError";
  }
}

export type ClientConfig = {
  baseUrl: string;
  apiKey: string;
};

export function readConfig(env: NodeJS.ProcessEnv): ClientConfig {
  const baseUrl = env.KANBAN_API_URL?.trim();
  const apiKey = env.KANBAN_API_KEY?.trim();

  const missing = [
    !baseUrl && "KANBAN_API_URL",
    !apiKey && "KANBAN_API_KEY",
  ].filter(Boolean);

  if (missing.length > 0) {
    throw new Error(
      `Missing environment variable(s): ${missing.join(", ")}. ` +
        `Register the server with: claude mcp add conduit ` +
        `--env KANBAN_API_URL=https://your-app --env KANBAN_API_KEY=cdt_... ` +
        `-- node ./mcp/dist/index.js`,
    );
  }

  return {
    // Trailing slashes would produce `//api/v1/...`, which some hosts 404.
    baseUrl: baseUrl!.replace(/\/+$/, ""),
    apiKey: apiKey!,
  };
}

export class ConduitClient {
  constructor(private readonly config: ClientConfig) {}

  async request<T>(
    method: string,
    path: string,
    options: { query?: Record<string, string | number | undefined>; body?: unknown } = {},
  ): Promise<T> {
    const url = new URL(`${this.config.baseUrl}/api/v1${path}`);
    for (const [name, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined && value !== "") {
        url.searchParams.set(name, String(value));
      }
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${this.config.apiKey}`,
          accept: "application/json",
          ...(options.body === undefined
            ? {}
            : { "content-type": "application/json" }),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });
    } catch (cause) {
      // The URL is safe to show; the key is never in it.
      throw new ApiError(0, "network_error", {
        url: url.toString(),
        cause: cause instanceof Error ? cause.message : String(cause),
      });
    }

    const text = await response.text();
    const payload = text ? safeParse(text) : null;

    if (!response.ok) {
      const code =
        (payload as { error?: string } | null)?.error ??
        `http_${response.status}`;
      throw new ApiError(
        response.status,
        code,
        (payload as { detail?: unknown } | null)?.detail,
      );
    }

    return payload as T;
  }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { error: "non_json_response", body: text.slice(0, 200) };
  }
}

/**
 * Turns an error into something the model can act on.
 *
 * The 404 wording matters. The API answers "no such id" and "that id belongs to
 * another workspace" identically and on purpose, so this must not invent a
 * distinction the server refused to make — otherwise the tool description
 * becomes the enumeration oracle the API was careful not to be.
 */
export function describeError(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return error instanceof Error ? error.message : String(error);
  }

  switch (error.status) {
    case 0:
      return `Could not reach the Conduit API. ${JSON.stringify(error.detail)}`;
    case 401:
      return "Unauthorized. KANBAN_API_KEY is missing, revoked, or not a workspace key.";
    case 404:
      return "Not found. The id does not exist, or it belongs to a workspace this key cannot see — the API does not distinguish the two. Do not retry with other ids.";
    case 409:
      return `Conflict: ${error.code}.`;
    case 400:
      return `Rejected: ${error.code}${
        error.detail ? ` ${JSON.stringify(error.detail)}` : ""
      }`;
    default:
      return `Request failed: ${error.status} ${error.code}`;
  }
}
