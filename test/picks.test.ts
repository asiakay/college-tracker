import { describe, expect, it } from "vitest";
// @ts-expect-error — plain browser module, no type declarations
import { nextSteps, stepsHtml } from "../public/js/picks.js";

const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const step = (id: number, status = "To Do", extra: Record<string, unknown> = {}) =>
  ({ id, status, assignment_id: "A1", assignment_title: "Homework #1", description: `Step ${id}`, ...extra });

describe("next steps under a pick", () => {
  const tasks = [
    step(10, "Done"), step(11), step(12, "In Progress"), step(13), step(14), step(15),
    { ...step(20), assignment_id: "A2" },
  ];
  const ids = (r: { steps: Array<{ task: { id: number }; isPick: boolean }> }) => r.steps.map((s) => [s.task.id, s.isPick]);

  it("starts at the pick, follows step order, skips Done and other assignments", () => {
    const r = nextSteps(tasks, tasks[2]);
    expect(ids(r)).toEqual([[12, true], [13, false], [14, false]]);
    expect(r.more).toBe(2); // 15 after, 11 before
  });

  it("fills in earlier open steps near the end", () => {
    expect(ids(nextSteps(tasks, tasks[5]))).toEqual([[15, true], [11, false], [12, false]]);
  });

  it("returns just the pick without an assignment", () => {
    const loose = { id: 99, status: "To Do", assignment_id: null, description: "Email advisor" };
    expect(ids(nextSteps([...tasks, loose], loose))).toEqual([[99, true]]);
  });

  it("renders steps with times, details, links and escaping", () => {
    const list = [
      step(1, "To Do", { time_spent: "25m", notes: "Page 4" }),
      step(2, "In Progress", { description: "Watch <video>", link_url: "https://khan.example/v", link_label: "Khan Academy" }),
    ];
    const html = stepsHtml(list, list[0], esc);
    expect(html).toContain("Next steps in Homework #1");
    expect(html).toContain('<li class="pick-step is-pick">');
    expect(html).toContain(" · 25m");
    expect(html).toContain(" · Page 4");
    expect(html).toContain("◐");
    expect(html).toContain("Watch &lt;video&gt;");
    expect(html).toContain('href="https://khan.example/v"');
    expect(html).not.toContain("more on the board");
  });

  it("renders nothing when the assignment has no other open steps", () => {
    expect(stepsHtml([step(1), step(2, "Done")], step(1), esc)).toBe("");
  });
});
