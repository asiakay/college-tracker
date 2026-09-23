import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { call } from "./helpers";

type Task = { id: number; description: string; status: string; position: number | null; assignment_id: string | null };
type Board = {
  tasks: Task[];
  progress: {
    assignments: Array<{ id: string; total: number; done: number; in_progress: number }>;
    movement: { moved_today: number; done_this_week: number; done_by_day: Array<{ date: string; done: number }> };
  };
};

async function addTask(description: string, opts: { status?: string; assignment_id?: string | null; source_repo?: string; date?: string } = {}) {
  const row = await env.DB.prepare(
    `INSERT INTO tasks (description, okr_id, assignment_id, source_repo, status, date) VALUES (?, 'KR-ACAD-1', ?, ?, ?, COALESCE(?, DATE('now'))) RETURNING id`,
  ).bind(description, opts.assignment_id === undefined ? "A1" : opts.assignment_id, opts.source_repo ?? "college-tracker",
    opts.status ?? "To Do", opts.date ?? null).first<{ id: number }>();
  return row!.id;
}
const board = async (qs = "") => (await (await call(`/api/microtasks${qs}`, { token: null })).json()) as Board;
const column = (status: string, ordered_ids: number[], token?: string | null) =>
  call("/api/microtasks/column", { method: "PUT", json: { status, ordered_ids }, ...(token !== undefined ? { token } : {}) });

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO assignments (id, course_id, okr_id, title, due_date) VALUES ('A1','SCI-133-F26','KR-ACAD-1','Lab 1','2026-10-01')`),
    env.DB.prepare(`INSERT INTO assignments (id, course_id, okr_id, title, due_date) VALUES ('A2','BMT-210-F26','KR-ACAD-1','Storyboard','2026-09-28')`),
  ]);
});

describe("GET /api/microtasks", () => {
  it("returns only academic micro-tasks, unplaced ones by assignment due date", async () => {
    const lab = await addTask("Read lab handout", { assignment_id: "A1" });
    const story = await addTask("Sketch frames", { assignment_id: "A2" });
    await addTask("Fix CI", { assignment_id: null, source_repo: "repo-dashboard" });
    const { tasks } = await board();
    expect(tasks.map((t) => t.id)).toEqual([story, lab]);
  });

  it("puts placed tasks first, in the student's order", async () => {
    const a = await addTask("a"); const b = await addTask("b"); const c = await addTask("c");
    await column("To Do", [c, a]);
    expect((await board()).tasks.map((t) => t.id)).toEqual([c, a, b]);
  });

  it("filters by course and hides Done tasks older than 14 days", async () => {
    await addTask("old done", { status: "Done", date: "2026-01-01" });
    const recent = await addTask("recent done", { status: "Done" });
    const other = await addTask("other course", { assignment_id: "A2" });
    const { tasks } = await board("?course_id=SCI-133-F26");
    expect(tasks.map((t) => t.id)).toEqual([recent]);
    expect((await board()).tasks.map((t) => t.id)).toContain(other);
  });

  it("includes Canvas links for the assignment and its course", async () => {
    const id = await addTask("t");
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO canvas_courses (canvas_host, canvas_id, local_course_id, sync_enabled, name, html_url, content_hash, first_seen_at, last_seen_at, last_changed_at)
        VALUES ('s.instructure.com','101','SCI-133-F26',1,'Env','https://s.instructure.com/courses/101','h','x','x','x')`),
    ]);
    let task = (await board()).tasks.find((t) => t.id === id) as unknown as Record<string, unknown>;
    expect(task).toMatchObject({ canvas_url: null, canvas_course_url: "https://s.instructure.com/courses/101", canvas_course_id: "101" });
    await env.DB.prepare(`INSERT INTO canvas_assignments (canvas_host, canvas_id, canvas_course_id, local_assignment_id, link_method, name, html_url, content_hash, first_seen_at, last_seen_at, last_changed_at)
      VALUES ('s.instructure.com','9','101','A1','manual','Lab 1','https://s.instructure.com/courses/101/assignments/9','h','x','x','x')`).run();
    task = (await board()).tasks.find((t) => t.id === id) as unknown as Record<string, unknown>;
    expect(task["canvas_url"]).toBe("https://s.instructure.com/courses/101/assignments/9");
  });

  it("reports progress per assignment", async () => {
    const [x, y] = [await addTask("x"), await addTask("y")];
    await addTask("z");
    await column("Done", [x]);
    await column("In Progress", [y]);
    const a1 = (await board()).progress.assignments.find((a) => a.id === "A1");
    expect(a1).toMatchObject({ total: 3, done: 1, in_progress: 1 });
  });
});

describe("PUT /api/microtasks/column", () => {
  it("moves a task, records the movement, and starts (never submits) the assignment", async () => {
    const id = await addTask("Draft intro");
    const res = await column("Done", [id]);
    expect(await res.json()).toEqual({ moved: [id], count: 1 });
    expect(await env.DB.prepare(`SELECT status FROM tasks WHERE id = ?`).bind(id).first()).toEqual({ status: "Done" });
    expect(await env.DB.prepare(`SELECT status FROM assignments WHERE id = 'A1'`).first()).toEqual({ status: "In Progress" });
    const ev = await env.DB.prepare(`SELECT from_status, to_status FROM task_events WHERE task_id = ?`).bind(id).all();
    expect(ev.results).toEqual([{ from_status: "To Do", to_status: "Done" }]);

    const m = (await board()).progress.movement;
    expect(m).toMatchObject({ moved_today: 1, done_this_week: 1 });
    expect(m.done_by_day).toHaveLength(14);
    expect(m.done_by_day.at(-1)!.done).toBe(1);
  });

  it("reorders without recording movement when the status is unchanged", async () => {
    const a = await addTask("a"); const b = await addTask("b");
    expect(await (await column("To Do", [b, a])).json()).toEqual({ moved: [], count: 2 });
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM task_events`).first<{ n: number }>())!.n).toBe(0);
    const pos = await env.DB.prepare(`SELECT task_id, position FROM task_positions ORDER BY position`).all();
    expect(pos.results).toEqual([{ task_id: b, position: 1 }, { task_id: a, position: 2 }]);
  });

  it("rejects bad input and other repos' tasks", async () => {
    const mine = await addTask("mine");
    const foreign = await addTask("foreign", { assignment_id: null, source_repo: "repo-dashboard" });
    expect((await column("Blocked", [mine])).status).toBe(422);
    expect((await column("Done", [mine, mine])).status).toBe(422);
    expect((await column("Done", [foreign])).status).toBe(422);
    expect((await column("Done", [999999])).status).toBe(422);
  });

  it("follows the app's write auth", async () => {
    const id = await addTask("t");
    expect((await column("Done", [id], null)).status).toBe(401); // token configured in tests
    const open = await call("/api/microtasks/column", {
      method: "PUT", token: null, env: { MCP_SECRET_TOKEN: undefined }, json: { status: "Done", ordered_ids: [id] },
    });
    expect(open.status).toBe(200);
  });
});

describe("creation events", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("logging a session records a creation event", async () => {
    const res = await call("/api/tasks", { method: "POST", json: { okr_id: "KR-ACAD-1", description: "Read ch. 2", assignment_id: "A1", status: "Done" } });
    const { task } = await res.json() as { task: { id: number } };
    const ev = await env.DB.prepare(`SELECT from_status, to_status FROM task_events WHERE task_id = ?`).bind(task.id).all();
    expect(ev.results).toEqual([{ from_status: null, to_status: "Done" }]);
  });

  it("Break down records a creation event per generated task", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      content: [{ type: "text", text: JSON.stringify([{ description: "Outline", time_spent: "30m" }, { description: "Draft", time_spent: "1h" }]) }],
    })));
    const res = await call("/api/assignments/A1/generate-tasks", { method: "POST", env: { ANTHROPIC_API_KEY: "k" } });
    expect(res.status).toBe(200);
    const n = await env.DB.prepare(`SELECT COUNT(*) AS n FROM task_events WHERE from_status IS NULL AND to_status = 'To Do'`).first<{ n: number }>();
    expect(n!.n).toBe(2);
  });
});
