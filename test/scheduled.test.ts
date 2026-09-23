import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";

const controller = { scheduledTime: Date.now(), cron: "0 */6 * * *", noRetry() {} } as ScheduledController;

afterEach(() => { vi.restoreAllMocks(); });

describe("scheduled()", () => {
  it("does nothing when Canvas is not configured", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await worker.scheduled(controller, { ...env, CANVAS_API_TOKEN: undefined } as never);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM canvas_sync_runs").first<{ n: number }>())!.n).toBe(0);
  });

  it("records a cron-triggered run", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const path = new URL(String(input instanceof Request ? input.url : input)).pathname;
      const body = path.endsWith("/profile") ? { id: "1", time_zone: "UTC" } : [];
      return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
    });
    await worker.scheduled(controller, env);
    expect(await env.DB.prepare("SELECT trigger, status FROM canvas_sync_runs").first()).toEqual({ trigger: "cron", status: "succeeded" });
  });
});
