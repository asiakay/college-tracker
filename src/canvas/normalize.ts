/**
 * Pure normalization of Canvas JSON into the snapshot records stored in D1.
 * No I/O except crypto.subtle for hashing.
 */

import type { CanvasAssignmentJson, CanvasCourseJson } from "./types";

export class NormalizeError extends Error {}

export interface NormalizedCourse {
  canvas_id: string;
  name: string | null;
  course_code: string | null;
  workflow_state: string | null;
  term_name: string | null;
  start_at: string | null;
  end_at: string | null;
  html_url: string;
  content_hash: string;
}

export interface NormalizedAssignment {
  canvas_id: string;
  canvas_course_id: string;
  name: string;
  due_at: string | null;
  /** YYYY-MM-DD of due_at in the student's timezone. */
  due_date_local: string | null;
  lock_at: string | null;
  unlock_at: string | null;
  points_possible: number | null;
  grading_type: string | null;
  /** JSON array text, e.g. '["online_upload"]'. */
  submission_types: string | null;
  published: number | null;
  html_url: string | null;
  canvas_updated_at: string | null;
  content_hash: string;
}

/** Canvas ids must arrive as strings; tolerate safe integers, reject anything lossy. */
export function canvasId(value: unknown, what: string): string {
  if (typeof value === "string" && /^\d+$|^\d+~\d+$/.test(value)) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  throw new NormalizeError(`Invalid Canvas ${what} id`);
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function isValidTimeZone(tz: string | null | undefined): tz is string {
  if (!tz) return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; }
  catch { return false; }
}

/** Calendar date (YYYY-MM-DD) of an ISO timestamp in `timeZone`. */
export function localDate(iso: string, timeZone: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** SHA-256 of a record with keys sorted, so field order never changes the hash. */
export async function contentHash(record: Record<string, unknown>): Promise<string> {
  const sorted = Object.keys(record).sort().map((k) => [k, record[k] ?? null]);
  const bytes = new TextEncoder().encode(JSON.stringify(sorted));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function normalizeCourse(raw: CanvasCourseJson, origin: string): Promise<NormalizedCourse> {
  const canvas_id = canvasId(raw?.id, "course");
  const fields = {
    canvas_id,
    name: str(raw.name),
    course_code: str(raw.course_code),
    workflow_state: str(raw.workflow_state),
    term_name: str(raw.term?.name),
    start_at: str(raw.start_at),
    end_at: str(raw.end_at),
    html_url: `${origin}/courses/${canvas_id}`,
  };
  return { ...fields, content_hash: await contentHash(fields) };
}

export async function normalizeAssignment(
  raw: CanvasAssignmentJson,
  canvasCourseId: string,
  timeZone: string,
): Promise<NormalizedAssignment> {
  const canvas_id = canvasId(raw?.id, "assignment");
  const name = str(raw.name);
  if (!name) throw new NormalizeError(`Canvas assignment ${canvas_id} has no name`);
  const due_at = str(raw.due_at);
  const types = Array.isArray(raw.submission_types)
    ? raw.submission_types.filter((t): t is string => typeof t === "string")
    : null;
  const fields = {
    canvas_id,
    canvas_course_id: canvasCourseId,
    name,
    due_at,
    due_date_local: due_at ? localDate(due_at, timeZone) : null,
    lock_at: str(raw.lock_at),
    unlock_at: str(raw.unlock_at),
    points_possible: num(raw.points_possible),
    grading_type: str(raw.grading_type),
    submission_types: types ? JSON.stringify(types) : null,
    published: typeof raw.published === "boolean" ? (raw.published ? 1 : 0) : null,
    html_url: str(raw.html_url),
    canvas_updated_at: str(raw.updated_at),
  };
  return { ...fields, content_hash: await contentHash(fields) };
}

/** Title key for matching Canvas assignments to syllabus-imported ones. */
export function normalizeTitle(title: string): string {
  return title
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Initial deliverable_type for assignments created from Canvas (student-owned afterwards). */
export function deliverableTypeFor(submissionTypesJson: string | null): string {
  const types: string[] = submissionTypesJson ? JSON.parse(submissionTypesJson) : [];
  if (types.includes("online_quiz")) return "Exam";
  if (types.includes("discussion_topic")) return "Reading";
  return "Project";
}
