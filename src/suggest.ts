/**
 * "What should I do next?" — asks Claude to pick up to three open micro-tasks.
 * The board is never reordered; the picks are only highlighted in the UI.
 */

import Anthropic from "@anthropic-ai/sdk";
import { isValidTimeZone, localDate } from "./canvas/normalize";
import type { Env } from "./env";
import { parseDuration } from "./microtasks";

const MAX_TASKS = 60;
const MAX_PICKS = 3;

const SYSTEM = `You help a college student decide which micro-task to work on next.
You get their open micro-tasks as JSON. Each has: its id, description, status, the student's own
priority position (1 = top; null = not placed yet), estimated minutes, and its assignment's course,
due date, days left, grade weight, points, and whether Canvas marks the assignment missing or late.

Pick up to 3 tasks, best first. Weigh how soon work is due against how long it takes, favour
finishing something already In Progress, respect the student's own order unless a deadline argues
otherwise, and treat missing or late work as urgent. Each reason is one short sentence (at most
20 words) addressed to the student, e.g. "Due tomorrow and only 30 minutes — clears the lab report."
Only use task ids from the list.`;

const PICKS_SCHEMA = {
  type: "object",
  properties: {
    picks: {
      type: "array",
      items: {
        type: "object",
        properties: { task_id: { type: "integer" }, reason: { type: "string" } },
        required: ["task_id", "reason"],
        additionalProperties: false,
      },
    },
  },
  required: ["picks"],
  additionalProperties: false,
} as const;

export interface Pick { task_id: number; reason: string }

interface OpenTask {
  id: number; description: string; status: string; time_spent: string | null; position: number | null;
  assignment_title: string | null; course_name: string | null; due_date: string | null;
  weight_pct: number | null; canvas_points: number | null; canvas_missing: number | null; canvas_late: number | null;
}

function missingPicksTable(e: unknown): boolean {
  return e instanceof Error && e.message.includes("no such table: task_picks");
}

/** Saves the picks as the current set (best effort before migration 0014). */
async function savePicks(db: D1Database, picks: Pick[], at: string): Promise<boolean> {
  try {
    await db.batch([
      db.prepare(`DELETE FROM task_picks`),
      ...picks.map((p, i) => db.prepare(`INSERT INTO task_picks (rank, task_id, reason, picked_at) VALUES (?, ?, ?, ?)`)
        .bind(i + 1, p.task_id, p.reason, at)),
    ]);
    return true;
  } catch (e) {
    if (missingPicksTable(e)) return false;
    throw e;
  }
}

/**
 * The saved picks that are still open, best first. Finished picks drop out
 * (counted in done_since); deleted tasks are removed by the foreign key.
 */
export async function savedPicks(env: Env): Promise<{ picks: Pick[]; picked_at: string | null; done_since: number }> {
  let rows: Array<{ task_id: number; reason: string; picked_at: string; status: string }>;
  try {
    ({ results: rows } = await env.DB.prepare(
      `SELECT p.task_id, p.reason, p.picked_at, t.status FROM task_picks p JOIN tasks t ON t.id = p.task_id ORDER BY p.rank`,
    ).all());
  } catch (e) {
    if (missingPicksTable(e)) return { picks: [], picked_at: null, done_since: 0 };
    throw e;
  }
  return {
    picks: rows.filter((r) => r.status !== "Done").map((r) => ({ task_id: r.task_id, reason: r.reason })),
    picked_at: rows[0]?.picked_at ?? null,
    done_since: rows.filter((r) => r.status === "Done").length,
  };
}

export async function suggestNext(env: Env): Promise<{ picks: Pick[]; picked_at: string | null } | { error: string; status: number }> {
  if (!env.ANTHROPIC_API_KEY) return { error: "ANTHROPIC_API_KEY not configured", status: 503 };

  const { results } = await env.DB.prepare(
    `SELECT t.id, t.description, t.status, t.time_spent, p.position,
            a.title AS assignment_title, c.name AS course_name, a.due_date, a.weight_pct,
            ca.points_possible AS canvas_points, ca.missing AS canvas_missing, ca.late AS canvas_late
     FROM tasks t
     LEFT JOIN assignments a ON a.id = t.assignment_id
     LEFT JOIN courses c ON c.id = a.course_id
     LEFT JOIN canvas_assignments ca ON ca.local_assignment_id = a.id
     LEFT JOIN task_positions p ON p.task_id = t.id
     WHERE (t.assignment_id IS NOT NULL OR t.source_repo = 'college-tracker') AND t.status != 'Done'
     ORDER BY p.position IS NULL, p.position, a.due_date IS NULL, a.due_date, t.created_at, t.id
     LIMIT ?`,
  ).bind(MAX_TASKS).all<OpenTask>();
  if (!results.length) return { picks: [], picked_at: null };

  const tz = isValidTimeZone(env.CANVAS_TIMEZONE) ? env.CANVAS_TIMEZONE : "UTC";
  const today = localDate(new Date().toISOString(), tz)!;
  const daysLeft = (due: string | null) =>
    due ? Math.round((Date.parse(`${due}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000) : null;
  const tasks = results.map((t) => ({
    id: t.id,
    description: t.description,
    status: t.status,
    position: t.position,
    estimated_minutes: t.time_spent ? parseDuration(t.time_spent) : null,
    assignment: t.assignment_title,
    course: t.course_name,
    due_date: t.due_date,
    days_left: daysLeft(t.due_date),
    weight_pct: t.weight_pct || null,
    points: t.canvas_points,
    missing: t.canvas_missing === 1,
    late: t.canvas_late === 1,
  }));

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, fetch: (input, init) => fetch(input, init) });
  let response: Anthropic.Beta.BetaMessage;
  try {
    response = await client.beta.messages.create({
      model: "claude-opus-5",
      max_tokens: 4000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low", format: { type: "json_schema", schema: PICKS_SCHEMA } },
      system: SYSTEM,
      messages: [{ role: "user", content: `Today is ${today}.\n\nOpen micro-tasks:\n${JSON.stringify(tasks)}` }],
    });
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) return { error: "Claude is busy — try again in a minute", status: 503 };
    if (e instanceof Anthropic.APIError) return { error: `Claude request failed (${e.status ?? "network"})`, status: 502 };
    throw e;
  }

  if (response.stop_reason === "refusal") return { error: "Claude declined to make a suggestion", status: 502 };
  const text = response.content.find((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")?.text;
  let parsed: unknown;
  try { parsed = JSON.parse(text ?? ""); }
  catch { return { error: "Claude returned an unreadable suggestion", status: 502 }; }

  const open = new Set(tasks.map((t) => t.id));
  const picks: Pick[] = [];
  for (const p of (parsed as { picks?: unknown[] })?.picks ?? []) {
    const id = (p as Pick)?.task_id;
    const reason = (p as Pick)?.reason;
    if (!Number.isInteger(id) || !open.has(id) || picks.some((x) => x.task_id === id) || typeof reason !== "string") continue;
    picks.push({ task_id: id, reason: reason.trim().slice(0, 200) });
    if (picks.length === MAX_PICKS) break;
  }
  const at = new Date().toISOString();
  const saved = await savePicks(env.DB, picks, at);
  return { picks, picked_at: saved ? at : null };
}
