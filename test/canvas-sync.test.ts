import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { CanvasError } from "../src/canvas/client";
import { runCanvasSync, type SyncResult } from "../src/canvas/sync";
import type { CanvasAssignmentJson, CanvasCourseJson, CanvasReader } from "../src/canvas/types";

const HOST = "school.instructure.com";
const ORIGIN = `https://${HOST}`;

class FakeReader implements CanvasReader {
  courses: CanvasCourseJson[] = [
    { id: "101", name: "Environmental Science", course_code: "SCI 133", term: { name: "Fall 2026" } },
    { id: "202", name: "Advanced TV Production", course_code: "BMT 210", term: { name: "Fall 2026" } },
  ];
  assignments: Record<string, CanvasAssignmentJson[]> = {
    "101": [
      { id: "9007199254740993", name: "Lab 1: Soil", due_at: "2026-10-02T03:59:00Z", points_possible: 20, submission_types: ["online_upload"], published: true },
      { id: "5002", name: "Midterm Quiz", due_at: "2026-10-15T16:00:00Z", points_possible: 100, submission_types: ["online_quiz"], published: true },
    ],
    "202": [{ id: "6001", name: "Storyboard", due_at: "2026-10-05T03:59:00Z", submission_types: ["online_upload"] }],
  };
  failCourse: string | null = null;
  profileError: CanvasError | null = null;
  profileCalls = 0;

  async getProfile() {
    this.profileCalls++;
    if (this.profileError) throw this.profileError;
    return { id: "1", time_zone: "America/New_York" };
  }
  async listCourses() { return this.courses; }
  async listAssignments(id: string) {
    if (this.failCourse === id) throw new CanvasError("boom", "forbidden", 403);
    return this.assignments[id] ?? [];
  }
}

let reader: FakeReader;
const sync = (): Promise<SyncResult> => runCanvasSync(env.DB, reader, { trigger: "manual", host: HOST, origin: ORIGIN });
function done(r: SyncResult) {
  if (r.locked) throw new Error("unexpectedly locked");
  return r;
}
async function enable(canvasId: string, localCourseId: string) {
  await env.DB.prepare(`UPDATE canvas_courses SET local_course_id = ?, sync_enabled = 1 WHERE canvas_id = ?`)
    .bind(localCourseId, canvasId).run();
}
const asn = (id: string) => env.DB.prepare(`SELECT * FROM assignments WHERE id = ?`).bind(id).first<Record<string, unknown>>();
const snap = (canvasId: string) => env.DB.prepare(`SELECT * FROM canvas_assignments WHERE canvas_id = ?`).bind(canvasId).first<Record<string, unknown>>();

beforeEach(() => { reader = new FakeReader(); });

describe("course sync", () => {
  it("snapshots courses without touching local courses", async () => {
    const r = done(await sync());
    expect(r.status).toBe("succeeded");
    expect(r.summary.courses).toMatchObject({ seen: 2, created: 2 });
    const rows = await env.DB.prepare(`SELECT canvas_id, local_course_id, sync_enabled FROM canvas_courses ORDER BY canvas_id`).all();
    expect(rows.results).toEqual([
      { canvas_id: "101", local_course_id: null, sync_enabled: 0 },
      { canvas_id: "202", local_course_id: null, sync_enabled: 0 },
    ]);
    // Courses are only synced for assignments once the student enables them.
    expect(r.summary.synced_courses).toEqual([]);
  });

  it("soft-marks courses Canvas stops listing and restores them when they return", async () => {
    await sync();
    reader.courses = reader.courses.slice(0, 1);
    expect(done(await sync()).summary.courses.removed).toBe(1);
    expect((await env.DB.prepare(`SELECT removed_at FROM canvas_courses WHERE canvas_id='202'`).first())!.removed_at).not.toBeNull();
    reader = new FakeReader();
    await sync();
    expect((await env.DB.prepare(`SELECT removed_at FROM canvas_courses WHERE canvas_id='202'`).first())!.removed_at).toBeNull();
  });
});

describe("profile / time zone", () => {
  it("keeps syncing when the school blocks the profile endpoint, with a warning", async () => {
    reader.profileError = new CanvasError("Canvas denied access to /api/v1/users/self/profile (403)", "forbidden", 403);
    const r = done(await sync());
    expect(r.status).toBe("succeeded");
    expect(r.summary.timezone).toBe("UTC");
    expect(r.summary.courses.seen).toBe(2);
    expect(r.summary.warnings).toEqual([expect.stringContaining("Set CANVAS_TIMEZONE")]);
  });

  it("uses CANVAS_TIMEZONE without calling the profile", async () => {
    const r = done(await runCanvasSync(env.DB, reader, { trigger: "manual", host: HOST, origin: ORIGIN, timeZoneOverride: "America/Los_Angeles" }));
    expect(r.summary.timezone).toBe("America/Los_Angeles");
    expect(reader.profileCalls).toBe(0);
    expect(r.summary.warnings).toEqual([]);
  });
});

describe("assignment sync", () => {
  beforeEach(async () => {
    await sync();
    await enable("101", "SCI-133-F26");
  });

  it("creates local assignments with deterministic ids and exact string ids", async () => {
    const r = done(await sync());
    expect(r.summary.assignments).toMatchObject({ seen: 2, created: 2, local_created: 2 });
    const lab = await asn("SCI-133-F26-C9007199254740993");
    expect(lab).toMatchObject({
      title: "Lab 1: Soil", due_date: "2026-10-01", // 11:59pm Eastern, not the UTC date
      status: "Not Started", deliverable_type: "Project", okr_id: "KR-ACAD-1", weight_pct: 0,
    });
    expect((await asn("SCI-133-F26-C5002"))!.deliverable_type).toBe("Exam");
    expect(await snap("9007199254740993")).toMatchObject({ local_assignment_id: "SCI-133-F26-C9007199254740993", link_method: "created" });
  });

  it("is idempotent: a second identical sync changes nothing", async () => {
    await sync();
    const before = await env.DB.prepare(`SELECT * FROM assignments ORDER BY id`).all();
    const r = done(await sync());
    expect(r.summary.assignments).toMatchObject({ created: 0, changed: 0, unchanged: 2, local_created: 0, local_updated: 0, removed: 0 });
    expect((await env.DB.prepare(`SELECT * FROM assignments ORDER BY id`).all()).results).toEqual(before.results);
  });

  it("updates Canvas-owned fields but never student-owned state or tasks", async () => {
    await sync();
    const id = "SCI-133-F26-C5002";
    await env.DB.prepare(
      `UPDATE assignments SET status='In Progress', notes='my notes', blocker='need calculator', grade=91,
              weight_pct=15, deliverable_type='Essay', okr_id='KR-ACAD-2' WHERE id=?`,
    ).bind(id).run();
    await env.DB.prepare(`INSERT INTO tasks (description, okr_id, assignment_id, status) VALUES ('Review ch. 3','KR-ACAD-1',?,'Done')`).bind(id).run();

    reader.assignments["101"]![1] = { ...reader.assignments["101"]![1]!, name: "Midterm Exam", due_at: "2026-10-20T16:00:00Z" };
    const r = done(await sync());
    expect(r.summary.assignments).toMatchObject({ changed: 1, local_updated: 1 });
    expect(await asn(id)).toMatchObject({
      title: "Midterm Exam", due_date: "2026-10-20",
      status: "In Progress", notes: "my notes", blocker: "need calculator", grade: 91,
      weight_pct: 15, deliverable_type: "Essay", okr_id: "KR-ACAD-2",
    });
    const tasks = await env.DB.prepare(`SELECT description, status FROM tasks WHERE assignment_id=?`).bind(id).all();
    expect(tasks.results).toEqual([{ description: "Review ch. 3", status: "Done" }]);
  });

  it("links to a single syllabus-imported assignment with the same title", async () => {
    await env.DB.prepare(
      `INSERT INTO assignments (id, course_id, okr_id, title, due_date, status, notes) VALUES ('SCI-133-F26-A1','SCI-133-F26','KR-ACAD-1','lab 1 - soil','2026-09-30','In Progress','from syllabus')`,
    ).run();
    const r = done(await sync());
    expect(r.summary.assignments.linked_by_title).toBe(1);
    expect(await snap("9007199254740993")).toMatchObject({ local_assignment_id: "SCI-133-F26-A1", link_method: "title_match" });
    expect(await asn("SCI-133-F26-A1")).toMatchObject({ title: "Lab 1: Soil", due_date: "2026-10-01", status: "In Progress", notes: "from syllabus" });
    expect(await asn("SCI-133-F26-C9007199254740993")).toBeNull();
  });

  it("does not guess when several local assignments match; reports them instead", async () => {
    for (const id of ["SCI-133-F26-A1", "SCI-133-F26-A2"]) {
      await env.DB.prepare(
        `INSERT INTO assignments (id, course_id, okr_id, title, due_date) VALUES (?, 'SCI-133-F26','KR-ACAD-1','Lab 1: Soil','2026-09-30')`,
      ).bind(id).run();
    }
    const r = done(await sync());
    expect(r.summary.possible_duplicates).toEqual([
      { canvas_id: "9007199254740993", canvas_course_id: "101", name: "Lab 1: Soil", local_candidates: ["SCI-133-F26-A1", "SCI-133-F26-A2"] },
    ]);
    expect((await snap("9007199254740993"))!.local_assignment_id).toBeNull();
    expect(await asn("SCI-133-F26-C9007199254740993")).toBeNull();
  });

  it("reports undated assignments without creating local rows", async () => {
    reader.assignments["101"]!.push({ id: "7777", name: "Participation", due_at: null });
    const r = done(await sync());
    expect(r.summary.undated).toEqual([{ canvas_id: "7777", canvas_course_id: "101", name: "Participation", local_assignment_id: null }]);
    expect(await snap("7777")).toMatchObject({ due_at: null, local_assignment_id: null });
  });

  it("keeps the local row and its tasks when Canvas drops an assignment", async () => {
    await sync();
    const id = "SCI-133-F26-C5002";
    await env.DB.prepare(`INSERT INTO tasks (description, okr_id, assignment_id) VALUES ('study','KR-ACAD-1',?)`).bind(id).run();
    reader.assignments["101"] = reader.assignments["101"]!.slice(0, 1);
    const r = done(await sync());
    expect(r.summary.assignments.removed).toBe(1);
    expect((await snap("5002"))!.removed_at).not.toBeNull();
    expect(await asn(id)).not.toBeNull();
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE assignment_id=?`).bind(id).first<{ n: number }>())!.n).toBe(1);
  });

  it("isolates a failing course: others commit and the run is partial", async () => {
    await enable("202", "BMT-210-F26");
    reader.failCourse = "101";
    const r = done(await sync());
    expect(r.status).toBe("partial");
    expect(r.summary.errors).toEqual([{ canvas_course_id: "101", kind: "forbidden", message: "boom" }]);
    expect(await asn("BMT-210-F26-C6001")).not.toBeNull();
    expect(await asn("SCI-133-F26-C5002")).toBeNull();
    // Next run retries and converges.
    reader.failCourse = null;
    expect(done(await sync()).status).toBe("succeeded");
    expect(await asn("SCI-133-F26-C5002")).not.toBeNull();
  });

  it("fails the run on an auth error and releases the lease", async () => {
    reader.profileError = new CanvasError("Canvas rejected the access token (401)", "auth", 401);
    const r = done(await sync());
    expect(r.status).toBe("failed");
    const run = await env.DB.prepare(`SELECT status, error FROM canvas_sync_runs WHERE id = ?`).bind(r.run_id).first();
    expect(run).toEqual({ status: "failed", error: "Canvas rejected the access token (401)" });
    reader.profileError = null;
    expect(done(await sync()).status).toBe("succeeded");
  });

  it("never re-links an assignment the student unlinked", async () => {
    await sync();
    await env.DB.prepare(`UPDATE canvas_assignments SET local_assignment_id = NULL, link_method = 'ignored' WHERE canvas_id = '5002'`).run();
    reader.assignments["101"]![1] = { ...reader.assignments["101"]![1]!, name: "Renamed" };
    await sync();
    expect(await snap("5002")).toMatchObject({ name: "Renamed", local_assignment_id: null, link_method: "ignored" });
    expect((await asn("SCI-133-F26-C5002"))!.title).toBe("Midterm Quiz");
  });
});

describe("lease", () => {
  it("refuses to start while another run holds the lease", async () => {
    await env.DB.prepare(`UPDATE canvas_sync_lock SET run_id = 99, locked_until = ? WHERE id = 1`)
      .bind(new Date(Date.now() + 60_000).toISOString()).run();
    expect(await sync()).toEqual({ locked: true });
  });

  it("reclaims an expired lease", async () => {
    await env.DB.prepare(`UPDATE canvas_sync_lock SET run_id = 99, locked_until = ? WHERE id = 1`)
      .bind(new Date(Date.now() - 1000).toISOString()).run();
    expect(done(await sync()).status).toBe("succeeded");
    expect(await env.DB.prepare(`SELECT run_id, locked_until FROM canvas_sync_lock`).first()).toEqual({ run_id: null, locked_until: null });
  });
});
