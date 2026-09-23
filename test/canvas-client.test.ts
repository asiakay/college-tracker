import { describe, expect, it } from "vitest";
import { CanvasClient, CanvasError, getCanvasConfig, parseNextLink } from "../src/canvas/client";

const cfg = { origin: "https://school.instructure.com", host: "school.instructure.com", token: "secret-token" };
const noSleep = async () => {};

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, ...init, headers: { "Content-Type": "application/json", ...(init.headers ?? {}) } });
}

describe("getCanvasConfig", () => {
  it("returns null when not configured", () => {
    expect(getCanvasConfig({} as never)).toBeNull();
    expect(getCanvasConfig({ CANVAS_BASE_URL: "https://x.instructure.com" } as never)).toBeNull();
  });
  it("requires an https origin with no path", () => {
    expect(() => getCanvasConfig({ CANVAS_BASE_URL: "http://x.edu", CANVAS_API_TOKEN: "t" } as never)).toThrow(CanvasError);
    expect(() => getCanvasConfig({ CANVAS_BASE_URL: "https://x.edu/api", CANVAS_API_TOKEN: "t" } as never)).toThrow(CanvasError);
    expect(getCanvasConfig({ CANVAS_BASE_URL: "https://x.edu/", CANVAS_API_TOKEN: "t" } as never))
      .toEqual({ origin: "https://x.edu", host: "x.edu", token: "t" });
  });
});

describe("parseNextLink", () => {
  const o = cfg.origin;
  it("finds rel=next regardless of order and case", () => {
    const h = `<${o}/api/v1/courses?page=1>; rel="current", <${o}/api/v1/courses?page=2>; REL="next", <${o}/api/v1/courses?page=5>; rel="last"`;
    expect(parseNextLink(h, o)).toBe(`${o}/api/v1/courses?page=2`);
  });
  it("returns null without a next link", () => {
    expect(parseNextLink(`<${o}/x?page=1>; rel="first"`, o)).toBeNull();
    expect(parseNextLink(null, o)).toBeNull();
  });
  it("refuses to follow a next link to another host", () => {
    expect(() => parseNextLink(`<https://evil.example/api?page=2>; rel="next"`, o)).toThrow(/unexpected host/);
  });
});

describe("CanvasClient", () => {
  it("sends string-id Accept header and bearer auth, GET only", async () => {
    const calls: Request[] = [];
    const client = new CanvasClient(cfg, {
      sleep: noSleep,
      fetch: async (input, init) => { calls.push(new Request(input, init)); return json({ id: "1", time_zone: "America/New_York" }); },
    });
    const profile = await client.getProfile();
    expect(profile.id).toBe("1");
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.headers.get("accept")).toBe("application/json+canvas-string-ids");
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer secret-token");
  });

  it("follows pagination across pages", async () => {
    const o = cfg.origin;
    const client = new CanvasClient(cfg, {
      sleep: noSleep,
      fetch: async (input) => {
        const url = new URL(String(input));
        const page = url.searchParams.get("page") ?? "1";
        expect(url.searchParams.get("per_page")).toBe("100");
        const next = page === "3" ? {} : { Link: `<${o}/api/v1/courses?page=${Number(page) + 1}&per_page=100>; rel="next"` };
        return json([{ id: `c${page}` }], { headers: next });
      },
    });
    const courses = await client.listCourses();
    expect(courses.map((c) => c.id)).toEqual(["c1", "c2", "c3"]);
    expect(client.requestCount).toBe(3);
  });

  it("retries 429 then succeeds", async () => {
    let n = 0;
    const sleeps: number[] = [];
    const client = new CanvasClient(cfg, {
      sleep: async (ms) => { sleeps.push(ms); },
      fetch: async () => (++n === 1 ? new Response("Rate Limit Exceeded", { status: 429 }) : json({ id: "1" })),
    });
    await expect(client.getProfile()).resolves.toMatchObject({ id: "1" });
    expect(n).toBe(2);
    expect(sleeps.length).toBe(1);
  });

  it("treats 403 'Rate Limit Exceeded' as throttling", async () => {
    let n = 0;
    const client = new CanvasClient(cfg, {
      sleep: noSleep,
      fetch: async () => (++n === 1 ? new Response("403 Forbidden (Rate Limit Exceeded)", { status: 403 }) : json({ id: "1" })),
    });
    await expect(client.getProfile()).resolves.toMatchObject({ id: "1" });
  });

  it("fails fast on 401 without retrying and without leaking the token", async () => {
    let n = 0;
    const client = new CanvasClient(cfg, { sleep: noSleep, fetch: async () => { n++; return new Response("{}", { status: 401 }); } });
    const e = await client.getProfile().catch((x) => x);
    expect(e).toBeInstanceOf(CanvasError);
    expect(e.kind).toBe("auth");
    expect(String(e.message)).not.toContain("secret-token");
    expect(n).toBe(1);
  });

  it("gives up after max retries on 5xx", async () => {
    let n = 0;
    const client = new CanvasClient(cfg, { sleep: noSleep, maxRetries: 2, fetch: async () => { n++; return new Response("", { status: 502 }); } });
    await expect(client.getProfile()).rejects.toMatchObject({ kind: "http", status: 502 });
    expect(n).toBe(3);
  });

  it("enforces the request budget", async () => {
    const client = new CanvasClient(cfg, { sleep: noSleep, maxRequests: 1, fetch: async () => json({ id: "1" }) });
    await client.getProfile();
    await expect(client.getProfile()).rejects.toMatchObject({ kind: "budget" });
  });
});
