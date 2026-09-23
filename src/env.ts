export interface Env {
  DB: D1Database;
  MCP_SECRET_TOKEN?: string;
  ANTHROPIC_API_KEY?: string;
  /** Canvas instance origin, e.g. https://school.instructure.com (a [vars] entry). */
  CANVAS_BASE_URL?: string;
  /** Canvas personal access token (a Worker secret — never sent to the browser). */
  CANVAS_API_TOKEN?: string;
  /** IANA timezone overriding the Canvas profile's time_zone for local due dates. */
  CANVAS_TIMEZONE?: string;
  /** Cloudflare Access team domain, e.g. myteam.cloudflareaccess.com. */
  CF_ACCESS_TEAM_DOMAIN?: string;
  /** Cloudflare Access application audience (AUD) tag. With the team domain, turns on login checks. */
  CF_ACCESS_AUD?: string;
  /** Max Canvas HTTP requests per sync run (defaults to 40). */
  CANVAS_MAX_REQUESTS?: string;
}
