/**
 * Micro-task board: academic micro-tasks in the student's priority order,
 * plus progress and movement (status changes over time).
 *
 * Positions and events live in college-tracker's own tables; the shared
 * tasks table (owned by repo-dashboard) only has its status updated.
 */

import { isValidTimeZone, localDate } from "./canvas/normalize";
import type { Env } from "./env";

export const TASK_STATUSES = ["To Do", "In Progress", "Done"] as const;
type TaskStatus = (typeof TASK_STATUSES)[number];

/** Academic micro-tasks only — other repos write to the same tasks table. */
const ACADEMIC = `(t.assignment_id IS NOT NULL OR t.source_repo = 'college-tracker')`;
const DONE_WINDOW_DAYS = 14;
/** D1 allows at most 100 bound parameters per statement. */
const CHUNK = 90;

/**
 * Minutes in a time estimate such as "30m", "1h", "1.5h", "1h 30m", "90 min",
 * "2 hrs" or "45". Returns null when nothing in the string is a duration.
 */
export function parseDuration(text: string): number | null {
  const s = text.trim().toLowerCase();
  if (!s) return null;
  let total = 0;
  let matched = false;
  const re = /(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours|m|min|mins|minute|minutes)?(?![a-z])/g;
  for (const m of s.matchAll(re)) {
    const n = Number(m[1]);
    const unit = m[2] ?? "m";
    total += unit.startsWith("h") ? n * 60 : n;
    matched = true;
  }
  return matched ? Math.round(total) : null;
}

/** Remaining (not Done) estimated minutes per assignment. */
export async function remainingMinutesByAssignment(db: D1Database): Promise<Map<string, number>> {
  const { results } = await db.prepare(
    `SELECT assignment_id, time_spent FROM tasks WHERE assignment_id IS NOT NULL AND status != 'Done'`,
  ).all<{ assignment_id: string; time_spent: string | null }>();
  const out = new Map<string, number>();
  for (const r of results) {
    const mins = r.time_spent ? parseDuration(r.time_spent) : null;
    out.set(r.assignment_id, (out.get(r.assignment_id) ?? 0) + (mins ?? 0));
  }
  return out;
}

/** Working on an assignment means it has started — never that it was submitted. */
export function promoteAssignmentStmt(db: D1Database, assignmentId: string): D1PreparedStatement {
  return db.prepare(`UPDATE assignments SET status = 'In Progress' WHERE id = ? AND status = 'Not Started'`)
    .bind(assignmentId);
}

/** Best effort: history must never block logging a task (e.g. before migration 0009). */
export async function recordTaskCreated(db: D1Database, taskId: unknown, status: unknown): Promise<void> {
  if (typeof taskId !== "number" || typeof status !== "string") return;
  try {
    await db.prepare(`INSERT INTO task_events (task_id, from_status, to_status, at) VALUES (?, NULL, ?, ?)`)
      .bind(taskId, status, new Date().toISOString()).run();
  } catch (e) {
    console.log(`task_events insert skipped: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function filters(url: URL): { sql: string; binds: string[] } {
  const clauses: string[] = [];
  const binds: string[] = [];
  const course = url.searchParams.get("course_id");
  const assignment = url.searchParams.get("assignment_id");
  if (course) { clauses.push("a.course_id = ?"); binds.push(course); }
  if (assignment) { clauses.push("t.assignment_id = ?"); binds.push(assignment); }
  return { sql: clauses.map((c) => ` AND ${c}`).join(""), binds };
}

export async function listMicrotasks(env: Env, url: URL) {
  const f = filters(url);
  const tz = isValidTimeZone(env.CANVAS_TIMEZONE) ? env.CANVAS_TIMEZONE : "UTC";
  const since = new Date(Date.now() - DONE_WINDOW_DAYS * 86_400_000);

  const { results: tasks } = await env.DB.prepare(
    `SELECT * FROM (
       SELECT t.id, t.description, t.status, t.time_spent, t.notes, t.date, t.created_at,
              t.assignment_id, t.okr_id,
              a.title AS assignment_title, a.due_date, a.status AS assignment_status, a.course_id,
              c.name AS course_name, ca.html_url AS canvas_url,
              cc.html_url AS canvas_course_url, cc.canvas_id AS canvas_course_id,
              p.position,
              (SELECT MAX(e.at) FROM task_events e WHERE e.task_id = t.id) AS last_moved_at,
              (SELECT MAX(e.at) FROM task_events e WHERE e.task_id = t.id AND e.to_status = 'Done') AS done_at
       FROM tasks t
       LEFT JOIN assignments a ON a.id = t.assignment_id
       LEFT JOIN courses c ON c.id = a.course_id
       LEFT JOIN canvas_assignments ca ON ca.local_assignment_id = a.id
       LEFT JOIN canvas_courses cc ON cc.local_course_id = a.course_id
       LEFT JOIN task_positions p ON p.task_id = t.id
       WHERE ${ACADEMIC}${f.sql}
     ) x
     WHERE x.status != 'Done' OR COALESCE(x.done_at, x.date) >= ?
     ORDER BY x.position IS NULL, x.position, x.due_date IS NULL, x.due_date, x.created_at, x.id`,
  ).bind(...f.binds, since.toISOString().slice(0, 10)).all();

  const { results: assignments } = await env.DB.prepare(
    `SELECT a.id, a.title, a.due_date, a.status, a.course_id, c.name AS course_name, ca.html_url AS canvas_url,
            COUNT(*) AS total,
            SUM(CASE WHEN t.status = 'Done' THEN 1 ELSE 0 END) AS done,
            SUM(CASE WHEN t.status = 'In Progress' THEN 1 ELSE 0 END) AS in_progress
     FROM tasks t
     JOIN assignments a ON a.id = t.assignment_id
     JOIN courses c ON c.id = a.course_id
     LEFT JOIN canvas_assignments ca ON ca.local_assignment_id = a.id
     WHERE 1 = 1${f.sql}
     GROUP BY a.id
     HAVING done < total OR a.due_date >= DATE('now', '-7 days')
     ORDER BY a.due_date IS NULL, a.due_date, a.title`,
  ).bind(...f.binds).all();

  // Movement, bucketed by local day.
  const { results: events } = await env.DB.prepare(
    `SELECT e.from_status, e.to_status, e.at
     FROM task_events e JOIN tasks t ON t.id = e.task_id
     LEFT JOIN assignments a ON a.id = t.assignment_id
     WHERE e.at >= ? AND ${ACADEMIC}${f.sql}`,
  ).bind(since.toISOString(), ...f.binds).all<{ from_status: string | null; to_status: string; at: string }>();

  const todayKey = localDate(new Date().toISOString(), tz)!;
  const days: Array<{ date: string; done: number }> = [];
  for (let i = DONE_WINDOW_DAYS - 1; i >= 0; i--) {
    days.push({ date: localDate(new Date(Date.now() - i * 86_400_000).toISOString(), tz)!, done: 0 });
  }
  const byDay = new Map(days.map((d) => [d.date, d]));
  let movedToday = 0;
  for (const e of events) {
    const day = localDate(e.at, tz);
    if (!day) continue;
    if (e.to_status === "Done") { const b = byDay.get(day); if (b) b.done++; }
    if (e.from_status !== null && day === todayKey) movedToday++;
  }
  const doneThisWeek = days.slice(-7).reduce((n, d) => n + d.done, 0);

  // Time estimates from each task's time_spent (e.g. "30m", "1h").
  const { results: timeRows } = await env.DB.prepare(
    `SELECT t.assignment_id, t.status, t.time_spent FROM tasks t
     LEFT JOIN assignments a ON a.id = t.assignment_id
     WHERE t.assignment_id IS NOT NULL${f.sql}`,
  ).bind(...f.binds).all<{ assignment_id: string; status: string; time_spent: string | null }>();
  const est = new Map<string, { total: number; remaining: number; unparsed: number }>();
  for (const r of timeRows) {
    const e = est.get(r.assignment_id) ?? { total: 0, remaining: 0, unparsed: 0 };
    const mins = r.time_spent ? parseDuration(r.time_spent) : null;
    if (mins === null) e.unparsed++;
    e.total += mins ?? 0;
    if (r.status !== "Done") e.remaining += mins ?? 0;
    est.set(r.assignment_id, e);
  }
  const weekEnd = localDate(new Date(Date.now() + 7 * 86_400_000).toISOString(), tz)!;
  let dueThisWeekMin = 0;
  const assignmentsWithEstimates = assignments.map((a) => {
    const e = est.get(a["id"] as string) ?? { total: 0, remaining: 0, unparsed: 0 };
    const due = a["due_date"] as string | null;
    if (due && due <= weekEnd) dueThisWeekMin += e.remaining;
    return { ...a, est_total_min: e.total, est_remaining_min: e.remaining, est_unparsed: e.unparsed };
  });

  return {
    tasks,
    progress: {
      assignments: assignmentsWithEstimates,
      movement: {
        timezone: tz, moved_today: movedToday, done_this_week: doneThisWeek, done_by_day: days,
        remaining_due_this_week_min: dueThisWeekMin,
      },
    },
  };
}

export async function saveColumn(
  env: Env, body: Record<string, unknown>,
): Promise<{ error: string; status: number } | { moved: number[]; count: number }> {
  const status = body["status"];
  const ids = body["ordered_ids"];
  if (typeof status !== "string" || !(TASK_STATUSES as readonly string[]).includes(status)) {
    return { error: `status must be one of: ${TASK_STATUSES.join(", ")}`, status: 422 };
  }
  if (!Array.isArray(ids) || ids.length > 500 || !ids.every((i) => Number.isSafeInteger(i) && i > 0)) {
    return { error: "ordered_ids must be an array of up to 500 task ids", status: 422 };
  }
  const orderedIds = ids as number[];
  if (new Set(orderedIds).size !== orderedIds.length) return { error: "ordered_ids contains duplicates", status: 422 };

  const rows = new Map<number, { status: string; assignment_id: string | null }>();
  for (let i = 0; i < orderedIds.length; i += CHUNK) {
    const chunk = orderedIds.slice(i, i + CHUNK);
    const { results } = await env.DB.prepare(
      `SELECT t.id, t.status, t.assignment_id FROM tasks t
       WHERE t.id IN (${chunk.map(() => "?").join(",")}) AND ${ACADEMIC}`,
    ).bind(...chunk).all<{ id: number; status: string; assignment_id: string | null }>();
    for (const r of results) rows.set(r.id, r);
  }
  const unknown = orderedIds.filter((id) => !rows.has(id));
  if (unknown.length) return { error: `Unknown micro-task ids: ${unknown.join(", ")}`, status: 422 };

  const now = new Date().toISOString();
  const stmts: D1PreparedStatement[] = [];
  const moved: number[] = [];
  orderedIds.forEach((id, i) => {
    const row = rows.get(id)!;
    if (row.status !== status) {
      moved.push(id);
      stmts.push(
        env.DB.prepare(`UPDATE tasks SET status = ? WHERE id = ?`).bind(status as TaskStatus, id),
        env.DB.prepare(`INSERT INTO task_events (task_id, from_status, to_status, at) VALUES (?, ?, ?, ?)`)
          .bind(id, row.status, status, now),
      );
      if (row.assignment_id && status !== "To Do") stmts.push(promoteAssignmentStmt(env.DB, row.assignment_id));
    }
    stmts.push(env.DB.prepare(
      `INSERT INTO task_positions (task_id, position, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (task_id) DO UPDATE SET position = excluded.position, updated_at = excluded.updated_at`,
    ).bind(id, i + 1, now));
  });
  if (stmts.length) await env.DB.batch(stmts);
  return { moved, count: orderedIds.length };
}
