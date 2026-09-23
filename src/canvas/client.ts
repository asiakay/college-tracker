/**
 * Read-only Canvas REST client.
 *
 * - Sends `Accept: application/json+canvas-string-ids` so ids never lose
 *   precision in JavaScript.
 * - Follows `Link: rel="next"` pagination, but only to the configured Canvas
 *   origin, so the token can never be sent to another host.
 * - Requests are strictly sequential (Canvas penalises parallel requests).
 * - Retries 429 / rate-limit 403 / 5xx / network errors with backoff.
 * - Only GET is ever issued; there is no API for other methods.
 */

import type { Env } from "../env";
import type {
  CanvasAssignmentJson, CanvasCourseJson, CanvasModuleItemJson, CanvasModuleJson, CanvasProfileJson, CanvasReader,
} from "./types";

export type CanvasErrorKind =
  | "config" | "auth" | "forbidden" | "not_found" | "rate_limited"
  | "http" | "network" | "budget" | "bad_response";

export class CanvasError extends Error {
  constructor(message: string, readonly kind: CanvasErrorKind, readonly status?: number) {
    super(message);
    this.name = "CanvasError";
  }
}

export interface CanvasConfig {
  /** Origin only, e.g. https://school.instructure.com */
  origin: string;
  /** Host, e.g. school.instructure.com — part of every snapshot row's key. */
  host: string;
  token: string;
}

/** The single place the Canvas credential is read (swap for OAuth later). */
export function getCanvasToken(env: Env): string | null {
  const t = env.CANVAS_API_TOKEN?.trim();
  return t ? t : null;
}

/** Returns null when Canvas is not configured; throws when misconfigured. */
export function getCanvasConfig(env: Env): CanvasConfig | null {
  const raw = env.CANVAS_BASE_URL?.trim();
  const token = getCanvasToken(env);
  if (!raw || !token) return null;
  let url: URL;
  try { url = new URL(raw); }
  catch { throw new CanvasError("CANVAS_BASE_URL is not a valid URL", "config"); }
  if (url.protocol !== "https:") throw new CanvasError("CANVAS_BASE_URL must use https", "config");
  if (url.pathname !== "/" && url.pathname !== "") throw new CanvasError("CANVAS_BASE_URL must be an origin with no path", "config");
  return { origin: url.origin, host: url.host, token };
}

/**
 * Extract the rel="next" URL from a Link header. Header parsing is
 * case-insensitive and URLs are treated as opaque. Throws if the next URL
 * points anywhere other than `origin`.
 */
export function parseNextLink(header: string | null, origin: string): string | null {
  if (!header) return null;
  for (const part of header.split(",")) {
    const m = part.match(/<([^>]+)>\s*;(.*)/);
    if (!m) continue;
    const rels = m[2]!.match(/rel\s*=\s*"?([^";]+)"?/i);
    if (!rels || !rels[1]!.toLowerCase().split(/\s+/).includes("next")) continue;
    let next: URL;
    try { next = new URL(m[1]!); }
    catch { throw new CanvasError("Canvas returned an invalid pagination URL", "bad_response"); }
    if (next.origin !== origin) {
      throw new CanvasError("Canvas pagination URL points to an unexpected host", "bad_response");
    }
    return next.toString();
  }
  return null;
}

export interface CanvasClientOptions {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Hard cap on HTTP requests for this client's lifetime (Workers subrequest limit). */
  maxRequests?: number;
  maxPages?: number;
  maxRetries?: number;
}

const ACCEPT = "application/json+canvas-string-ids";
const LOW_QUOTA = 100;
const USER_AGENT = "college-tracker-canvas-sync";

/** Canvas's own error text from a JSON error body, e.g. "user not authorized to perform that action". */
export function canvasErrorDetail(body: string): string {
  let msg = "";
  try {
    const j = JSON.parse(body) as { errors?: unknown; message?: unknown };
    if (Array.isArray(j.errors)) {
      msg = j.errors.map((e) => (e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : "")).filter(Boolean).join("; ");
    } else if (typeof j.message === "string") {
      msg = j.message;
    }
  } catch { /* not JSON — no detail */ }
  msg = msg.replace(/\s+/g, " ").trim().slice(0, 200);
  return msg ? `: ${msg}` : "";
}

export class CanvasClient implements CanvasReader {
  requestCount = 0;
  lastRateLimitRemaining: number | null = null;

  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRequests: number;
  private readonly maxPages: number;
  private readonly maxRetries: number;

  constructor(private readonly cfg: CanvasConfig, opts: CanvasClientOptions = {}) {
    this.fetchFn = opts.fetch ?? ((input, init) => fetch(input, init));
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.maxRequests = opts.maxRequests ?? 40;
    this.maxPages = opts.maxPages ?? 50;
    this.maxRetries = opts.maxRetries ?? 3;
  }

  getProfile(): Promise<CanvasProfileJson> {
    return this.get<CanvasProfileJson>("/api/v1/users/self/profile");
  }

  listCourses(): Promise<CanvasCourseJson[]> {
    return this.getAll<CanvasCourseJson>("/api/v1/courses", {
      enrollment_state: "active",
      "include[]": ["term", "total_scores"],
    });
  }

  listAssignments(canvasCourseId: string): Promise<CanvasAssignmentJson[]> {
    return this.getAll<CanvasAssignmentJson>(
      `/api/v1/courses/${encodeURIComponent(canvasCourseId)}/assignments`,
      { order_by: "due_at", "include[]": ["submission"] },
    );
  }

  /** Modules with their items; fetches items separately where Canvas left them out. */
  async listModules(canvasCourseId: string): Promise<CanvasModuleJson[]> {
    const course = encodeURIComponent(canvasCourseId);
    const modules = await this.getAll<CanvasModuleJson>(`/api/v1/courses/${course}/modules`, { "include[]": ["items"] });
    for (const m of modules) {
      if (!Array.isArray(m.items)) {
        m.items = await this.getAll<CanvasModuleItemJson>(
          `/api/v1/courses/${course}/modules/${encodeURIComponent(m.id)}/items`,
        );
      }
    }
    return modules;
  }

  getModuleItem(canvasCourseId: string, moduleId: string, itemId: string): Promise<CanvasModuleItemJson> {
    return this.get<CanvasModuleItemJson>(
      `/api/v1/courses/${encodeURIComponent(canvasCourseId)}/modules/${encodeURIComponent(moduleId)}/items/${encodeURIComponent(itemId)}`,
    );
  }

  async get<T>(path: string, params: Record<string, string | string[]> = {}): Promise<T> {
    const res = await this.request(this.buildUrl(path, params));
    return this.parseJson<T>(res);
  }

  async getAll<T>(path: string, params: Record<string, string | string[]> = {}): Promise<T[]> {
    const items: T[] = [];
    let url: string | null = this.buildUrl(path, { per_page: "100", ...params });
    let pages = 0;
    while (url) {
      if (++pages > this.maxPages) {
        throw new CanvasError(`Pagination exceeded ${this.maxPages} pages for ${path}`, "bad_response");
      }
      const res = await this.request(url);
      const page = await this.parseJson<T[]>(res);
      if (!Array.isArray(page)) throw new CanvasError(`Expected a list from ${path}`, "bad_response");
      items.push(...page);
      url = parseNextLink(res.headers.get("link"), this.cfg.origin);
    }
    return items;
  }

  private buildUrl(path: string, params: Record<string, string | string[]>): string {
    const url = new URL(path, this.cfg.origin);
    for (const [k, v] of Object.entries(params)) {
      for (const val of Array.isArray(v) ? v : [v]) url.searchParams.append(k, val);
    }
    return url.toString();
  }

  private async parseJson<T>(res: Response): Promise<T> {
    try { return await res.json() as T; }
    catch { throw new CanvasError("Canvas returned a non-JSON response", "bad_response", res.status); }
  }

  private async request(url: string): Promise<Response> {
    const path = new URL(url).pathname; // for error messages — never the token
    for (let attempt = 0; ; attempt++) {
      if (this.requestCount >= this.maxRequests) {
        throw new CanvasError(`Canvas request budget (${this.maxRequests}) exhausted`, "budget");
      }
      if (this.lastRateLimitRemaining !== null && this.lastRateLimitRemaining < LOW_QUOTA) {
        await this.sleep(1000);
      }
      this.requestCount++;

      let res: Response;
      try {
        res = await this.fetchFn(url, {
          method: "GET",
          headers: { Accept: ACCEPT, Authorization: `Bearer ${this.cfg.token}`, "User-Agent": USER_AGENT },
          redirect: "manual",
        });
      } catch {
        if (attempt < this.maxRetries) { await this.backoff(attempt); continue; }
        throw new CanvasError(`Network error calling Canvas ${path}`, "network");
      }

      const remaining = Number(res.headers.get("x-rate-limit-remaining"));
      if (res.headers.has("x-rate-limit-remaining") && Number.isFinite(remaining)) {
        this.lastRateLimitRemaining = remaining;
      }

      if (res.ok) return res;

      const body = await res.text().catch(() => "");
      const rateLimited = res.status === 429 || (res.status === 403 && /rate limit exceeded/i.test(body));
      if (rateLimited || res.status >= 500) {
        if (attempt < this.maxRetries) { await this.backoff(attempt); continue; }
        throw new CanvasError(
          `Canvas ${path} failed with ${res.status} after ${attempt + 1} attempts`,
          rateLimited ? "rate_limited" : "http", res.status,
        );
      }
      const detail = canvasErrorDetail(body);
      if (res.status === 401) throw new CanvasError(`Canvas rejected the access token (401)${detail}`, "auth", 401);
      if (res.status === 403) throw new CanvasError(`Canvas denied access to ${path} (403)${detail}`, "forbidden", 403);
      if (res.status === 404) throw new CanvasError(`Canvas ${path} not found (404)${detail}`, "not_found", 404);
      throw new CanvasError(`Canvas ${path} failed with ${res.status}`, "http", res.status);
    }
  }

  private backoff(attempt: number): Promise<void> {
    const base = 1000 * 2 ** attempt;
    return this.sleep(base + Math.floor(Math.random() * 250));
  }
}
