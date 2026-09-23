import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
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
