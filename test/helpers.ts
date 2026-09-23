import { env } from "cloudflare:workers";
import worker from "../src/index";

/** Call the Worker's fetch handler directly with the test env. */
export function call(
  path: string,
  opts: { method?: string; json?: unknown; token?: string } = {},
): Promise<Response> {
  const headers = new Headers();
  if (opts.token) headers.set("Authorization", `Bearer ${opts.token}`);
  const init: RequestInit = { method: opts.method ?? "GET", headers };
  if (opts.json !== undefined) {
    headers.set("Content-Type", "application/json");
    init.body = JSON.stringify(opts.json);
  }
  return worker.fetch(new Request(`https://ct.test${path}`, init), env);
}
