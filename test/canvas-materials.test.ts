import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lectureHomeworkDocx } from "./docx";
import { call } from "./helpers";

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
let docx: Uint8Array;
let fileFails = false;

const ORIGIN = "https://school.instructure.com";

const LECTURE_ITEM = {
  id: "9001", module_id: "71", title: "SCI151Lecture#1&HW#1.docx", type: "File", content_id: "555",
  html_url: `${ORIGIN}/courses/101/modules/items/9001`,
};

/** Fake Canvas: one course, two modules (the second leaves its items out, as Canvas does for big modules). */
function stubCanvas() {
  const seen: Request[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input as RequestInfo, init);
    seen.push(req);
    const url = new URL(req.url);
    if (url.origin !== ORIGIN) throw new Error(`unexpected host ${url.origin}`);
    const p = url.pathname;
    let body: unknown;
    if (p === "/api/v1/users/self/profile") body = { id: "1", time_zone: "America/New_York" };
    else if (p === "/api/v1/courses") body = [{ id: "101", name: "Sci Every Day", course_code: "SCI 151" }];
    else if (p === "/api/v1/courses/101/assignments") body = [];
    else if (p === "/api/v1/courses/101/modules") {
      body = [
        { id: "71", name: "Lecture #1 & Lecture Homework #1", items: [
          { id: "9000", title: "Week 1", type: "SubHeader" },
          LECTURE_ITEM,
        ] },
        { id: "72", name: "Lab #1 & Homework #2" },
      ];
    } else if (p === "/api/v1/courses/101/modules/72/items") {
      body = [{ id: "9002", title: "Lab handout", type: "File", html_url: "https://evil.example/steal" }];
    } else if (p === "/api/v1/courses/101/modules/71/items/9001") body = LECTURE_ITEM;
    else if (p === "/api/v1/courses/101/modules/71/items/9003") body = { id: "9003", title: "Week 1 overview", type: "Page", html_url: `${ORIGIN}/courses/101/modules/items/9003` };
    else if (p === "/api/v1/files/555") {
      if (fileFails) return new Response("{}", { status: 404 });
      body = { id: "555", display_name: "SCI151Lecture#1.docx", "content-type": DOCX, size: docx.length, url: `${ORIGIN}/files/555/download?download_frd=1&verifier=v` };
    } else if (p === "/files/555/download") return new Response(docx, { headers: { "Content-Type": DOCX } });
    else return new Response(JSON.stringify({ errors: [{ message: "not found" }] }), { status: 404 });
    return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
  });
  return seen;
}

let seen: Request[];
beforeEach(async () => {
  docx = await lectureHomeworkDocx();
  fileFails = false;
  seen = stubCanvas();
  await call("/api/canvas/sync", { method: "POST" });
  await call("/api/canvas/courses/101/link", { method: "POST", json: { local_course_id: "SCI-133-F26" } });
  await env.DB.prepare(
    `INSERT INTO assignments (id, course_id, okr_id, title, due_date) VALUES ('SCI-133-F26-A1','SCI-133-F26','KR-ACAD-1','Lecture & Lab Homework','2026-10-10')`,
  ).run();
});
afterEach(() => { vi.restoreAllMocks(); });

const LINK = { assignment_id: "SCI-133-F26-A1", canvas_course_id: "101", module_id: "71", item_id: "9001" };

describe("Canvas module materials", () => {
  it("lists module items read-only, fetching items Canvas left out and dropping sub-headers and foreign links", async () => {
    const res = await call("/api/canvas/courses/101/modules");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      modules: [
        { id: "71", name: "Lecture #1 & Lecture Homework #1", items: [{ id: "9001", title: LECTURE_ITEM.title, type: "File", html_url: LECTURE_ITEM.html_url }] },
        { id: "72", name: "Lab #1 & Homework #2", items: [] },
      ],
    });
    expect(seen.every((r) => r.method === "GET")).toBe(true);
  });

  it("links a module file to an assignment and shows it on the board", async () => {
    const res = await call("/api/canvas/materials", { method: "POST", json: LINK });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      title: LECTURE_ITEM.title, html_url: LECTURE_ITEM.html_url, item_type: "File",
      download_url: `${ORIGIN}/courses/101/files/555/download?download_frd=1`,
    });

    await env.DB.prepare(
      `INSERT INTO tasks (description, okr_id, assignment_id, status, date) VALUES ('Read lecture notes','KR-ACAD-1','SCI-133-F26-A1','To Do',DATE('now'))`,
    ).run();
    const board = await (await call("/api/microtasks")).json() as { tasks: Array<Record<string, unknown>> };
    expect(board.tasks[0]).toMatchObject({
      canvas_material_url: LECTURE_ITEM.html_url, canvas_material_title: LECTURE_ITEM.title,
      canvas_material_download_url: `${ORIGIN}/courses/101/files/555/download?download_frd=1`,
    });

    // Relinking replaces; unlinking removes. Neither touches the assignment itself.
    expect((await call("/api/canvas/materials", { method: "POST", json: LINK })).status).toBe(200);
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM canvas_materials`).first()).toEqual({ n: 1 });
    await call("/api/canvas/materials/unlink", { method: "POST", json: { assignment_id: "SCI-133-F26-A1" } });
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM canvas_materials`).first()).toEqual({ n: 0 });
    expect(await env.DB.prepare(`SELECT title FROM assignments WHERE id = 'SCI-133-F26-A1'`).first())
      .toEqual({ title: "Lecture & Lab Homework" });
  });

  it("stores what Canvas says about the item, not what the browser sends", async () => {
    const res = await call("/api/canvas/materials", { method: "POST", json: { ...LINK, title: "x", html_url: "https://evil.example" } });
    expect(await res.json()).toMatchObject({ html_url: LECTURE_ITEM.html_url });
  });

  it("rejects items from a course the assignment isn't linked to, bad ids and missing items", async () => {
    await env.DB.prepare(`UPDATE canvas_courses SET local_course_id = NULL`).run();
    expect((await call("/api/canvas/materials", { method: "POST", json: LINK })).status).toBe(422);
    await env.DB.prepare(`UPDATE canvas_courses SET local_course_id = 'SCI-133-F26'`).run();

    expect((await call("/api/canvas/materials", { method: "POST", json: { ...LINK, item_id: "../x" } })).status).toBe(422);
    expect((await call("/api/canvas/materials", { method: "POST", json: { ...LINK, item_id: "404" } })).status).toBe(404);
    expect((await call("/api/canvas/courses/999/modules")).status).toBe(404);
    expect((await call("/api/canvas/courses/abc/modules")).status).toBe(400);
  });

  it("drops the link when its assignment's course is deleted", async () => {
    await call("/api/canvas/materials", { method: "POST", json: LINK });
    expect((await call("/api/courses/SCI-133-F26", { method: "DELETE" })).status).toBe(200);
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM canvas_materials`).first()).toEqual({ n: 0 });
  });

  it("keeps the board working, and explains linking, before migrations 0011/0012 are applied", async () => {
    await env.DB.prepare(`DROP TABLE canvas_materials`).run();
    expect((await call("/api/microtasks")).status).toBe(200);
    const res = await call("/api/canvas/materials", { method: "POST", json: LINK });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("0011 and 0012") });
  });

  it("has no download link for non-file items", async () => {
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify(
      { id: "9003", title: "Week 1 overview", type: "Page", html_url: `${ORIGIN}/courses/101/modules/items/9003` },
    ), { headers: { "Content-Type": "application/json" } }));
    const res = await call("/api/canvas/materials", { method: "POST", json: { ...LINK, item_id: "9003" } });
    expect(await res.json()).toMatchObject({ item_type: "Page", download_url: null });
  });

  it("requires auth", async () => {
    expect((await call("/api/canvas/courses/101/modules", { token: null })).status).toBe(401);
    expect((await call("/api/canvas/materials", { method: "POST", json: LINK, token: null })).status).toBe(401);
  });

  it("saves the links inside a linked file as Materials, replacing them on relink", async () => {
    const res = await call("/api/canvas/materials", { method: "POST", json: LINK });
    const body = await res.json() as any;
    expect(body.links.map((l: any) => l.label)).toEqual(["Slides", "Review Scientific Method Video (11:48 Total)"]);

    await env.DB.prepare(
      `INSERT INTO tasks (description, okr_id, assignment_id, status, date) VALUES ('Read notes','KR-ACAD-1','SCI-133-F26-A1','To Do',DATE('now'))`,
    ).run();
    const board = async () => ((await (await call("/api/microtasks")).json()) as any).tasks[0];
    expect(await board()).toMatchObject({
      canvas_material_links_read: true,
      canvas_material_links: [
        { url: "https://www.slideshare.net/mrmularella/scientific-method-95777", label: "Slides" },
        { url: "https://www.khanacademy.org/science/v/the-scientific-method", label: "Review Scientific Method Video (11:48 Total)" },
      ],
    });

    // Relinking to a page (no file) clears them; unlinking removes them.
    await call("/api/canvas/materials", { method: "POST", json: { ...LINK, item_id: "9003" } });
    expect((await board()).canvas_material_links).toEqual([]);
    await call("/api/canvas/materials", { method: "POST", json: LINK });
    await call("/api/canvas/materials/unlink", { method: "POST", json: { assignment_id: "SCI-133-F26-A1" } });
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM canvas_material_links`).first()).toEqual({ n: 0 });
  });

  it("still links the item when its file can't be read, and can re-read later", async () => {
    fileFails = true;
    const res = await call("/api/canvas/materials", { method: "POST", json: LINK });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ links: [], links_error: expect.any(String) });
    expect(await env.DB.prepare(`SELECT links_read_at FROM canvas_materials`).first()).toEqual({ links_read_at: null });

    fileFails = false;
    const again = await call("/api/assignments/SCI-133-F26-A1/material-links", { method: "POST" });
    expect(((await again.json()) as any).links).toHaveLength(2);
    expect((await call("/api/assignments/SCI-133-F26-A1/material-links", { method: "POST", token: null })).status).toBe(401);
    expect((await call("/api/assignments/nope/material-links", { method: "POST" })).status).toBe(422);
  });

  it("drops the links when the course is deleted, and the board works before migration 0015", async () => {
    await call("/api/canvas/materials", { method: "POST", json: LINK });
    await call("/api/courses/SCI-133-F26", { method: "DELETE" });
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM canvas_material_links`).first()).toEqual({ n: 0 });
    await env.DB.prepare(`DROP TABLE canvas_material_links`).run();
    expect((await call("/api/microtasks")).status).toBe(200);
  });

  it("drops the old file's links when relinking to a file that can't be read", async () => {
    await call("/api/canvas/materials", { method: "POST", json: LINK });
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM canvas_material_links`).first()).toEqual({ n: 2 });
    fileFails = true;
    await call("/api/canvas/materials", { method: "POST", json: LINK });
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM canvas_material_links`).first()).toEqual({ n: 0 });
    expect(await env.DB.prepare(`SELECT links_read_at FROM canvas_materials`).first()).toEqual({ links_read_at: null });
  });

  it("recognises sharded Canvas ids in download links", async () => {
    const { fileIdFromDownloadUrl } = await import("../src/materials");
    expect(fileIdFromDownloadUrl(ORIGIN, `${ORIGIN}/courses/1~101/files/2~555/download?download_frd=1`)).toBe("2~555");
    expect(fileIdFromDownloadUrl(ORIGIN, `${ORIGIN}/courses/101/files/555/download?download_frd=1`)).toBe("555");
    expect(fileIdFromDownloadUrl(ORIGIN, `https://evil.example/courses/101/files/555/download`)).toBeNull();
  });
});
