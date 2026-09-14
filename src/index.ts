/**
 * college-tracker Worker — JSON-RPC 2.0 MCP endpoint at POST /mcp
 *
 * Binds to the shared repo-dashboard-work-items D1 database.
 * Auth: Bearer token matching env.MCP_SECRET_TOKEN (open when unset).
 *
 * Tools:
 *   log_academic_task      — log a micro-task against an OKR, optionally linked to an assignment
 *   get_upcoming_deadlines — assignments due in the next N days
 *   get_degree_progress    — OKR progress matrix (assignments + micro-tasks)
 *   get_daily_summary      — all tasks logged on a given date across all repos
 */

export interface Env {
  DB: D1Database;
  MCP_SECRET_TOKEN?: string;
}

const CORS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function ok(id: unknown, result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), { headers: CORS });
}

function err(id: unknown, code: number, message: string, status = 200): Response {
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }),
    { status, headers: CORS }
  );
}

// ── Tool definitions ─────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "log_academic_task",
    description: "Log a micro-task (15-min sprint) against an OKR, optionally linked to an assignment.",
    inputSchema: {
      type: "object",
      properties: {
        okr_id: { type: "string", description: "ID of the linked OKR (e.g. KR-ACAD-1)" },
        description: { type: "string", description: "What was accomplished" },
        assignment_id: { type: "string", description: "Optional assignment ID to link (e.g. SCI133-A1)" },
        source_repo: {
          type: "string",
          enum: ["repo-dashboard", "masshealth-crm", "college-tracker"],
          description: "Origin service (defaults to college-tracker)",
        },
        time_spent: { type: "string", description: "Time spent, e.g. '15m', '1h'" },
        status: { type: "string", enum: ["To Do", "In Progress", "Done"], description: "Defaults to Done" },
        notes: { type: "string", description: "Optional notes" },
      },
      required: ["okr_id", "description"],
    },
  },
  {
    name: "get_upcoming_deadlines",
    description: "Return assignments due in the next N days, ordered by due date.",
    inputSchema: {
      type: "object",
      properties: {
        days_ahead: { type: "integer", description: "Look-ahead window in days (default 14)" },
      },
      required: [],
    },
  },
  {
    name: "get_degree_progress",
    description: "Return the OKR progress matrix: assignments + micro-task counts per OKR.",
    inputSchema: {
      type: "object",
      properties: {
        term: { type: "string", description: "Optional term filter, e.g. 'Fall 2026'" },
      },
      required: [],
    },
  },
  {
    name: "get_daily_summary",
    description: "All micro-tasks logged on a given date (defaults to UTC today).",
    inputSchema: {
      type: "object",
      properties: {
        date: { type: "string", description: "ISO8601 date string, e.g. '2026-09-14'" },
      },
      required: [],
    },
  },
];

// ── Handlers ─────────────────────────────────────────────────────────────────

async function handleLogAcademicTask(env: Env, args: Record<string, unknown>) {
  const {
    okr_id, description, assignment_id = null,
    source_repo = "college-tracker", time_spent = "15m",
    status = "Done", notes = null,
  } = args as {
    okr_id: string; description: string; assignment_id?: string | null;
    source_repo?: string; time_spent?: string; status?: string; notes?: string | null;
  };

  const okr = await env.DB.prepare("SELECT id FROM okrs WHERE id = ?").bind(okr_id).first();
  if (!okr) return { error: `OKR '${okr_id}' not found` };

  if (assignment_id) {
    const asgn = await env.DB.prepare("SELECT id FROM assignments WHERE id = ?").bind(assignment_id).first();
    if (!asgn) return { error: `Assignment '${assignment_id}' not found` };
  }

  const task = await env.DB.prepare(
    `INSERT INTO tasks (description, okr_id, assignment_id, source_repo, time_spent, status, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`
  ).bind(description, okr_id, assignment_id, source_repo, time_spent, status, notes).first();

  // Auto-submit the assignment when a Done task is logged against it
  if (status === "Done" && assignment_id) {
    await env.DB.prepare(
      `UPDATE assignments SET status = 'Submitted' WHERE id = ? AND status = 'Not Started'`
    ).bind(assignment_id).run();
  }

  return { task };
}

async function handleGetUpcomingDeadlines(env: Env, args: Record<string, unknown>) {
  const days = Number(args["days_ahead"] ?? 14);
  const { results } = await env.DB.prepare(
    `SELECT a.id, a.title, a.due_date, a.deliverable_type, a.weight_pct, a.status, a.notes,
            c.id AS course_id, c.name AS course_name, c.term,
            o.id AS okr_id, o.objective, o.key_result
     FROM assignments a
     JOIN courses c ON c.id = a.course_id
     JOIN okrs o ON o.id = a.okr_id
     WHERE a.due_date BETWEEN DATE('now') AND DATE('now', '+' || ? || ' days')
       AND a.status != 'Graded'
     ORDER BY a.due_date ASC`
  ).bind(days).all();
  return { deadlines: results, days_ahead: days };
}

async function handleGetDegreeProgress(env: Env, args: Record<string, unknown>) {
  const term = args["term"] as string | undefined;

  // Try the view; fall back to inline aggregate if view not yet created
  try {
    const { results } = await env.DB.prepare(
      `SELECT m.* FROM okr_progress_matrix m` +
      (term ? ` JOIN courses c ON c.okr_id = m.okr_id WHERE c.term = ?` : ``)
    ).bind(...(term ? [term] : [])).all();
    return { progress: results };
  } catch {
    const { results } = await env.DB.prepare(
      `SELECT o.id AS okr_id, o.objective, o.key_result, o.status AS milestone_status,
              COUNT(DISTINCT a.id) AS total_assignments,
              SUM(CASE WHEN a.status IN ('Submitted','Graded') THEN 1 ELSE 0 END) AS completed_assignments,
              COUNT(DISTINCT t.id) AS total_micro_tasks,
              SUM(CASE WHEN t.status = 'Done' THEN 1 ELSE 0 END) AS completed_micro_tasks
       FROM okrs o
       LEFT JOIN assignments a ON o.id = a.okr_id
       LEFT JOIN tasks t ON o.id = t.okr_id
       GROUP BY o.id`
    ).all();
    return { progress: results };
  }
}

async function handleGetDailySummary(env: Env, args: Record<string, unknown>) {
  const date = (args["date"] as string | undefined) ?? new Date().toISOString().slice(0, 10);
  const { results } = await env.DB.prepare(
    `SELECT t.id, t.date, t.description, t.okr_id, t.time_spent, t.status, t.notes,
            t.source_repo, t.assignment_id, o.objective, o.key_result
     FROM tasks t
     JOIN okrs o ON o.id = t.okr_id
     WHERE t.date = ?
     ORDER BY t.created_at`
  ).bind(date).all();
  return { date, tasks: results };
}

// ── Main fetch handler ────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (url.pathname === "/api/health" && request.method === "GET") {
      return new Response(JSON.stringify({ status: "ok", service: "college-tracker" }), { headers: CORS });
    }

    if (url.pathname !== "/mcp" || request.method !== "POST") {
      return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: CORS });
    }

    // Auth check
    if (env.MCP_SECRET_TOKEN) {
      const auth = request.headers.get("Authorization") ?? "";
      if (auth !== `Bearer ${env.MCP_SECRET_TOKEN}`) {
        return err(null, -32000, "Unauthorized", 401);
      }
    }

    let body: { jsonrpc?: string; id?: unknown; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } };
    try {
      body = await request.json() as typeof body;
    } catch {
      return err(null, -32700, "Parse error");
    }

    if (body.jsonrpc !== "2.0" || !body.method) {
      return err(body.id ?? null, -32600, "Invalid JSON-RPC request");
    }

    const { id, method, params } = body;

    if (method === "tools/list") {
      return ok(id, { tools: TOOLS });
    }

    if (method !== "tools/call") {
      return err(id, -32601, `Method not found: ${method}`);
    }

    const name = params?.name;
    const args = params?.arguments ?? {};

    try {
      let result: unknown;
      if (name === "log_academic_task")      result = await handleLogAcademicTask(env, args);
      else if (name === "get_upcoming_deadlines") result = await handleGetUpcomingDeadlines(env, args);
      else if (name === "get_degree_progress")    result = await handleGetDegreeProgress(env, args);
      else if (name === "get_daily_summary")      result = await handleGetDailySummary(env, args);
      else return err(id, -32601, `Tool not found: ${name}`);

      return ok(id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
    } catch (e) {
      return err(id, -32603, `Internal error: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
};
