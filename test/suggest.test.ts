import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseDuration } from "../src/microtasks";
import { call } from "./helpers";

describe("parseDuration", () => {
  it.each([
    ["30m", 30], ["1h", 60], ["1.5h", 90], ["1h 30m", 90], ["1h30m", 90], ["90 min", 90],
    ["2 hrs", 120], ["45", 45], ["1 hour", 60], ["2 hours 15 minutes", 135], ["", null], ["soon", null],
  ])("%s → %s", (input, expected) => {
    expect(parseDuration(input)).toBe(expected);
  });
});

async function addTask(description: string, time: string, status = "To Do", assignment = "A1") {
  const row = await env.DB.prepare(
    `INSERT INTO tasks (description, okr_id, assignment_id, source_repo, time_spent, status) VALUES (?, 'KR-ACAD-1', ?, 'college-tracker', ?, ?) RETURNING id`,
  ).bind(description, assignment, time, status).first<{ id: number }>();
  return row!.id;
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO assignments (id, course_id, okr_id, title, due_date) VALUES ('A1','SCI-133-F26','KR-ACAD-1','Lab 1', DATE('now','+2 days'))`),
    env.DB.prepare(`INSERT INTO assignments (id, course_id, okr_id, title, due_date) VALUES ('A2','BMT-210-F26','KR-ACAD-1','Storyboard', DATE('now','+20 days'))`),
  ]);
});
afterEach(() => { vi.restoreAllMocks(); });

describe("time estimates", () => {
  it("adds up task estimates per assignment and for work due this week", async () => {
    await addTask("read", "30m", "Done");
    await addTask("draft", "1h");
    await addTask("edit", "1h 30m", "In Progress");
    await addTask("sketch", "2h", "To Do", "A2");
    const { progress } = await (await call("/api/microtasks")).json() as any;
    expect(progress.assignments.find((a: any) => a.id === "A1")).toMatchObject({ est_total_min: 180, est_remaining_min: 150 });
    expect(progress.movement.remaining_due_this_week_min).toBe(150);

    const { deadlines } = await (await call("/api/deadlines?days=30")).json() as any;
    expect(deadlines.find((d: any) => d.id === "A1").est_remaining_min).toBe(150);
    expect(deadlines.find((d: any) => d.id === "A2").est_remaining_min).toBe(120);
  });
});

describe("POST /api/microtasks/suggest", () => {
  function mockClaude(picks: unknown, capture?: { body?: any }) {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const req = new Request(input as RequestInfo, init);
      expect(req.url).toBe("https://api.anthropic.com/v1/messages?beta=true");
      if (capture) capture.body = await req.json();
      return new Response(JSON.stringify({
        id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5", stop_reason: "end_turn", stop_sequence: null,
        content: [{ type: "text", text: JSON.stringify({ picks }) }],
        usage: { input_tokens: 10, output_tokens: 10 },
      }), { headers: { "Content-Type": "application/json" } });
    });
  }

  it("returns Claude's picks, dropping unknown and duplicate ids", async () => {
    const a = await addTask("draft", "1h");
    const b = await addTask("sketch", "2h", "To Do", "A2");
    const done = await addTask("read", "30m", "Done");
    const capture: { body?: any } = {};
    mockClaude([
      { task_id: b, reason: "Big block of work." },
      { task_id: 999, reason: "not a task" },
      { task_id: done, reason: "already done" },
      { task_id: b, reason: "dup" },
      { task_id: a, reason: "Due in two days." },
    ], capture);
    const res = await call("/api/microtasks/suggest", { method: "POST", env: { ANTHROPIC_API_KEY: "k" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ picks: [{ task_id: b, reason: "Big block of work." }, { task_id: a, reason: "Due in two days." }] });

    // Only open tasks go to Claude, with the fields it needs.
    const content = capture.body.messages[0].content as string;
    expect(capture.body.model).toBe("claude-opus-5");
    expect(capture.body.output_config.format.type).toBe("json_schema");
    expect(content).toContain('"description":"draft"');
    expect(content).not.toContain('"description":"read"');
    expect(content).toContain('"estimated_minutes":60');
  });

  it("returns no picks without calling Claude when nothing is open", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const res = await call("/api/microtasks/suggest", { method: "POST", env: { ANTHROPIC_API_KEY: "k" } });
    expect(await res.json()).toEqual({ picks: [], picked_at: null });
    expect(spy).not.toHaveBeenCalled();
  });

  it("needs an API key and write auth", async () => {
    await addTask("draft", "1h");
    expect((await call("/api/microtasks/suggest", { method: "POST", env: { ANTHROPIC_API_KEY: undefined } })).status).toBe(503);
    expect((await call("/api/microtasks/suggest", { method: "POST", token: null, env: { ANTHROPIC_API_KEY: "k" } })).status).toBe(401);
  });

  it("reports a refusal instead of failing silently", async () => {
    await addTask("draft", "1h");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5", stop_reason: "refusal", stop_sequence: null,
      content: [], usage: { input_tokens: 10, output_tokens: 0 },
    }), { headers: { "Content-Type": "application/json" } }));
    const res = await call("/api/microtasks/suggest", { method: "POST", env: { ANTHROPIC_API_KEY: "k" } });
    expect(res.status).toBe(502);
  });
});

describe("saved picks", () => {
  const ask = (picks: unknown) => {
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5", stop_reason: "end_turn", stop_sequence: null,
      content: [{ type: "text", text: JSON.stringify({ picks }) }], usage: { input_tokens: 1, output_tokens: 1 },
    }), { headers: { "Content-Type": "application/json" } }));
    return call("/api/microtasks/suggest", { method: "POST", env: { ANTHROPIC_API_KEY: "k" } });
  };
  const saved = async () => (await (await call("/api/microtasks/picks")).json()) as any;

  it("keeps the picks until asked again, dropping finished and deleted tasks", async () => {
    const a = await addTask("draft", "1h");
    const b = await addTask("sketch", "2h", "To Do", "A2");
    const c = await addTask("edit", "30m");
    expect(await saved()).toEqual({ picks: [], picked_at: null, done_since: 0 });

    const first = await (await ask([{ task_id: a, reason: "Due soon." }, { task_id: b, reason: "Big." }, { task_id: c, reason: "Quick." }])).json() as any;
    expect(first.picked_at).toEqual(expect.any(String));
    expect(await saved()).toEqual({
      picks: [{ task_id: a, reason: "Due soon." }, { task_id: b, reason: "Big." }, { task_id: c, reason: "Quick." }],
      picked_at: first.picked_at, done_since: 0,
    });

    // Finishing a pick drops it (counted); deleting one removes it; the rest keep their order.
    await env.DB.prepare(`UPDATE tasks SET status = 'Done' WHERE id = ?`).bind(a).run();
    await env.DB.prepare(`DELETE FROM tasks WHERE id = ?`).bind(c).run();
    expect(await saved()).toMatchObject({ picks: [{ task_id: b, reason: "Big." }], done_since: 1 });

    // Asking again replaces the whole set.
    await ask([{ task_id: b, reason: "Only one left." }]);
    expect(await saved()).toMatchObject({ picks: [{ task_id: b, reason: "Only one left." }], done_since: 0 });
  });

  it("still suggests before migration 0014, without saving", async () => {
    const a = await addTask("draft", "1h");
    await env.DB.prepare(`DROP TABLE task_picks`).run();
    const res = await ask([{ task_id: a, reason: "Due soon." }]);
    expect(await res.json()).toEqual({ picks: [{ task_id: a, reason: "Due soon." }], picked_at: null });
    expect(await saved()).toEqual({ picks: [], picked_at: null, done_since: 0 });
  });
});
