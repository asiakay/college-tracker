import { describe, expect, it } from "vitest";
// @ts-expect-error — plain browser module, no type declarations
import { exportData, toCsv } from "../public/js/export.js";
import { parseDuration } from "../src/microtasks";

const fmtMinutes = (m: number) => (m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ""}` : `${m}m`);
const base = { assignment_id: "A1", assignment_title: "Homework #1", course_name: "Sci", due_date: "2026-09-28", canvas_url: "https://canvas.example/a/9" };
const tasks = [
  { ...base, id: 12, description: "Answer Q8–22, \"carefully\"", status: "To Do", time_spent: "25m", notes: "Page 4", position: 1 },
  { ...base, id: 10, description: "Review slides", status: "Done", time_spent: "20m", link_url: "https://slides.example/1", link_label: "Slides", done_at: "2026-09-22T10:00:00Z" },
  { ...base, id: 11, description: "=HYPERLINK(\"http://evil\")", status: "In Progress", time_spent: "1h" },
];

describe("assignment export", () => {
  it("orders steps as created and totals the time", () => {
    const d = exportData(tasks, { parseDuration, fmtMinutes });
    expect(d.rows.map((r: unknown[]) => r[1])).toEqual(["Review slides", "=HYPERLINK(\"http://evil\")", "Answer Q8–22, \"carefully\""]);
    expect(d).toMatchObject({ assignment: "Homework #1", total: "1h 45m", remaining: "1h 25m", done: 1 });
    expect(d.rows[0]).toEqual([1, "Review slides", "Done", "20m", "Slides", "https://slides.example/1", "", "", "2026-09-22"]);
  });

  it("writes Excel-friendly, formula-safe CSV", () => {
    const csv = toCsv(exportData(tasks, { parseDuration, fmtMinutes }));
    expect(csv.startsWith("﻿Assignment,Homework #1\r\n")).toBe(true);
    expect(csv).toContain("#,Step,Status,Time estimate,Resource,Resource URL,Details,Last moved,Done on\r\n");
    expect(csv).toContain(`2,"'=HYPERLINK(""http://evil"")",In Progress,1h,`);
    expect(csv).toContain(`3,"Answer Q8–22, ""carefully""",To Do,25m,,,Page 4,,\r\n`);
  });
});
