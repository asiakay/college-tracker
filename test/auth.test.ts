import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACCESS_ENV, mockAccess } from "./access";
import { call } from "./helpers";

let jwt: Awaited<ReturnType<typeof mockAccess>>;
beforeEach(async () => { jwt = await mockAccess(); });
afterEach(() => { vi.restoreAllMocks(); });

const withJwt = async (path: string, token: string, extra: { method?: string; json?: unknown } = {}) =>
  call(path, { ...extra, token: null, env: { ...ACCESS_ENV, MCP_SECRET_TOKEN: undefined }, headers: { "Cf-Access-Jwt-Assertion": token } });

describe("Cloudflare Access login", () => {
  it("protects reads once configured, and accepts a valid login", async () => {
    const open = { ...ACCESS_ENV, MCP_SECRET_TOKEN: undefined };
    expect((await call("/api/courses", { token: null, env: open })).status).toBe(401);
    expect((await call("/mcp", { method: "POST", token: null, env: open, json: { jsonrpc: "2.0", id: 1, method: "tools/list" } })).status).toBe(401);
    expect((await withJwt("/api/courses", await jwt())).status).toBe(200);
  });

  it("keeps /api/health open", async () => {
    expect((await call("/api/health", { token: null, env: { ...ACCESS_ENV, MCP_SECRET_TOKEN: undefined } })).status).toBe(200);
  });

  it("rejects bad tokens", async () => {
    const other = (await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"],
    ) as CryptoKeyPair).privateKey;
    const now = Math.floor(Date.now() / 1000);
    for (const token of [
      await jwt({ aud: ["someone-else"] }),
      await jwt({ iss: "https://evil.cloudflareaccess.com" }),
      await jwt({ exp: now - 600 }),
      await jwt({ nbf: now + 600 }),
      await jwt({}, { signWith: other }),
      await jwt({}, { kid: "unknown" }),
      "not.a.jwt",
      "garbage",
    ]) {
      expect((await withJwt("/api/courses", token)).status).toBe(401);
    }
  });

  it("does not trust Access headers when Access isn't configured and a token is set", async () => {
    const res = await call("/api/assignments/NOPE/generate-tasks", {
      method: "POST", token: null,
      headers: { "Cf-Access-Authenticated-User-Email": "me@example.edu", "Cf-Access-Jwt-Assertion": await jwt() },
    });
    expect(res.status).toBe(401);
  });

  it("still accepts the bearer token (MCP clients, scripts)", async () => {
    expect((await call("/api/courses", { env: ACCESS_ENV })).status).toBe(200);
  });

  it("lets a logged-in user write without a token", async () => {
    const res = await withJwt("/api/tasks", await jwt(), {
      method: "POST", json: { okr_id: "KR-ACAD-1", description: "Read ch. 1", status: "Done" },
    });
    expect(res.status).toBe(200);
  });

  it("leaves the app open when neither a token nor Access is configured", async () => {
    expect((await call("/api/courses", { token: null, env: { MCP_SECRET_TOKEN: undefined } })).status).toBe(200);
  });
});
