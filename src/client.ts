/**
 * HTTP client for the Cueston API: `Authorization: Bearer sk_…`, JSON in and out, errors as
 * ApiError (`{ error, code, details }`), and retries for rate limits (429, honoring Retry-After)
 * and, for idempotent requests, brief server outages (502/503/504).
 */
import { ApiError, CliError } from "./errors.js";
import { VERSION } from "./version.js";

export interface RequestOptions {
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  /** Send without the key (login). */
  anonymous?: boolean;
  /** Return the response text instead of parsing JSON (CSV, XLIFF). */
  text?: boolean;
  headers?: Record<string, string>;
}

const IDEMPOTENT = new Set(["GET", "HEAD", "PUT", "DELETE"]);
const MAX_ATTEMPTS = 4;
const TIMEOUT_MS = 60_000;

export const userAgent = () =>
  `cueston-cli/${VERSION} node/${process.versions.node} ${process.platform}`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class Client {
  private rpcId = 0;

  constructor(
    public readonly apiUrl: string,
    public readonly key: string | null,
    /** Called before waiting to retry, e.g. to tell the person. */
    private readonly onRetry: (message: string) => void = () => {}
  ) {}

  url(path: string, query?: RequestOptions["query"]): string {
    const url = new URL(`${this.apiUrl}${path.startsWith("/") ? path : `/${path}`}`);
    for (const [name, value] of Object.entries(query ?? {}))
      if (value !== undefined && value !== null && value !== "")
        url.searchParams.set(name, String(value));
    return url.toString();
  }

  requireKey(): string {
    if (!this.key)
      throw new CliError(
        "You're not signed in.",
        "Run `cueston login`, or set CUESTON_API_KEY (a secret key from Settings → API keys)."
      );
    return this.key;
  }

  async request<T = any>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const upper = method.toUpperCase();
    const headers: Record<string, string> = {
      accept: options.text ? "*/*" : "application/json",
      "user-agent": userAgent(),
      ...options.headers,
    };
    if (!options.anonymous) headers.authorization = `Bearer ${this.requireKey()}`;
    let body: string | undefined;
    if (options.body !== undefined) {
      body = typeof options.body === "string" ? options.body : JSON.stringify(options.body);
      headers["content-type"] ??= "application/json";
    }
    const url = this.url(path, options.query);

    for (let attempt = 1; ; attempt++) {
      let response: Response;
      try {
        response = await fetch(url, {
          method: upper,
          headers,
          body,
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (error) {
        const reason =
          (error as Error)?.name === "TimeoutError" ? "the request timed out" : describe(error);
        if (IDEMPOTENT.has(upper) && attempt < MAX_ATTEMPTS) {
          this.onRetry(`Can't reach ${this.apiUrl} (${reason}); retrying…`);
          await sleep(500 * 2 ** attempt);
          continue;
        }
        throw new CliError(
          `Can't reach ${this.apiUrl}: ${reason}.`,
          "Check your connection and --api-url."
        );
      }

      const retryable =
        response.status === 429 ||
        (IDEMPOTENT.has(upper) && [502, 503, 504].includes(response.status));
      if (retryable && attempt < MAX_ATTEMPTS) {
        const retryAfter = Number(response.headers.get("retry-after"));
        const wait =
          Number.isFinite(retryAfter) && retryAfter > 0
            ? Math.min(retryAfter, 30) * 1000
            : 1000 * 2 ** attempt;
        this.onRetry(
          response.status === 429
            ? `Rate limited; retrying in ${Math.round(wait / 1000)}s…`
            : `Server busy (${response.status}); retrying…`
        );
        await response.body?.cancel();
        await sleep(wait);
        continue;
      }

      const text = await response.text();
      if (!response.ok) throw toApiError(response.status, text, upper, path);
      if (options.text) return text as T;
      if (!text) return null as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        return text as T;
      }
    }
  }

  get<T = any>(path: string, query?: RequestOptions["query"]) {
    return this.request<T>("GET", path, { query });
  }
  post<T = any>(path: string, body?: unknown, options: Omit<RequestOptions, "body"> = {}) {
    return this.request<T>("POST", path, { ...options, body: body ?? {} });
  }
  patch<T = any>(path: string, body: unknown) {
    return this.request<T>("PATCH", path, { body });
  }
  put<T = any>(path: string, body: unknown) {
    return this.request<T>("PUT", path, { body });
  }
  delete<T = any>(path: string, query?: RequestOptions["query"]) {
    return this.request<T>("DELETE", path, { query });
  }

  /** One JSON-RPC call to the MCP server (POST /api/mcp). Throws ApiError on a JSON-RPC error. */
  async mcp<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = ++this.rpcId;
    const response = await this.request<any>("POST", "/api/mcp", {
      body: { jsonrpc: "2.0", id, method, params },
    });
    if (response?.error) {
      const data = response.error.data;
      throw new ApiError(
        400,
        `rpc_${response.error.code}`,
        String(response.error.message ?? "MCP error"),
        Array.isArray(data?.details) ? data.details : [],
        response
      );
    }
    return response?.result as T;
  }
}

function describe(error: unknown): string {
  const cause = (error as { cause?: { code?: string; message?: string } })?.cause;
  return cause?.code || cause?.message || (error as Error)?.message || String(error);
}

const HINTS: Record<string, string> = {
  unauthorized: "Your key was revoked or is wrong. Run `cueston login` again.",
  invalid_token: "Your key was revoked or is wrong. Run `cueston login` again.",
  secret_key_required: "Run `cueston login`, or set CUESTON_API_KEY.",
  publishable_key:
    "That's a publishable key (pk_). Use a secret key (sk_) from Settings → API keys.",
  approval_required:
    'This workspace requires review before going live. Use `request-review` instead, e.g. `cueston tours request-review <id> --note "…"`.',
  plan_limit: "Your plan's limit is reached. Upgrade in Settings → Billing.",
};

export function toApiError(status: number, text: string, method = "", path = ""): ApiError {
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  const code =
    typeof body?.code === "string"
      ? body.code
      : typeof body?.error === "string" && status < 500 && body.error.match(/^[a-z_]+$/)
        ? body.error
        : `http_${status}`;
  let message =
    typeof body?.error_description === "string"
      ? body.error_description
      : typeof body?.error === "string"
        ? body.error
        : typeof body?.message === "string"
          ? body.message
          : `${method} ${path} failed with HTTP ${status}`;
  if (status === 403 && Array.isArray(body?.missingPermissions) && body.missingPermissions.length)
    message += ` (needs ${body.missingPermissions.join(", ")})`;
  if (status === 429 && body?.retryAfter) message += ` Try again in ${body.retryAfter}s.`;
  const details = Array.isArray(body?.details) ? body.details.map(String) : [];
  const hint =
    HINTS[code] ??
    (status === 404 ? "Check the id: it may be in another workspace or deleted." : undefined);
  return new ApiError(status, code, message, details, body, hint);
}
