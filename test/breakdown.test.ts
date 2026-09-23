import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lectureHomeworkDocx } from "./docx";
import { call } from "./helpers";

const ORIGIN = "https://school.instructure.com";
const FILE_STORE = "https://files.instructure-uploads.example";
const SLIDES = "https://www.slideshare.net/mrmularella/scientific-method-95777";
const VIDEO = "https://www.khanacademy.org/science/v/the-scientific-method";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const ASN = "SCI-133-F26-A1";
const KEY = { ANTHROPIC_API_KEY: "k" };

let seen: Request[];
let claudeBody: any;
let claudeSteps: unknown[];

function stub(docx: Uint8Array) {
  seen = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input as RequestInfo, init);
    seen.push(req);
    const url = new URL(req.url);
    const json = (b: unknown) => new Response(JSON.stringify(b), { headers: { "Content-Type": "application/json" } });
    if (url.origin === "https://api.anthropic.com") {
      claudeBody = await req.json();
      return json({
        id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5", stop_reason: "end_turn", stop_sequence: null,
        content: [{ type: "text", text: JSON.stringify({ steps: claudeSteps, warnings: ["The file says due 2/9/26 but Canvas says 2026-10-10"] }) }],
        usage: { input_tokens: 10, output_tokens: 10 },
      });
    }
    if (url.origin === FILE_STORE) return new Response(docx, { headers: { "Content-Type": DOCX } });
    if (url.origin !== ORIGIN) throw new Error(`unexpected host ${url.origin}`);
    const p = url.pathname;
    if (p === "/api/v1/users/self/profile") return json({ id: "1", time_zone: "America/New_York" });
    if (p === "/api/v1/courses") return json([{ id: "101", name: "Sci Every Day", course_code: "SCI 151" }]);
    if (p === "/api/v1/courses/101/assignments") return json([]);
    if (p === "/api/v1/courses/101/modules/71/items/9001") {
      return json({ id: "9001", title: "SCI151Lecture#1&HW#1.docx", type: "File", content_id: "555", html_url: `${ORIGIN}/courses/101/modules/items/9001` });
    }
    if (p === "/api/v1/files/555") {
      return json({ id: "555", display_name: "SCI151Lecture#1&HW#1.docx", "content-type": DOCX, size: docx.length, url: `${ORIGIN}/files/555/download?download_frd=1&verifier=abc` });
    }
    if (p === "/files/555/download") return new Response(null, { status: 302, headers: { Location: `${FILE_STORE}/blob/555?sig=xyz` } });
    return new Response("{}", { status: 404 });
  });
}

beforeEach(async () => {
  claudeSteps = [
    { description: "Review the Scientific Method slides (13 slides)", time_estimate: "20m", link_url: SLIDES, link_label: "Slideshare slides", detail: null },
    { description: "Watch the Scientific Method video (11:48)", time_estimate: "15m", link_url: VIDEO, link_label: "Khan Academy video", detail: null },
    { description: "Answer Q1–22 on the worksheet", time_estimate: "45m", link_url: "https://evil.example/phish", link_label: "Answers", detail: "Pages 3–4" },
  ];
  stub(await lectureHomeworkDocx());
  await call("/api/canvas/sync", { method: "POST" });
  await call("/api/canvas/courses/101/link", { method: "POST", json: { local_course_id: "SCI-133-F26" } });
  await env.DB.prepare(
    `INSERT INTO assignments (id, course_id, okr_id, title, due_date) VALUES (?, 'SCI-133-F26', 'KR-ACAD-1', 'Lecture & Lab Homework', '2026-10-10')`,
  ).bind(ASN).run();
});
afterEach(() => { vi.restoreAllMocks(); });

async function linkFile() {
  await call("/api/canvas/materials", { method: "POST", json: { assignment_id: ASN, canvas_course_id: "101", module_id: "71", item_id: "9001" } });
}

async function addTask(description: string, status: string, source = "college-tracker") {
  return (await env.DB.prepare(
    `INSERT INTO tasks (description, okr_id, assignment_id, source_repo, status) VALUES (?, 'KR-ACAD-1', ?, ?, ?) RETURNING id`,
  ).bind(description, ASN, source, status).first<{ id: number }>())!.id;
}

const count = async (table: string) => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;

describe("POST /api/assignments/:id/breakdown-preview", () => {
  it("reads the linked Canvas file and returns Claude's steps with only real links", async () => {
    await linkFile();
    await addTask("Read assignment instructions thoroughly", "To Do");
    const tasksBefore = await count("tasks");
    seen = [];

    const res = await call(`/api/assignments/${ASN}/breakdown-preview`, { method: "POST", env: KEY });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.steps.map((s: any) => s.link_url)).toEqual([SLIDES, VIDEO, null]);
    expect(body.steps[2]).toMatchObject({ link_label: null, detail: "Pages 3–4" });
    expect(body.warnings).toEqual(["The file says due 2/9/26 but Canvas says 2026-10-10"]);
    expect(body).toMatchObject({ source: { title: "SCI151Lecture#1&HW#1.docx" }, replaceable_todo: 1 });

    // Claude saw the file's text and the links found in it.
    const prompt = claudeBody.messages[0].content[0].text as string;
    expect(prompt).toContain("Review Lecture Slides Scientific Method (13 Slides Total)");
    expect(prompt).toContain(SLIDES);
    expect(claudeBody.model).toBe("claude-opus-5");

    // The token went to Canvas only, never to the file store; every Canvas/file request is a GET.
    const canvas = seen.filter((r) => !r.url.startsWith("https://api.anthropic.com"));
    expect(canvas.every((r) => r.method === "GET")).toBe(true);
    const store = canvas.find((r) => r.url.startsWith(FILE_STORE))!;
    expect(store.headers.get("authorization")).toBeNull();
    expect(canvas.find((r) => r.url.startsWith(`${ORIGIN}/files/555/download`))!.headers.get("authorization")).toBe("Bearer canvas-test-token");

    expect(await count("tasks")).toBe(tasksBefore); // preview adds no tasks…
    await env.DB.prepare(`DELETE FROM canvas_material_links`).run();
    await call(`/api/assignments/${ASN}/breakdown-preview`, { method: "POST", env: KEY });
    expect(await count("canvas_material_links")).toBe(2); // …but refreshes the file's Materials links
  });

  it("explains what's missing", async () => {
    expect((await call(`/api/assignments/nope/breakdown-preview`, { method: "POST", env: KEY })).status).toBe(404);
    const res = await call(`/api/assignments/${ASN}/breakdown-preview`, { method: "POST", env: KEY });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("Link a Canvas module file") });
    const flag = async () => ((await (await call("/api/deadlines?days=60")).json()) as any).deadlines.find((d: any) => d.id === ASN).has_canvas_material;
    expect(await flag()).toBe(false);
    await linkFile();
    expect(await flag()).toBe(true);
    expect((await call(`/api/assignments/${ASN}/breakdown-preview`, { method: "POST", env: { ANTHROPIC_API_KEY: undefined } })).status).toBe(503);
    expect((await call(`/api/assignments/${ASN}/breakdown-preview`, { method: "POST", env: KEY, token: null })).status).toBe(401);
  });

  it("only flags assignments whose linked item is a downloadable file", async () => {
    await env.DB.prepare(
      `INSERT INTO canvas_materials (assignment_id, canvas_host, canvas_course_id, module_id, item_id, title, item_type, html_url, download_url, linked_at)
       VALUES (?, 'school.instructure.com', '101', '71', '9003', 'Week 1 overview', 'Page', ?, NULL, '2026-09-01')`,
    ).bind(ASN, `${ORIGIN}/courses/101/modules/items/9003`).run();
    const { deadlines } = await (await call("/api/deadlines?days=60")).json() as any;
    expect(deadlines.find((d: any) => d.id === ASN).has_canvas_material).toBe(false);
  });

  it("refuses files it can't read", async () => {
    vi.restoreAllMocks();
    stub(new TextEncoder().encode("not a docx"));
    await linkFile();
    const res = await call(`/api/assignments/${ASN}/breakdown-preview`, { method: "POST", env: KEY });
    expect(res.status).toBe(422);
  });
});

describe("POST /api/assignments/:id/tasks/bulk", () => {
  const steps = [
    { description: "Review the slides", time_spent: "20m", link_url: SLIDES, link_label: "Slides" },
    { description: "Answer Q1–22", time_spent: "45m", notes: "Pages 3–4" },
  ];

  it("adds the steps in order with links, and can replace untouched To Do tasks", async () => {
    const oldTodo = await addTask("Read assignment instructions thoroughly", "To Do");
    const started = await addTask("Skim the syllabus", "In Progress");
    const otherRepo = await addTask("Dashboard chore", "To Do", "repo-dashboard");

    const res = await call(`/api/assignments/${ASN}/tasks/bulk`, { method: "POST", json: { steps, replace_todo: true } });
    expect(await res.json()).toEqual({ created: 2, removed: 1 });

    const ids = (await env.DB.prepare(`SELECT id FROM tasks ORDER BY id`).all<{ id: number }>()).results.map((r) => r.id);
    expect(ids).not.toContain(oldTodo);
    expect(ids).toEqual(expect.arrayContaining([started, otherRepo]));

    const board = await (await call("/api/microtasks")).json() as { tasks: any[] };
    const todo = board.tasks.filter((t) => t.status === "To Do" && t.assignment_id === ASN && t.description !== "Dashboard chore");
    expect(todo.map((t) => [t.description, t.time_spent, t.link_url, t.link_label, t.notes])).toEqual([
      ["Review the slides", "20m", SLIDES, "Slides", null],
      ["Answer Q1–22", "45m", null, null, "Pages 3–4"],
    ]);
    expect(await count("task_events")).toBeGreaterThanOrEqual(2);
  });

  it("puts new steps after every To Do task, including ones never dragged", async () => {
    const unplaced = await addTask("Old unplaced task", "To Do", "repo-dashboard");
    await call(`/api/assignments/${ASN}/tasks/bulk`, { method: "POST", json: { steps } });
    const board = await (await call("/api/microtasks")).json() as { tasks: any[] };
    expect(board.tasks.filter((t) => t.status === "To Do").map((t) => t.id)[0]).toBe(unplaced);
    expect(board.tasks.filter((t) => t.status === "To Do").map((t) => t.description))
      .toEqual(["Old unplaced task", "Review the slides", "Answer Q1–22"]);
  });

  it("keeps existing tasks without replace_todo", async () => {
    await addTask("Read assignment instructions thoroughly", "To Do");
    const res = await call(`/api/assignments/${ASN}/tasks/bulk`, { method: "POST", json: { steps } });
    expect(await res.json()).toEqual({ created: 2, removed: 0 });
    expect(await count("tasks")).toBe(3);
  });

  it("validates steps and links", async () => {
    const bad = async (json: unknown) => (await call(`/api/assignments/${ASN}/tasks/bulk`, { method: "POST", json })).status;
    expect(await bad({ steps: [] })).toBe(422);
    expect(await bad({ steps: [{ description: "" }] })).toBe(422);
    expect(await bad({ steps: [{ description: "x", link_url: "javascript:alert(1)" }] })).toBe(422);
    expect(await bad({ steps: Array.from({ length: 21 }, () => ({ description: "x" })) })).toBe(422);
    expect((await call(`/api/assignments/nope/tasks/bulk`, { method: "POST", json: { steps } })).status).toBe(404);
    expect((await call(`/api/assignments/${ASN}/tasks/bulk`, { method: "POST", json: { steps }, token: null })).status).toBe(401);
  });

  it("explains the missing migration and keeps the board working without it", async () => {
    await env.DB.prepare(`DROP TABLE task_links`).run();
    expect((await call("/api/microtasks")).status).toBe(200);
    const res = await call(`/api/assignments/${ASN}/tasks/bulk`, { method: "POST", json: { steps } });
    expect(res.status).toBe(503);
    expect(await count("tasks")).toBe(0); // the batch rolled back
  });
});
