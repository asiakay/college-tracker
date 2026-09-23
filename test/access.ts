import { vi } from "vitest";
import { clearAccessKeyCache } from "../src/auth";

export const TEAM = "myteam.cloudflareaccess.com";
export const AUD = "test-aud-tag";
export const ACCESS_ENV = { CF_ACCESS_TEAM_DOMAIN: TEAM, CF_ACCESS_AUD: AUD };

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlJson = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));

/**
 * Serves a test JWKS at the team's certs URL (other fetches pass through to
 * `fallback`) and returns a signer for Access-style JWTs.
 */
export async function mockAccess(fallback?: typeof fetch) {
  clearAccessKeyCache();
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true, ["sign", "verify"],
  ) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey) as JsonWebKey;
  const certs = JSON.stringify({ keys: [{ ...jwk, kid: "k1", alg: "RS256", use: "sig" }] });
  const real = fallback ?? globalThis.fetch.bind(globalThis);
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === `https://${TEAM}/cdn-cgi/access/certs`) return new Response(certs, { headers: { "Content-Type": "application/json" } });
    return real(input as RequestInfo, init);
  });

  return async function jwt(claims: Record<string, unknown> = {}, opts: { kid?: string; signWith?: CryptoKey } = {}) {
    const now = Math.floor(Date.now() / 1000);
    const header = b64urlJson({ alg: "RS256", kid: opts.kid ?? "k1", typ: "JWT" });
    const payload = b64urlJson({ aud: [AUD], iss: `https://${TEAM}`, email: "me@example.edu", iat: now, nbf: now, exp: now + 3600, ...claims });
    const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", opts.signWith ?? pair.privateKey, new TextEncoder().encode(`${header}.${payload}`));
    return `${header}.${payload}.${b64url(new Uint8Array(sig))}`;
  };
}
