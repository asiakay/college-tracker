/**
 * Break an assignment down from its linked Canvas module file.
 *
 * preview: download the file (read-only), extract its text and links, and ask
 *          Claude for concrete ordered steps. Writes nothing.
 * save:    add the steps the student kept as To Do micro-tasks, optionally
 *          replacing that assignment's untouched To Do tasks.
 */

import Anthropic from "@anthropic-ai/sdk";
import { CanvasError } from "./canvas/client";
import { canvasClient, loadConfig } from "./canvas/routes";
import { DocError, extractDocument, type ExtractedDoc } from "./docs";
import type { Env } from "./env";
import { fileIdFromDownloadUrl, saveMaterialLinks } from "./materials";
import { todoColumnIds } from "./microtasks";

const MAX_STEPS = 12;
const MAX_SAVE_STEPS = 20;

type Failure = { error: string; status: number };

export interface Step {
  description: string;
  time_estimate: string | null;
  link_url: string | null;
  link_label: string | null;
  detail: string | null;
}

const SYSTEM = `You turn a college assignment's instruction file into a short checklist of concrete steps
for the student. Read the whole file: instructors often hide separate tasks in it (slides to review,
videos to watch, diagrams to study, worksheets with several parts, where and how to submit).

Rules:
- One step per distinct action, in the order the student should do them. 3–12 steps.
- Each description is an imperative action of at most 80 characters, specific to this file,
  e.g. "Watch the Scientific Method video (11:48)" or "Answer Q8–22: match each scenario to a step".
  Never write generic steps like "Read the instructions" or "Review requirements".
- Split long question sets into their sections, naming the question numbers.
- The last step is how to submit, if the file says.
- time_estimate is a realistic duration like "15m", "40m" or "1h 30m" (use lengths stated in the file).
- link_url must be copied exactly from allowed_links, or null. Use the Canvas assignment link for the
  submit step when one is given. link_label is 1–4 words naming the resource, e.g. "Khan Academy video".
- detail (optional, at most 200 characters) holds what the student needs to know to do the step,
  e.g. page numbers or which questions.
- warnings list anything that conflicts or is confusing, e.g. a due date in the file that differs from
  the Canvas due date, a missing attachment, or a broken-looking link. Empty if none.`;

const SCHEMA = {
  type: "object",
  properties: {
    steps: {
      type: "array",
      items: {
        type: "object",
        properties: {
          description: { type: "string" },
          time_estimate: { type: ["string", "null"] },
          link_url: { type: ["string", "null"] },
          link_label: { type: ["string", "null"] },
          detail: { type: ["string", "null"] },
        },
        required: ["description", "time_estimate", "link_url", "link_label", "detail"],
        additionalProperties: false,
      },
    },
    warnings: { type: "array", items: { type: "string" } },
  },
  required: ["steps", "warnings"],
  additionalProperties: false,
} as const;

function clip(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.replace(/\s+/g, " ").trim();
  return s ? s.slice(0, max) : null;
}

export function httpUrl(v: unknown): string | null {
  if (typeof v !== "string" || v.length > 2000) return null;
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch { return null; }
}

function base64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function readMaterial(db: D1Database, assignmentId: string) {
  try {
    return await db.prepare(`SELECT title, html_url, download_url FROM canvas_materials WHERE assignment_id = ?`)
      .bind(assignmentId).first<{ title: string; html_url: string; download_url: string | null }>();
  } catch (e) {
    if (e instanceof Error && /no such (table: canvas_materials|column: download_url)/.test(e.message)) return null;
    throw e;
  }
}

async function todoCount(db: D1Database, assignmentId: string): Promise<number> {
  const row = await db.prepare(
    `SELECT COUNT(*) AS n FROM tasks WHERE assignment_id = ? AND status = 'To Do' AND source_repo = 'college-tracker'`,
  ).bind(assignmentId).first<{ n: number }>();
  return row?.n ?? 0;
}

export async function previewBreakdown(env: Env, assignmentId: string): Promise<
  { steps: Step[]; warnings: string[]; source: { title: string; html_url: string }; replaceable_todo: number } | Failure
> {
  const asn = await env.DB.prepare(
    `SELECT a.id, a.title, a.due_date, a.deliverable_type, c.name AS course_name,
            ca.html_url AS canvas_url, ca.points_possible, cc.html_url AS course_url
     FROM assignments a JOIN courses c ON c.id = a.course_id
     LEFT JOIN canvas_assignments ca ON ca.local_assignment_id = a.id
     LEFT JOIN canvas_courses cc ON cc.local_course_id = a.course_id
     WHERE a.id = ?`,
  ).bind(assignmentId).first<{
    title: string; due_date: string | null; deliverable_type: string | null; course_name: string;
    canvas_url: string | null; points_possible: number | null; course_url: string | null;
  }>();
  if (!asn) return { error: "Assignment not found", status: 404 };

  const material = await readMaterial(env.DB, assignmentId);
  if (!material) return { error: "Link a Canvas module file to this assignment first", status: 422 };
  if (!material.download_url) {
    return { error: `“${material.title}” isn't a file — link the module file (.docx or PDF) with the instructions`, status: 422 };
  }
  if (!env.ANTHROPIC_API_KEY) return { error: "ANTHROPIC_API_KEY not configured", status: 503 };
  const loaded = loadConfig(env);
  if ("error" in loaded) return { error: loaded.error, status: 503 };
  const fileId = fileIdFromDownloadUrl(loaded.cfg.origin, material.download_url);
  if (!fileId) return { error: "The linked file's Canvas link isn't recognised — link it again", status: 422 };

  let doc: ExtractedDoc;
  try {
    const file = await canvasClient(env, loaded.cfg).downloadFile(fileId);
    doc = await extractDocument(file.bytes, file.contentType, file.name);
    await saveMaterialLinks(env.DB, assignmentId, doc.linkItems); // keep Materials in sync with the file
  } catch (e) {
    if (e instanceof DocError) return { error: e.message, status: 422 };
    if (e instanceof CanvasError) return { error: e.message, status: e.kind === "not_found" ? 404 : 502 };
    throw e;
  }

  const courseAssignments = asn.course_url ? `${asn.course_url.replace(/\/+$/, "")}/assignments` : null;
  const allowed = [...new Set([
    ...doc.links,
    ...[asn.canvas_url, courseAssignments, material.html_url].map(httpUrl).filter((u): u is string => !!u),
  ])];
  const context = {
    assignment: asn.title,
    course: asn.course_name,
    type: asn.deliverable_type,
    canvas_due_date: asn.due_date,
    points: asn.points_possible,
    file: material.title,
    canvas_assignment_link: httpUrl(asn.canvas_url),
    canvas_assignments_page: courseAssignments,
    allowed_links: allowed,
  };
  const content: Anthropic.Beta.BetaContentBlockParam[] = doc.kind === "pdf"
    ? [
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64(doc.bytes) } },
        { type: "text", text: `Assignment context:\n${JSON.stringify(context)}\n\nThe instruction file is the attached PDF.` },
      ]
    : [{ type: "text", text: `Assignment context:\n${JSON.stringify(context)}\n\nInstruction file text:\n<file>\n${doc.text}\n</file>` }];

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, fetch: (input, init) => fetch(input, init) });
  let response: Anthropic.Beta.BetaMessage;
  try {
    response = await client.beta.messages.create({
      model: "claude-opus-5",
      max_tokens: 8000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium", format: { type: "json_schema", schema: SCHEMA } },
      system: SYSTEM,
      messages: [{ role: "user", content }],
    });
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) return { error: "Claude is busy — try again in a minute", status: 503 };
    if (e instanceof Anthropic.APIError) return { error: `Claude request failed (${e.status ?? "network"})`, status: 502 };
    throw e;
  }
  if (response.stop_reason === "refusal") return { error: "Claude declined to break this file down", status: 502 };
  const text = response.content.find((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")?.text;
  let parsed: { steps?: unknown[]; warnings?: unknown[] };
  try { parsed = JSON.parse(text ?? ""); }
  catch { return { error: "Claude returned an unreadable breakdown", status: 502 }; }

  // Only links that are really in the file (or the Canvas assignment) survive.
  const allowedSet = new Set(allowed);
  const steps: Step[] = [];
  for (const raw of parsed.steps ?? []) {
    const s = raw as Record<string, unknown>;
    const description = clip(s["description"], 120);
    if (!description) continue;
    const link = httpUrl(s["link_url"]);
    const linkUrl = link && allowedSet.has(link) ? link : null;
    steps.push({
      description,
      time_estimate: clip(s["time_estimate"], 20),
      link_url: linkUrl,
      link_label: linkUrl ? clip(s["link_label"], 60) ?? "Link" : null,
      detail: clip(s["detail"], 300),
    });
    if (steps.length === MAX_STEPS) break;
  }
  if (!steps.length) return { error: "Claude couldn't find steps in this file", status: 502 };
  const warnings = (parsed.warnings ?? []).map((w) => clip(w, 300)).filter((w): w is string => !!w).slice(0, 5);

  return {
    steps, warnings,
    source: { title: material.title, html_url: material.html_url },
    replaceable_todo: await todoCount(env.DB, assignmentId),
  };
}

interface SaveStep { description: string; time_spent: string | null; link_url: string | null; link_label: string | null; notes: string | null }

function validateSteps(body: Record<string, unknown>): SaveStep[] | string {
  const raw = body["steps"];
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_SAVE_STEPS) return `steps must be an array of 1–${MAX_SAVE_STEPS} steps`;
  const out: SaveStep[] = [];
  for (const [i, r] of raw.entries()) {
    if (!r || typeof r !== "object") return `step ${i + 1} is invalid`;
    const s = r as Record<string, unknown>;
    const description = clip(s["description"], 200);
    if (!description) return `step ${i + 1} needs a description`;
    const link = s["link_url"] == null || s["link_url"] === "" ? null : httpUrl(s["link_url"]);
    if (s["link_url"] != null && s["link_url"] !== "" && !link) return `step ${i + 1} has an invalid link`;
    out.push({
      description,
      time_spent: clip(s["time_spent"], 20),
      link_url: link,
      link_label: link ? clip(s["link_label"], 60) ?? "Link" : null,
      notes: clip(s["notes"], 500),
    });
  }
  return out;
}

export async function saveBreakdown(env: Env, assignmentId: string, body: Record<string, unknown>): Promise<
  { created: number; removed: number } | Failure
> {
  const steps = validateSteps(body);
  if (typeof steps === "string") return { error: steps, status: 422 };
  const asn = await env.DB.prepare(`SELECT okr_id FROM assignments WHERE id = ?`).bind(assignmentId).first<{ okr_id: string }>();
  if (!asn) return { error: "Assignment not found", status: 404 };

  const replace = body["replace_todo"] === true;
  const removed = replace ? await todoCount(env.DB, assignmentId) : 0;
  // Pin the current To Do order (unplaced tasks included) so the new steps land at its end.
  const column = await todoColumnIds(env.DB, replace ? assignmentId : undefined);
  const now = new Date().toISOString();

  const stmts: D1PreparedStatement[] = column.map((id, i) => env.DB.prepare(
    `INSERT INTO task_positions (task_id, position, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (task_id) DO UPDATE SET position = excluded.position, updated_at = excluded.updated_at`,
  ).bind(id, i + 1, now));
  if (replace) {
    // Positions, events and links cascade. In Progress and Done work is never touched.
    stmts.push(env.DB.prepare(
      `DELETE FROM tasks WHERE assignment_id = ? AND status = 'To Do' AND source_repo = 'college-tracker'`,
    ).bind(assignmentId));
  }
  steps.forEach((s, i) => {
    // Each follow-up statement reads the new task's id with last_insert_rowid(); task_positions and
    // task_links are keyed by task_id (their rowid), so it is unchanged until the task_events insert.
    stmts.push(
      env.DB.prepare(
        `INSERT INTO tasks (description, okr_id, assignment_id, source_repo, time_spent, status, notes)
         VALUES (?, ?, ?, 'college-tracker', ?, 'To Do', ?)`,
      ).bind(s.description, asn.okr_id, assignmentId, s.time_spent, s.notes),
      env.DB.prepare(`INSERT INTO task_positions (task_id, position, updated_at) VALUES (last_insert_rowid(), ?, ?)`)
        .bind(column.length + i + 1, now),
    );
    if (s.link_url) {
      stmts.push(env.DB.prepare(`INSERT INTO task_links (task_id, url, label) VALUES (last_insert_rowid(), ?, ?)`)
        .bind(s.link_url, s.link_label));
    }
    stmts.push(env.DB.prepare(`INSERT INTO task_events (task_id, from_status, to_status, at) VALUES (last_insert_rowid(), NULL, 'To Do', ?)`)
      .bind(now));
  });
  try {
    await env.DB.batch(stmts);
  } catch (e) {
    if (e instanceof Error && /no such table: task_links/.test(e.message)) {
      return { error: "Adding steps needs migration 0013 — run Apply D1 Migration with migrations/0013_task_links.sql", status: 503 };
    }
    throw e;
  }
  return { created: steps.length, removed };
}
