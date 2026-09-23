/**
 * Canvas → D1 reconciliation.
 *
 * Canvas-owned facts are upserted into canvas_* snapshot tables. For linked
 * assignments, only Canvas-owned local columns (title, due_date) are
 * projected into `assignments`. Student-owned state — status, grade, notes,
 * blocker, weight, deliverable_type, okr_id and every task — is never
 * written here.
 *
 * Idempotent: natural-key upserts, deterministic ids for assignments created
 * from Canvas, and projections that only fire when values differ. Each
 * course is written in one D1 batch (a single transaction), so a failure
 * leaves that course untouched and the next run simply retries.
 */

import { CanvasError } from "./client";
import {
  type NormalizedAssignment, type NormalizedCourse,
  deliverableTypeFor, isValidTimeZone, normalizeAssignment, normalizeCourse, normalizeTitle,
} from "./normalize";
import type { CanvasReader } from "./types";

export type SyncTrigger = "manual" | "cron" | "mcp";
export type SyncStatus = "succeeded" | "partial" | "failed";

export interface SyncOptions {
  trigger: SyncTrigger;
  host: string;
  origin: string;
  timeZoneOverride?: string | undefined;
  now?: () => Date;
  /** Canvas request stats, recorded in the summary. */
  stats?: () => { requests: number; rate_limit_remaining: number | null };
}

export interface SyncSummary {
  timezone: string | null;
  courses: { seen: number; created: number; changed: number; unchanged: number; removed: number; skipped: number };
  assignments: {
    seen: number; created: number; changed: number; unchanged: number; removed: number; skipped: number;
    local_created: number; local_updated: number; linked_by_title: number;
  };
  synced_courses: string[];
  undated: Array<{ canvas_id: string; canvas_course_id: string; name: string; local_assignment_id: string | null }>;
  possible_duplicates: Array<{ canvas_id: string; canvas_course_id: string; name: string; local_candidates: string[] }>;
  errors: Array<{ canvas_course_id?: string; kind: string; message: string }>;
  canvas_requests?: number;
  rate_limit_remaining?: number | null;
}

export type SyncResult =
  | { locked: true }
  | { locked: false; run_id: number; status: SyncStatus; summary: SyncSummary };

const LEASE_MS = 10 * 60 * 1000;

function emptySummary(): SyncSummary {
  return {
    timezone: null,
    courses: { seen: 0, created: 0, changed: 0, unchanged: 0, removed: 0, skipped: 0 },
    assignments: {
      seen: 0, created: 0, changed: 0, unchanged: 0, removed: 0, skipped: 0,
      local_created: 0, local_updated: 0, linked_by_title: 0,
    },
    synced_courses: [],
    undated: [],
    possible_duplicates: [],
    errors: [],
  };
}

function errorInfo(e: unknown): { kind: string; message: string } {
  if (e instanceof CanvasError) return { kind: e.kind, message: e.message };
  return { kind: "internal", message: e instanceof Error ? e.message : String(e) };
}

/** Deterministic local id for an assignment created from Canvas. */
export function canvasAssignmentLocalId(localCourseId: string, canvasId: string): string {
  return `${localCourseId}-C${canvasId}`;
}

export async function runCanvasSync(db: D1Database, reader: CanvasReader, opts: SyncOptions): Promise<SyncResult> {
  const now = opts.now ?? (() => new Date());
  const startedAt = now().toISOString();

  // Acquire the single-row lease; an expired lease (crashed run) is reclaimable.
  const lease = await db.prepare(
    `UPDATE canvas_sync_lock SET run_id = NULL, locked_until = ?
     WHERE id = 1 AND (locked_until IS NULL OR locked_until < ?)`,
  ).bind(new Date(now().getTime() + LEASE_MS).toISOString(), startedAt).run();
  if (!lease.meta.changes) return { locked: true };

  const run = await db.prepare(
    `INSERT INTO canvas_sync_runs (trigger, started_at, status) VALUES (?, ?, 'running') RETURNING id`,
  ).bind(opts.trigger, startedAt).first<{ id: number }>();
  const runId = run!.id;
  await db.prepare(`UPDATE canvas_sync_lock SET run_id = ? WHERE id = 1`).bind(runId).run();

  const summary = emptySummary();
  let status: SyncStatus = "succeeded";
  let fatal: string | null = null;

  try {
    const profile = await reader.getProfile();
    const timeZone = isValidTimeZone(opts.timeZoneOverride) ? opts.timeZoneOverride
      : isValidTimeZone(profile.time_zone) ? profile.time_zone : "UTC";
    summary.timezone = timeZone;

    // Each run stamps last_seen_at with its own start time; rows not stamped
    // were absent from Canvas' listing this run.
    await syncCourses(db, reader, opts, startedAt, summary);

    const enabled = await db.prepare(
      `SELECT canvas_id, local_course_id FROM canvas_courses
       WHERE canvas_host = ? AND sync_enabled = 1 AND local_course_id IS NOT NULL AND removed_at IS NULL
       ORDER BY canvas_id`,
    ).bind(opts.host).all<{ canvas_id: string; local_course_id: string }>();

    for (const course of enabled.results) {
      try {
        await syncCourseAssignments(db, reader, opts, course.canvas_id, course.local_course_id, timeZone, startedAt, summary);
        summary.synced_courses.push(course.canvas_id);
      } catch (e) {
        // Auth and budget failures affect every remaining course: stop here.
        if (e instanceof CanvasError && (e.kind === "auth" || e.kind === "budget")) throw e;
        summary.errors.push({ canvas_course_id: course.canvas_id, ...errorInfo(e) });
        status = "partial";
      }
    }
  } catch (e) {
    const info = errorInfo(e);
    summary.errors.push(info);
    // A budget stop after some work is partial; anything else before completion is failed.
    status = info.kind === "budget" && summary.synced_courses.length > 0 ? "partial" : "failed";
    fatal = info.message;
  }

  if (opts.stats) {
    const s = opts.stats();
    summary.canvas_requests = s.requests;
    summary.rate_limit_remaining = s.rate_limit_remaining;
  }

  await db.batch([
    db.prepare(
      `UPDATE canvas_sync_runs SET finished_at = ?, status = ?, summary_json = ?, error = ? WHERE id = ?`,
    ).bind(now().toISOString(), status, JSON.stringify(summary), fatal, runId),
    db.prepare(`UPDATE canvas_sync_lock SET run_id = NULL, locked_until = NULL WHERE id = 1 AND run_id = ?`).bind(runId),
  ]);

  return { locked: false, run_id: runId, status, summary };
}

async function syncCourses(
  db: D1Database, reader: CanvasReader, opts: SyncOptions, runStamp: string, summary: SyncSummary,
): Promise<void> {
  const raw = await reader.listCourses();
  const courses: NormalizedCourse[] = [];
  for (const r of raw) {
    try { courses.push(await normalizeCourse(r, opts.origin)); }
    catch { summary.courses.skipped++; }
  }

  const existing = await db.prepare(
    `SELECT canvas_id, content_hash FROM canvas_courses WHERE canvas_host = ?`,
  ).bind(opts.host).all<{ canvas_id: string; content_hash: string }>();
  const prevHash = new Map(existing.results.map((r) => [r.canvas_id, r.content_hash]));

  const stmts: D1PreparedStatement[] = courses.map((c) => {
    const prev = prevHash.get(c.canvas_id);
    if (prev === undefined) summary.courses.created++;
    else if (prev !== c.content_hash) summary.courses.changed++;
    else summary.courses.unchanged++;
    return db.prepare(
      `INSERT INTO canvas_courses
         (canvas_host, canvas_id, name, course_code, workflow_state, term_name, start_at, end_at, html_url,
          content_hash, first_seen_at, last_seen_at, last_changed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (canvas_host, canvas_id) DO UPDATE SET
         name = excluded.name, course_code = excluded.course_code, workflow_state = excluded.workflow_state,
         term_name = excluded.term_name, start_at = excluded.start_at, end_at = excluded.end_at,
         html_url = excluded.html_url,
         last_changed_at = CASE WHEN canvas_courses.content_hash <> excluded.content_hash
                                THEN excluded.last_changed_at ELSE canvas_courses.last_changed_at END,
         content_hash = excluded.content_hash,
         last_seen_at = excluded.last_seen_at,
         removed_at = NULL`,
    ).bind(
      opts.host, c.canvas_id, c.name, c.course_code, c.workflow_state, c.term_name, c.start_at, c.end_at, c.html_url,
      c.content_hash, runStamp, runStamp, runStamp,
    );
  });
  summary.courses.seen = courses.length;

  // Only mark removals when every listed course was understood.
  const markRemoved = summary.courses.skipped === 0;
  if (markRemoved) {
    stmts.push(db.prepare(
      `UPDATE canvas_courses SET removed_at = ?
       WHERE canvas_host = ? AND last_seen_at <> ? AND removed_at IS NULL`,
    ).bind(runStamp, opts.host, runStamp));
  }
  if (!stmts.length) return;
  const results = await db.batch(stmts);
  if (markRemoved) summary.courses.removed = results[results.length - 1]!.meta.changes ?? 0;
}

interface LocalAssignment { id: string; title: string; due_date: string }

async function syncCourseAssignments(
  db: D1Database, reader: CanvasReader, opts: SyncOptions,
  canvasCourseId: string, localCourseId: string, timeZone: string, runStamp: string, summary: SyncSummary,
): Promise<void> {
  const localCourse = await db.prepare(`SELECT id, okr_id FROM courses WHERE id = ?`)
    .bind(localCourseId).first<{ id: string; okr_id: string }>();
  if (!localCourse) throw new Error(`Linked local course '${localCourseId}' no longer exists`);

  const raw = await reader.listAssignments(canvasCourseId);
  const assignments: NormalizedAssignment[] = [];
  let skipped = 0;
  for (const r of raw) {
    try { assignments.push(await normalizeAssignment(r, canvasCourseId, timeZone)); }
    catch { skipped++; }
  }

  const snapRows = await db.prepare(
    `SELECT ca.canvas_id, ca.content_hash, ca.local_assignment_id, ca.link_method,
            a.id AS a_id, a.title AS a_title, a.due_date AS a_due_date
     FROM canvas_assignments ca LEFT JOIN assignments a ON a.id = ca.local_assignment_id
     WHERE ca.canvas_host = ? AND ca.canvas_course_id = ?`,
  ).bind(opts.host, canvasCourseId).all<{
    canvas_id: string; content_hash: string; local_assignment_id: string | null; link_method: string | null;
    a_id: string | null; a_title: string | null; a_due_date: string | null;
  }>();
  const snap = new Map(snapRows.results.map((r) => [r.canvas_id, r]));

  // Local assignments in this course not linked to any Canvas assignment.
  const unlinked = await db.prepare(
    `SELECT a.id, a.title, a.due_date FROM assignments a
     LEFT JOIN canvas_assignments ca ON ca.local_assignment_id = a.id
     WHERE a.course_id = ? AND ca.id IS NULL`,
  ).bind(localCourseId).all<LocalAssignment>();
  const claimed = new Set<string>();
  const localIds = new Set((await db.prepare(`SELECT id FROM assignments WHERE course_id = ?`)
    .bind(localCourseId).all<{ id: string }>()).results.map((r) => r.id));

  const stmts: D1PreparedStatement[] = [];
  const undated: SyncSummary["undated"] = [];
  const duplicates: SyncSummary["possible_duplicates"] = [];
  const counts = { created: 0, changed: 0, unchanged: 0, local_created: 0, local_updated: 0, linked_by_title: 0 };

  const link = (canvasId: string, localId: string, method: "created" | "title_match") =>
    db.prepare(
      `UPDATE canvas_assignments SET local_assignment_id = ?, link_method = ?
       WHERE canvas_host = ? AND canvas_id = ? AND local_assignment_id IS NULL`,
    ).bind(localId, method, opts.host, canvasId);

  // Overwrite only the Canvas-owned local columns, and only when they differ.
  const project = (a: NormalizedAssignment, local: { id: string; title: string | null; due_date: string | null }) => {
    const newDue = a.due_date_local ?? local.due_date;
    if (local.title === a.name && local.due_date === newDue) return;
    counts.local_updated++;
    stmts.push(db.prepare(`UPDATE assignments SET title = ?, due_date = ? WHERE id = ?`).bind(a.name, newDue, local.id));
  };

  for (const a of assignments) {
    const prev = snap.get(a.canvas_id);
    if (!prev) counts.created++;
    else if (prev.content_hash !== a.content_hash) counts.changed++;
    else counts.unchanged++;

    stmts.push(db.prepare(
      `INSERT INTO canvas_assignments
         (canvas_host, canvas_id, canvas_course_id, name, due_at, due_date_local, lock_at, unlock_at,
          points_possible, grading_type, submission_types, published, html_url, canvas_updated_at,
          content_hash, first_seen_at, last_seen_at, last_changed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (canvas_host, canvas_id) DO UPDATE SET
         canvas_course_id = excluded.canvas_course_id, name = excluded.name, due_at = excluded.due_at,
         due_date_local = excluded.due_date_local, lock_at = excluded.lock_at, unlock_at = excluded.unlock_at,
         points_possible = excluded.points_possible, grading_type = excluded.grading_type,
         submission_types = excluded.submission_types, published = excluded.published,
         html_url = excluded.html_url, canvas_updated_at = excluded.canvas_updated_at,
         last_changed_at = CASE WHEN canvas_assignments.content_hash <> excluded.content_hash
                                THEN excluded.last_changed_at ELSE canvas_assignments.last_changed_at END,
         content_hash = excluded.content_hash,
         last_seen_at = excluded.last_seen_at,
         removed_at = NULL`,
    ).bind(
      opts.host, a.canvas_id, canvasCourseId, a.name, a.due_at, a.due_date_local, a.lock_at, a.unlock_at,
      a.points_possible, a.grading_type, a.submission_types, a.published, a.html_url, a.canvas_updated_at,
      a.content_hash, runStamp, runStamp, runStamp,
    ));

    if (prev?.link_method === "ignored") continue; // student unlinked it

    // Already linked: project Canvas-owned fields.
    if (prev?.local_assignment_id && prev.a_id) {
      project(a, { id: prev.a_id, title: prev.a_title, due_date: prev.a_due_date });
      if (!a.due_date_local) {
        undated.push({ canvas_id: a.canvas_id, canvas_course_id: canvasCourseId, name: a.name, local_assignment_id: prev.a_id });
      }
      continue;
    }

    // Unlinked. assignments.due_date is NOT NULL, so undated work is reported, not created.
    if (!a.due_date_local) {
      undated.push({ canvas_id: a.canvas_id, canvas_course_id: canvasCourseId, name: a.name, local_assignment_id: null });
      continue;
    }

    const key = normalizeTitle(a.name);
    const matches = unlinked.results.filter((l) => !claimed.has(l.id) && normalizeTitle(l.title) === key);
    if (matches.length === 1) {
      const m = matches[0]!;
      claimed.add(m.id);
      counts.linked_by_title++;
      stmts.push(link(a.canvas_id, m.id, "title_match"));
      project(a, m);
      continue;
    }
    if (matches.length > 1) {
      duplicates.push({
        canvas_id: a.canvas_id, canvas_course_id: canvasCourseId, name: a.name, local_candidates: matches.map((m) => m.id),
      });
      continue;
    }

    // No title match: create a local row with a deterministic id.
    const sameDay = unlinked.results.filter((l) => !claimed.has(l.id) && l.due_date === a.due_date_local);
    if (sameDay.length) {
      duplicates.push({
        canvas_id: a.canvas_id, canvas_course_id: canvasCourseId, name: a.name, local_candidates: sameDay.map((m) => m.id),
      });
    }
    const localId = canvasAssignmentLocalId(localCourseId, a.canvas_id);
    if (!localIds.has(localId)) counts.local_created++;
    stmts.push(db.prepare(
      `INSERT OR IGNORE INTO assignments (id, course_id, okr_id, title, due_date, deliverable_type, weight_pct)
       VALUES (?, ?, ?, ?, ?, ?, 0)`,
    ).bind(localId, localCourseId, localCourse.okr_id, a.name, a.due_date_local, deliverableTypeFor(a.submission_types)));
    stmts.push(link(a.canvas_id, localId, "created"));
  }

  // Soft-mark assignments Canvas no longer lists — only when the whole listing was understood.
  const markRemoved = skipped === 0;
  if (markRemoved) {
    stmts.push(db.prepare(
      `UPDATE canvas_assignments SET removed_at = ?
       WHERE canvas_host = ? AND canvas_course_id = ? AND last_seen_at <> ? AND removed_at IS NULL`,
    ).bind(runStamp, opts.host, canvasCourseId, runStamp));
  }

  const results = stmts.length ? await db.batch(stmts) : [];

  // Tally only after the batch committed.
  const s = summary.assignments;
  s.seen += assignments.length;
  s.skipped += skipped;
  s.created += counts.created;
  s.changed += counts.changed;
  s.unchanged += counts.unchanged;
  s.local_created += counts.local_created;
  s.local_updated += counts.local_updated;
  s.linked_by_title += counts.linked_by_title;
  if (markRemoved && results.length) s.removed += results[results.length - 1]!.meta.changes ?? 0;
  summary.undated.push(...undated);
  summary.possible_duplicates.push(...duplicates);
}
