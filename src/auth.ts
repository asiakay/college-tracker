import type { Env } from "./env";

function tokenMatches(header: string, token: string): boolean {
  const enc = new TextEncoder();
  const got = enc.encode(header);
  const want = enc.encode(`Bearer ${token}`);
  return got.byteLength === want.byteLength && crypto.subtle.timingSafeEqual(got, want);
}

/**
 * The app's write-auth rule: open when MCP_SECRET_TOKEN is unset; otherwise
 * accept a matching bearer token or a Cloudflare Access identity (injected by
 * Access for browser users, so they never type a token).
 */
export function isWriteAuthorized(request: Request, env: Env): boolean {
  if (!env.MCP_SECRET_TOKEN) return true;
  const cfUser = request.headers.get("Cf-Access-Authenticated-User-Email");
  const cfJwt = request.headers.get("Cf-Access-Jwt-Assertion");
  if (cfUser && cfJwt) return true;
  return tokenMatches(request.headers.get("Authorization") ?? "", env.MCP_SECRET_TOKEN);
}
