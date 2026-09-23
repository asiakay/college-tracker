import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { ACCESS_ENV, mockAccess } from "./access";
import { call } from "./helpers";

async function asnStatus(id: string) {
  const row = await env.DB.prepare("SELECT status FROM assignments WHERE id = ?").bind(id).first<{ status: string }>();
  return row?.status;
}

describe("POST /api/tasks", () => {
  it("promotes a Not Started assignment to In Progress — never Submitted", async () => {
    await env.DB.prepare(
      `INSERT INTO assignments (id, course_id, okr_id, title, due_date) VALUES ('SCI-133-F26-A1','SCI-133-F26','KR-ACAD-1','Lab 1','2026-10-01')`
    ).run();

    const res = await call("/api/tasks", {
      method: "POST",
      json: { okr_id: "KR-ACAD-1", description: "Read lab handout", assignment_id: "SCI-133-F26-A1", status: "Done" },
    });
    expect(res.status).toBe(200);
    expect(await asnStatus("SCI-133-F26-A1")).toBe("In Progress");
  });
});

describe("PUT /api/assignments/:id", () => {
  it("leaves fields that were not sent untouched", async () => {
    await env.DB.prepare(
      `INSERT INTO assignments (id, course_id, okr_id, title, due_date, grade, notes) VALUES ('SCI-133-F26-A2','SCI-133-F26','KR-ACAD-1','Essay','2026-10-01',88,'keep me')`
    ).run();
    const res = await call("/api/assignments/SCI-133-F26-A2", { method: "PUT", json: { status: "In Progress" } });
    expect(res.status).toBe(200);
    expect(await env.DB.prepare("SELECT status, grade, notes FROM assignments WHERE id = 'SCI-133-F26-A2'").first())
      .toEqual({ status: "In Progress", grade: 88, notes: "keep me" });
  });
});

describe("POST /api/assignments/:id/generate-tasks auth", () => {
  it("rejects callers with neither a token nor a Cloudflare Access identity", async () => {
    const res = await call("/api/assignments/NOPE/generate-tasks", { method: "POST", token: null });
    expect(res.status).toBe(401);
  });
  it("lets a verified Cloudflare Access user through without a token", async () => {
    const jwt = await mockAccess();
    const res = await call("/api/assignments/NOPE/generate-tasks", {
      method: "POST", token: null, env: ACCESS_ENV, headers: { "Cf-Access-Jwt-Assertion": await jwt() },
    });
    expect(res.status).toBe(404); // past auth; the assignment doesn't exist
    vi.restoreAllMocks();
  });
});
