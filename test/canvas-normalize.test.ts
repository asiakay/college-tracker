import { describe, expect, it } from "vitest";
import {
  canvasId, contentHash, deliverableTypeFor, localDate, normalizeAssignment,
  normalizeCourse, normalizeTitle, NormalizeError,
} from "../src/canvas/normalize";

describe("canvasId", () => {
  it("accepts string ids, including sharded global ids", () => {
    expect(canvasId("12345678901234567", "x")).toBe("12345678901234567");
    expect(canvasId("1234~5678", "x")).toBe("1234~5678");
  });
  it("accepts safe integers and rejects lossy numbers or junk", () => {
    expect(canvasId(42, "x")).toBe("42");
    expect(() => canvasId(2 ** 60, "x")).toThrow(NormalizeError);
    expect(() => canvasId("abc", "x")).toThrow(NormalizeError);
    expect(() => canvasId(undefined, "x")).toThrow(NormalizeError);
  });
});

describe("localDate", () => {
  it("uses the student's timezone, not UTC", () => {
    // 11:59pm Eastern on Oct 1 is 03:59 UTC on Oct 2.
    expect(localDate("2026-10-02T03:59:00Z", "America/New_York")).toBe("2026-10-01");
    expect(localDate("2026-10-02T03:59:00Z", "UTC")).toBe("2026-10-02");
  });
  it("returns null for unparseable input", () => {
    expect(localDate("not a date", "UTC")).toBeNull();
  });
});

describe("contentHash", () => {
  it("is stable and ignores key order", async () => {
    const a = await contentHash({ x: 1, y: "b", z: null });
    const b = await contentHash({ z: null, y: "b", x: 1 });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await contentHash({ x: 2, y: "b", z: null })).not.toBe(a);
  });
});

describe("normalizeAssignment", () => {
  const raw = {
    id: "9007199254740993", name: "Lab 1: Soil", due_at: "2026-10-02T03:59:00Z",
    points_possible: 20, submission_types: ["online_upload"], published: true,
    html_url: "https://s.instructure.com/courses/1/assignments/9007199254740993", updated_at: "2026-09-01T00:00:00Z",
  };
  it("keeps large ids exact and derives the local due date", async () => {
    const n = await normalizeAssignment(raw, "1", "America/New_York");
    expect(n.canvas_id).toBe("9007199254740993");
    expect(n.due_date_local).toBe("2026-10-01");
    expect(n.submission_types).toBe('["online_upload"]');
    expect(n.published).toBe(1);
  });
  it("hash changes when a Canvas-owned field changes", async () => {
    const a = await normalizeAssignment(raw, "1", "UTC");
    const b = await normalizeAssignment({ ...raw, due_at: "2026-10-09T03:59:00Z" }, "1", "UTC");
    expect(a.content_hash).not.toBe(b.content_hash);
  });
  it("handles undated assignments", async () => {
    const n = await normalizeAssignment({ ...raw, due_at: null }, "1", "UTC");
    expect(n.due_at).toBeNull();
    expect(n.due_date_local).toBeNull();
  });
  it("rejects assignments without a name", async () => {
    await expect(normalizeAssignment({ ...raw, name: "" }, "1", "UTC")).rejects.toThrow(NormalizeError);
  });
});

describe("normalizeCourse", () => {
  it("builds the course URL from the configured origin", async () => {
    const n = await normalizeCourse({ id: "77", name: "Env Sci", term: { name: "Fall 2026" } }, "https://s.instructure.com");
    expect(n.html_url).toBe("https://s.instructure.com/courses/77");
    expect(n.term_name).toBe("Fall 2026");
  });
});

describe("normalizeTitle", () => {
  it("ignores case, punctuation, accents and spacing", () => {
    expect(normalizeTitle("  Lab #1 — Soil  Analysis! ")).toBe("lab 1 soil analysis");
    expect(normalizeTitle("Café Report")).toBe(normalizeTitle("cafe report"));
  });
});

describe("deliverableTypeFor", () => {
  it("maps submission types to an initial deliverable type", () => {
    expect(deliverableTypeFor('["online_quiz"]')).toBe("Exam");
    expect(deliverableTypeFor('["discussion_topic"]')).toBe("Reading");
    expect(deliverableTypeFor('["online_upload"]')).toBe("Project");
    expect(deliverableTypeFor(null)).toBe("Project");
  });
});
