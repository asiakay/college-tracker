/**
 * /api/canvas/* — same write-auth rule as the rest of the app (isWriteAuthorized).
 * The Canvas token itself is never returned, logged or sent to the browser.
 */

import { accessConfig, isWriteAuthorized } from "../auth";
import type { Env } from "../env";
import { CanvasClient, CanvasError, getCanvasConfig, type CanvasConfig } from "./client";
import { runCanvasSync, type SyncResult, type SyncTrigger } from "./sync";

const HEADERS = { "Content-Type": "application/json", "Cache-Control": "no-store" };
const CANVAS_ID = /^\d+(~\d+)?$/;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: HEADERS });
}

type ConfigResult = { cfg: CanvasConfig } | { error: string };

function loadConfig(env: Env): ConfigResult {
  try {
    const cfg = getCanvasConfig(env);
    return cfg ? { cfg } : { error: "Canvas is not configured (set CANVAS_BASE_URL and the CANVAS_API_TOKEN secret)" };
  } catch (e) {
    return { error: e instanceof CanvasError ? e.message : "Canvas configuration is invalid" };
  }
}

/** Shared by REST, MCP and cron. Returns { error } when Canvas is not configured. */
export async function runConfiguredSync(env: Env, trigger: SyncTrigger): Promise<SyncResult | { error: string }> {
  const loaded = loadConfig(env);
  if ("error" in loaded) return loaded;
  const { cfg } = loaded;
  const maxRequests = Number(env.CANVAS_MAX_REQUESTS);
  const client = new CanvasClient(cfg, Number.isInteger(maxRequests) && maxRequests > 0 ? { maxRequests } : {});
  return runCanvasSync(env.DB, client, {
    trigger,
    host: cfg.host,
    origin: cfg.origin,
    timeZoneOverride: env.CANVAS_TIMEZONE,
    gradesEnabled: accessConfig(env) !== null,
    stats: () => ({ requests: client.requestCount, rate_limit_remaining: client.lastRateLimitRemaining }),
  });
}

export async function getCanvasStatus(env: Env) {
  const loaded = loadConfig(env);
  const last = await env.DB.prepare(
    `SELECT id, trigger, started_at, finished_at, status, error, summary_json
     FROM canvas_sync_runs ORDER BY id DESC LIMIT 1`,
  ).first<{ summary_json: string | null } & Record<string, unknown>>();
  const lock = await env.DB.prepare(`SELECT locked_until FROM canvas_sync_lock WHERE id = 1`)
    .first<{ locked_until: string | null }>();
  const { summary_json, ...run } = last ?? { summary_json: null };
  return {
    configured: "cfg" in loaded,
    host: "cfg" in loaded ? loaded.cfg.host : null,
    config_error: "error" in loaded ? loaded.error : null,
    timezone_override: env.CANVAS_TIMEZONE ?? null,
    running: !!lock?.locked_until && lock.locked_until > new Date().toISOString(),
    last_run: last ? { ...run, summary: summary_json ? JSON.parse(summary_json) : null } : null,
  };
}

function isUniqueViolation(e: unknown): boolean {
  return e instanceof Error && /UNIQUE constraint failed/i.test(e.message);
}

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const b = await request.json();
    return b && typeof b === "object" && !Array.isArray(b) ? b as Record<string, unknown> : null;
  } catch { return null; }
}

/** Readable, deterministic local course id, e.g. "SCI-133-C101". */
function localCourseIdFor(courseCode: string | null, canvasId: string): string {
  const prefix = (courseCode ?? "").toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-|-$/g, "") || "CANVAS";
  return `${prefix}-C${canvasId}`;
}

export async function handleCanvasRoute(request: Request, env: Env, url: URL): Promise<Response> {
  if (!(await isWriteAuthorized(request, env))) return json({ error: "Unauthorized" }, 401);

  const path = url.pathname;
  const method = request.method;

  if (path === "/api/canvas/status" && method === "GET") {
    return json(await getCanvasStatus(env));
  }

  const loaded = loadConfig(env);
  if ("error" in loaded) return json({ error: loaded.error }, 503);
  const host = loaded.cfg.host;

  if (path === "/api/canvas/sync" && method === "POST") {
    const result = await runConfiguredSync(env, "manual");
    if ("error" in result) return json({ error: result.error }, 503);
    if (result.locked) return json({ error: "A Canvas sync is already running" }, 409);
    return json(result, result.status === "failed" ? 502 : 200);
  }

  if (path === "/api/canvas/courses" && method === "GET") {
    const { results } = await env.DB.prepare(
      `SELECT canvas_id, name, course_code, term_name, workflow_state, start_at, end_at, html_url,
              local_course_id, sync_enabled, removed_at, last_seen_at, last_changed_at
       FROM canvas_courses WHERE canvas_host = ?
       ORDER BY removed_at IS NOT NULL, term_name DESC, name`,
    ).bind(host).all();
    return json({ courses: results });
  }

  if (path === "/api/canvas/assignments" && method === "GET") {
    const courseId = url.searchParams.get("canvas_course_id");
    const { results } = await env.DB.prepare(
      `SELECT canvas_id, canvas_course_id, name, due_at, due_date_local, points_possible, submission_types,
              published, html_url, local_assignment_id, link_method, removed_at, last_changed_at
       FROM canvas_assignments WHERE canvas_host = ?` + (courseId ? ` AND canvas_course_id = ?` : ``) +
      ` ORDER BY due_at IS NULL, due_at, name`,
    ).bind(...(courseId ? [host, courseId] : [host])).all();
    return json({ assignments: results });
  }

  const courseLink = path.match(/^\/api\/canvas\/courses\/([^/]+)\/(link|unlink)$/);
  if (courseLink && method === "POST") {
    const [, canvasId, action] = courseLink as unknown as [string, string, string];
    if (!CANVAS_ID.test(canvasId)) return json({ error: "Invalid Canvas course id" }, 400);
    const cc = await env.DB.prepare(
      `SELECT canvas_id, name, course_code, term_name, local_course_id FROM canvas_courses WHERE canvas_host = ? AND canvas_id = ?`,
    ).bind(host, canvasId).first<{ name: string | null; course_code: string | null; term_name: string | null; local_course_id: string | null }>();
    if (!cc) return json({ error: "Canvas course not found — run a sync first" }, 404);

    if (action === "unlink") {
      await env.DB.prepare(
        `UPDATE canvas_courses SET local_course_id = NULL, sync_enabled = 0 WHERE canvas_host = ? AND canvas_id = ?`,
      ).bind(host, canvasId).run();
      return json({ canvas_id: canvasId, local_course_id: null, sync_enabled: 0 });
    }

    const body = await readBody(request);
    if (!body) return json({ error: "Invalid JSON" }, 400);
    const syncEnabled = body["sync_enabled"] === undefined ? 1 : body["sync_enabled"] ? 1 : 0;
    let localCourseId: string;

    if (body["create"] === true) {
      const okrId = body["okr_id"];
      if (typeof okrId !== "string" || !okrId) return json({ error: "okr_id is required to create a course" }, 422);
      const okr = await env.DB.prepare(`SELECT id FROM okrs WHERE id = ?`).bind(okrId).first();
      if (!okr) return json({ error: `OKR '${okrId}' not found` }, 422);
      localCourseId = typeof body["id"] === "string" && body["id"] ? body["id"] : localCourseIdFor(cc.course_code, canvasId);
      const exists = await env.DB.prepare(`SELECT id FROM courses WHERE id = ?`).bind(localCourseId).first();
      if (exists) return json({ error: `Course '${localCourseId}' already exists — link it with local_course_id instead` }, 409);
      // Name/term are copied once; afterwards they are student-owned.
      await env.DB.prepare(`INSERT INTO courses (id, name, term, okr_id) VALUES (?, ?, ?, ?)`)
        .bind(localCourseId, cc.name ?? localCourseId, cc.term_name ?? "Unknown term", okrId).run();
    } else {
      const lc = body["local_course_id"];
      if (typeof lc !== "string" || !lc) return json({ error: "Provide local_course_id, or create: true with okr_id" }, 422);
      const exists = await env.DB.prepare(`SELECT id FROM courses WHERE id = ?`).bind(lc).first();
      if (!exists) return json({ error: `Course '${lc}' not found` }, 422);
      localCourseId = lc;
    }

    try {
      await env.DB.prepare(
        `UPDATE canvas_courses SET local_course_id = ?, sync_enabled = ? WHERE canvas_host = ? AND canvas_id = ?`,
      ).bind(localCourseId, syncEnabled, host, canvasId).run();
    } catch (e) {
      if (isUniqueViolation(e)) return json({ error: `Course '${localCourseId}' is already linked to another Canvas course` }, 409);
      throw e;
    }
    return json({ canvas_id: canvasId, local_course_id: localCourseId, sync_enabled: syncEnabled });
  }

  const asnLink = path.match(/^\/api\/canvas\/assignments\/([^/]+)\/(link|unlink)$/);
  if (asnLink && method === "POST") {
    const [, canvasId, action] = asnLink as unknown as [string, string, string];
    if (!CANVAS_ID.test(canvasId)) return json({ error: "Invalid Canvas assignment id" }, 400);
    const ca = await env.DB.prepare(
      `SELECT name, due_date_local FROM canvas_assignments WHERE canvas_host = ? AND canvas_id = ?`,
    ).bind(host, canvasId).first<{ name: string; due_date_local: string | null }>();
    if (!ca) return json({ error: "Canvas assignment not found — run a sync first" }, 404);

    if (action === "unlink") {
      // 'ignored' stops future syncs from re-linking or re-creating it.
      await env.DB.prepare(
        `UPDATE canvas_assignments SET local_assignment_id = NULL, link_method = 'ignored' WHERE canvas_host = ? AND canvas_id = ?`,
      ).bind(host, canvasId).run();
      return json({ canvas_id: canvasId, local_assignment_id: null, link_method: "ignored" });
    }

    const body = await readBody(request);
    const assignmentId = body?.["assignment_id"];
    if (typeof assignmentId !== "string" || !assignmentId) return json({ error: "assignment_id is required" }, 422);
    const local = await env.DB.prepare(`SELECT id FROM assignments WHERE id = ?`).bind(assignmentId).first();
    if (!local) return json({ error: `Assignment '${assignmentId}' not found` }, 422);

    const stmts = [
      env.DB.prepare(
        `UPDATE canvas_assignments SET local_assignment_id = ?, link_method = 'manual' WHERE canvas_host = ? AND canvas_id = ?`,
      ).bind(assignmentId, host, canvasId),
      // Canvas owns title and due date of linked assignments.
      env.DB.prepare(`UPDATE assignments SET title = ?, due_date = COALESCE(?, due_date) WHERE id = ?`)
        .bind(ca.name, ca.due_date_local, assignmentId),
    ];
    try {
      await env.DB.batch(stmts);
    } catch (e) {
      if (isUniqueViolation(e)) return json({ error: `Assignment '${assignmentId}' is already linked to another Canvas assignment` }, 409);
      throw e;
    }
    return json({ canvas_id: canvasId, local_assignment_id: assignmentId, link_method: "manual" });
  }

  return json({ error: "Not found" }, 404);
}
