import { env } from "cloudflare:workers";
import worker from "../src/index";

export const TOKEN = "test-token";

/** Call the Worker's fetch handler directly with the test env (authenticated by default). */
export function call(
  path: string,
  opts: { method?: string; json?: unknown; token?: string | null } = {},
): Promise<Response> {
  const headers = new Headers();
  const token = opts.token === undefined ? TOKEN : opts.token;
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const init: RequestInit = { method: opts.method ?? "GET", headers };
  if (opts.json !== undefined) {
    headers.set("Content-Type", "application/json");
    init.body = JSON.stringify(opts.json);
  }
  return worker.fetch(new Request(`https://ct.test${path}`, init), env);
}
