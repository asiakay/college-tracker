import type { Env } from "./env";

function tokenMatches(header: string, token: string): boolean {
  const enc = new TextEncoder();
  const got = enc.encode(header);
  const want = enc.encode(`Bearer ${token}`);
  return got.byteLength === want.byteLength && crypto.subtle.timingSafeEqual(got, want);
}

/** Cloudflare Access protects the site once both values are set (Worker secrets). */
export function accessConfig(env: Env): { team: string; aud: string } | null {
  const team = env.CF_ACCESS_TEAM_DOMAIN?.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const aud = env.CF_ACCESS_AUD?.trim();
  return team && aud ? { team, aud } : null;
}

// ── Access JWT verification (RS256, no library) ─────────────────────────────

interface Jwk extends JsonWebKey { kid?: string }

const JWKS_TTL_MS = 60 * 60 * 1000;
const CLOCK_SKEW_S = 60;
const keyCache = new Map<string, { at: number; keys: Map<string, CryptoKey> }>();

/** Test hook: forget cached signing keys. */
export function clearAccessKeyCache(): void {
  keyCache.clear();
}

async function signingKeys(team: string, refresh = false): Promise<Map<string, CryptoKey>> {
  const cached = keyCache.get(team);
  if (cached && !refresh && Date.now() - cached.at < JWKS_TTL_MS) return cached.keys;
  const res = await fetch(`https://${team}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`Access certs ${res.status}`);
  const { keys = [] } = await res.json() as { keys?: Jwk[] };
  const imported = new Map<string, CryptoKey>();
  for (const jwk of keys) {
    if (!jwk.kid || jwk.kty !== "RSA") continue;
    imported.set(jwk.kid, await crypto.subtle.importKey(
      "jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"],
    ));
  }
  keyCache.set(team, { at: Date.now(), keys: imported });
  return imported;
}

function b64urlBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function b64urlJson(s: string): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(b64urlBytes(s))) as Record<string, unknown>;
}

/**
 * Verifies the Cf-Access-Jwt-Assertion header that Cloudflare Access adds to
 * requests from logged-in users and service tokens. Returns false for any
 * missing, malformed, expired, wrongly-signed or wrong-audience token.
 */
export async function verifyAccessJwt(request: Request, env: Env): Promise<boolean> {
  const cfg = accessConfig(env);
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!cfg || !token) return false;
  try {
    const [h, p, sig] = token.split(".");
    if (!h || !p || !sig) return false;
    const header = b64urlJson(h);
    const payload = b64urlJson(p);
    if (header["alg"] !== "RS256" || typeof header["kid"] !== "string") return false;

    let key = (await signingKeys(cfg.team)).get(header["kid"]);
    if (!key) key = (await signingKeys(cfg.team, true)).get(header["kid"]); // keys rotated
    if (!key) return false;
    const ok = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5", key, b64urlBytes(sig), new TextEncoder().encode(`${h}.${p}`),
    );
    if (!ok) return false;

    const now = Math.floor(Date.now() / 1000);
    const aud = payload["aud"];
    const audOk = Array.isArray(aud) ? aud.includes(cfg.aud) : aud === cfg.aud;
    const exp = Number(payload["exp"]);
    const nbf = payload["nbf"] === undefined ? 0 : Number(payload["nbf"]);
    return audOk
      && payload["iss"] === `https://${cfg.team}`
      && Number.isFinite(exp) && exp + CLOCK_SKEW_S > now
      && nbf - CLOCK_SKEW_S <= now;
  } catch {
    return false;
  }
}

/**
 * The app's auth rule for writes (and, once Access is configured, for reads):
 * - a matching `Authorization: Bearer $MCP_SECRET_TOKEN` is always accepted;
 * - with Cloudflare Access configured, a verified Access login is accepted;
 * - with neither a token nor Access configured, the app is open (as before).
 */
export async function isWriteAuthorized(request: Request, env: Env): Promise<boolean> {
  if (env.MCP_SECRET_TOKEN && tokenMatches(request.headers.get("Authorization") ?? "", env.MCP_SECRET_TOKEN)) return true;
  if (accessConfig(env)) return verifyAccessJwt(request, env);
  return !env.MCP_SECRET_TOKEN;
}

/** Reads are protected only once Cloudflare Access is configured. */
export function requiresLogin(env: Env, pathname: string): boolean {
  if (!accessConfig(env)) return false;
  return (pathname.startsWith("/api/") && pathname !== "/api/health") || pathname === "/mcp";
}
