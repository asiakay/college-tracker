import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { call } from "./helpers";

const ORIGIN = "https://school.instructure.com";

/** Minimal fake Canvas API served through a stubbed global fetch. */
function stubCanvas(data: { courses: unknown[]; assignments: Record<string, unknown[]> }) {
  const seen: Request[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input as RequestInfo, init);
    seen.push(req);
    const url = new URL(req.url);
    if (url.origin !== ORIGIN) throw new Error(`unexpected host ${url.origin}`);
    let body: unknown;
    if (url.pathname === "/api/v1/users/self/profile") body = { id: "1", time_zone: "America/New_York" };
    else if (url.pathname === "/api/v1/courses") body = data.courses;
    else {
      const m = url.pathname.match(/^\/api\/v1\/courses\/([^/]+)\/assignments$/);
      if (!m) return new Response("{}", { status: 404 });
      body = data.assignments[m[1]!] ?? [];
    }
    return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json", "X-Rate-Limit-Remaining": "700" } });
  });
  return seen;
}

const DATA = {
  courses: [{ id: "101", name: "Environmental Science", course_code: "SCI 133", term: { name: "Fall 2026" } }],
  assignments: { "101": [{ id: "5002", name: "Midterm Quiz", due_at: "2026-10-15T16:00:00Z", submission_types: ["online_quiz"] }] },
};

let seen: Request[];
beforeEach(() => { seen = stubCanvas(DATA); });
afterEach(() => { vi.restoreAllMocks(); });

describe("/api/canvas auth", () => {
  it("rejects missing or wrong tokens on every route", async () => {
    for (const [path, method] of [["/api/canvas/status", "GET"], ["/api/canvas/sync", "POST"], ["/api/canvas/courses", "GET"]] as const) {
      expect((await call(path, { method, token: null })).status).toBe(401);
      expect((await call(path, { method, token: "wrong" })).status).toBe(401);
    }
    expect(seen).toHaveLength(0);
  });
});

describe("/api/canvas/status", () => {
  it("reports configuration without exposing the Canvas token", async () => {
    const res = await call("/api/canvas/status");
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).not.toContain("canvas-test-token");
    expect(JSON.parse(text)).toMatchObject({ configured: true, host: "school.instructure.com", last_run: null, running: false });
  });
});

describe("sync + link workflow", () => {
  it("syncs courses, links one, then syncs its assignments", async () => {
    let res = await call("/api/canvas/sync", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "succeeded", summary: { courses: { created: 1 }, canvas_requests: 2 } });
    for (const r of seen) {
      expect(r.method).toBe("GET");
      expect(r.headers.get("accept")).toBe("application/json+canvas-string-ids");
    }

    const { courses } = await (await call("/api/canvas/courses")).json() as { courses: Array<Record<string, unknown>> };
    expect(courses).toMatchObject([{ canvas_id: "101", local_course_id: null, sync_enabled: 0 }]);

    res = await call("/api/canvas/courses/101/link", { method: "POST", json: { local_course_id: "SCI-133-F26" } });
    expect(await res.json()).toEqual({ canvas_id: "101", local_course_id: "SCI-133-F26", sync_enabled: 1 });

    res = await call("/api/canvas/sync", { method: "POST" });
    expect(await res.json()).toMatchObject({ status: "succeeded", summary: { assignments: { local_created: 1 } } });

    const { assignments } = await (await call("/api/assignments?course_id=SCI-133-F26")).json() as { assignments: Array<Record<string, unknown>> };
    expect(assignments.map((a) => a["id"])).toContain("SCI-133-F26-C5002");

    const status = await (await call("/api/canvas/status")).json() as Record<string, any>;
    expect(status["last_run"]).toMatchObject({ trigger: "manual", status: "succeeded" });
  });

  it("creates a local course from a Canvas course", async () => {
    await call("/api/canvas/sync", { method: "POST" });
    const res = await call("/api/canvas/courses/101/link", { method: "POST", json: { create: true, okr_id: "KR-ACAD-1" } });
    expect(await res.json()).toEqual({ canvas_id: "101", local_course_id: "SCI-133-C101", sync_enabled: 1 });
    expect(await env.DB.prepare(`SELECT name, term, okr_id FROM courses WHERE id = 'SCI-133-C101'`).first())
      .toEqual({ name: "Environmental Science", term: "Fall 2026", okr_id: "KR-ACAD-1" });
  });

  it("refuses to link two Canvas courses to one local course", async () => {
    vi.restoreAllMocks();
    stubCanvas({ ...DATA, courses: [...DATA.courses, { id: "202", name: "TV", course_code: "BMT 210" }] });
    await call("/api/canvas/sync", { method: "POST" });
    await call("/api/canvas/courses/101/link", { method: "POST", json: { local_course_id: "SCI-133-F26" } });
    const res = await call("/api/canvas/courses/202/link", { method: "POST", json: { local_course_id: "SCI-133-F26" } });
    expect(res.status).toBe(409);
  });

  it("manually links, and unlinking is respected by later syncs", async () => {
    await call("/api/canvas/sync", { method: "POST" });
    await call("/api/canvas/courses/101/link", { method: "POST", json: { local_course_id: "SCI-133-F26" } });
    await env.DB.prepare(
      `INSERT INTO assignments (id, course_id, okr_id, title, due_date) VALUES ('SCI-133-F26-A9','SCI-133-F26','KR-ACAD-1','Exam 1','2026-10-14')`,
    ).run();
    await call("/api/canvas/sync", { method: "POST" });

    // Re-point the Canvas assignment at the syllabus row.
    await call("/api/canvas/assignments/5002/unlink", { method: "POST" });
    let res = await call("/api/canvas/assignments/5002/link", { method: "POST", json: { assignment_id: "SCI-133-F26-A9" } });
    expect(await res.json()).toMatchObject({ local_assignment_id: "SCI-133-F26-A9", link_method: "manual" });
    expect(await env.DB.prepare(`SELECT title, due_date FROM assignments WHERE id='SCI-133-F26-A9'`).first())
      .toEqual({ title: "Midterm Quiz", due_date: "2026-10-15" });

    await call("/api/canvas/assignments/5002/unlink", { method: "POST" });
    res = await call("/api/canvas/sync", { method: "POST" });
    expect(await res.json()).toMatchObject({ summary: { assignments: { local_created: 0, linked_by_title: 0 } } });
    expect(await env.DB.prepare(`SELECT local_assignment_id, link_method FROM canvas_assignments WHERE canvas_id='5002'`).first())
      .toEqual({ local_assignment_id: null, link_method: "ignored" });
  });

  it("validates Canvas ids in paths", async () => {
    expect((await call("/api/canvas/courses/abc/link", { method: "POST", json: {} })).status).toBe(400);
  });
});

describe("PUT /api/assignments/:id", () => {
  it("rejects due_date edits on Canvas-linked assignments but allows student fields", async () => {
    await call("/api/canvas/sync", { method: "POST" });
    await call("/api/canvas/courses/101/link", { method: "POST", json: { local_course_id: "SCI-133-F26" } });
    await call("/api/canvas/sync", { method: "POST" });

    let res = await call("/api/assignments/SCI-133-F26-C5002", { method: "PUT", json: { due_date: "2026-12-01" } });
    expect(res.status).toBe(409);
    res = await call("/api/assignments/SCI-133-F26-C5002", { method: "PUT", json: { blocker: "waiting on TA", notes: "ch 1-4" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ assignment: { blocker: "waiting on TA", notes: "ch 1-4", due_date: "2026-10-15" } });
  });
});
