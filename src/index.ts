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
  ANTHROPIC_API_KEY?: string;
}

const CORS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
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

// ── Syllabus parsing ─────────────────────────────────────────────────────────

interface ParsedAssignment {
  title: string;
  due_date: string | null;
  deliverable_type: string;
  weight_pct: number;
  notes: string | null;
}

type SyllabusInput =
  | { text: string; file_base64?: never; file_type?: never }
  | { file_base64: string; file_type: string; text?: never };

async function callClaude(apiKey: string, courseLabel: string, input: SyllabusInput): Promise<ParsedAssignment[]> {
  const instruction = `You are extracting graded assignments from a course syllabus.

Course: ${courseLabel}

Return ONLY a valid JSON array — no markdown, no explanation, no code fences. Each element:
{
  "title": string,
  "due_date": "YYYY-MM-DD" or null if not specified,
  "deliverable_type": one of "Exam" | "Essay" | "Project" | "Reading" | "Code" | "Presentation",
  "weight_pct": number (percentage of final grade, 0 if unspecified),
  "notes": string or null
}

Map assignment types as follows:
- Quiz, midterm, final → "Exam"
- Lab report, lab, problem set, homework, worksheet → "Code"
- Paper, report, reflection → "Essay"
- Group project, capstone, portfolio → "Project"
- Required reading, textbook chapter → "Reading"
- Presentation, demo, talk → "Presentation"

Include: exams, quizzes, homework, problem sets, labs, essays, projects, presentations.
Exclude: participation, attendance, office hours, ungraded readings.`;

  const userContent: unknown[] = input.file_base64
    ? [
        {
          type: "document",
          source: { type: "base64", media_type: input.file_type, data: input.file_base64 },
        },
        { type: "text", text: instruction },
      ]
    : [{ type: "text", text: `${instruction}\n\nSyllabus:\n${input.text!.slice(0, 40000)}` }];

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "pdfs-2024-09-25",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 4096,
      messages: [{ role: "user", content: userContent }],
    }),
  });

  if (!resp.ok) throw new Error(`Anthropic API ${resp.status}: ${await resp.text()}`);

  const data = await resp.json() as { content: Array<{ type: string; text: string }> };
  const raw = data.content.find(c => c.type === "text")?.text?.trim() ?? "[]";
  // Strip possible markdown fences in case model ignores the instruction
  const json = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  return JSON.parse(json) as ParsedAssignment[];
}

interface GeneratedTask {
  description: string;
  time_spent: string;
}

async function generateTasksForAssignment(
  apiKey: string,
  assignment: { title: string; deliverable_type: string; due_date: string | null; course_name: string; weight_pct: number; course_notes?: string | null }
): Promise<GeneratedTask[]> {
  const notesSection = assignment.course_notes
    ? `\nCourse Notes / Context:\n${assignment.course_notes.slice(0, 2000)}`
    : "";
  const prompt = `Break down this assignment into granular, actionable study tasks.

Assignment: ${assignment.title}
Course: ${assignment.course_name}
Type: ${assignment.deliverable_type}
Due: ${assignment.due_date ?? "TBD"}
Weight: ${assignment.weight_pct}% of final grade${notesSection}

Return ONLY a valid JSON array — no markdown, no explanation, no code fences. Each element:
{
  "description": string (short, specific action — max 80 chars),
  "time_spent": string (e.g. "30m", "1h", "1.5h", "2h")
}

Rules:
- 4–10 tasks depending on assignment complexity
- Tasks should be sequential (earlier tasks build on later ones)
- Include research, drafting/working, reviewing, and submission steps as appropriate
- Keep task descriptions concrete and specific, not vague ("study for exam")`;

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!resp.ok) throw new Error(`Anthropic API ${resp.status}: ${await resp.text()}`);
  const data = await resp.json() as { content: Array<{ type: string; text: string }> };
  const raw = data.content.find(c => c.type === "text")?.text?.trim() ?? "[]";
  const json = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  return JSON.parse(json) as GeneratedTask[];
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

    // ── REST: read routes (open) ──────────────────────────────────────────────

    if (url.pathname === "/api/okrs" && request.method === "GET") {
      const category = url.searchParams.get("category");
      const { results } = await env.DB.prepare(
        `SELECT id, objective, key_result, sto_owner, target_date, status, category
         FROM okrs` + (category ? ` WHERE category = ?` : ``) + ` ORDER BY id ASC`
      ).bind(...(category ? [category] : [])).all();
      return new Response(JSON.stringify({ okrs: results }), { headers: CORS });
    }

    if (url.pathname === "/api/deadlines" && request.method === "GET") {
      const days = Math.min(Number(url.searchParams.get("days") ?? 14), 365);
      const { results } = await env.DB.prepare(
        `SELECT a.id, a.title, a.due_date, a.deliverable_type, a.weight_pct, a.status, a.grade, a.notes,
                a.course_id, a.okr_id,
                c.name AS course_name, c.term,
                o.objective, o.key_result
         FROM assignments a
         JOIN courses c ON c.id = a.course_id
         LEFT JOIN okrs o ON o.id = a.okr_id
         WHERE (a.due_date IS NULL OR a.due_date <= DATE('now', '+' || ? || ' days'))
           AND a.status NOT IN ('Submitted', 'Graded')
         ORDER BY a.due_date ASC`
      ).bind(days).all();
      return new Response(JSON.stringify({ deadlines: results, days_ahead: days }), { headers: CORS });
    }

    if (url.pathname === "/api/progress" && request.method === "GET") {
      const category = url.searchParams.get("category");
      const { results } = await env.DB.prepare(
        `SELECT o.id AS okr_id, o.objective, o.key_result,
                COALESCE(o.sto_owner,'Self') AS sto_owner,
                o.target_date, o.status AS milestone_status,
                COUNT(DISTINCT a.id) AS total_assignments,
                SUM(CASE WHEN a.status IN ('Submitted','Graded') THEN 1 ELSE 0 END) AS completed_assignments,
                COUNT(DISTINCT t.id) AS total_micro_tasks,
                SUM(CASE WHEN t.status = 'Done' THEN 1 ELSE 0 END) AS completed_micro_tasks,
                ROUND(CASE WHEN COUNT(DISTINCT t.id) = 0 THEN 0.0
                  ELSE (CAST(SUM(CASE WHEN t.status='Done' THEN 1 ELSE 0 END) AS FLOAT)/COUNT(DISTINCT t.id))*100.0
                  END, 1) AS task_progress_pct
         FROM okrs o
         LEFT JOIN assignments a ON o.id = a.okr_id
         LEFT JOIN tasks t ON o.id = t.okr_id` +
        (category ? ` WHERE o.category = ?` : ``) +
        ` GROUP BY o.id ORDER BY o.id ASC`
      ).bind(...(category ? [category] : [])).all();
      return new Response(JSON.stringify({ progress: results }), { headers: CORS });
    }

    if (url.pathname === "/api/courses" && request.method === "GET") {
      const term = url.searchParams.get("term");
      const { results } = await env.DB.prepare(
        `SELECT id, name, instructor, term, okr_id, credits, notes, created_at FROM courses` +
        (term ? ` WHERE term = ?` : ``) +
        ` ORDER BY term DESC, name ASC`
      ).bind(...(term ? [term] : [])).all();
      return new Response(JSON.stringify({ courses: results }), { headers: CORS });
    }

    if (url.pathname === "/api/assignments" && request.method === "GET") {
      const course_id = url.searchParams.get("course_id");
      const status = url.searchParams.get("status");
      const clauses: string[] = [];
      const binds: string[] = [];
      if (course_id) { clauses.push("a.course_id = ?"); binds.push(course_id); }
      if (status)    { clauses.push("a.status = ?");    binds.push(status); }
      const where = clauses.length ? " WHERE " + clauses.join(" AND ") : "";
      const { results } = await env.DB.prepare(
        `SELECT a.*, c.name AS course_name, c.term FROM assignments a
         JOIN courses c ON c.id = a.course_id${where}
         ORDER BY a.due_date ASC`
      ).bind(...binds).all();
      return new Response(JSON.stringify({ assignments: results }), { headers: CORS });
    }

    if (url.pathname === "/api/tasks" && request.method === "GET") {
      const date = (url.searchParams.get("date") ?? new Date().toISOString().slice(0, 10));
      const okr_id = url.searchParams.get("okr_id");
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 200);
      const clauses = ["t.date = ?"];
      const binds: unknown[] = [date];
      if (okr_id) { clauses.push("t.okr_id = ?"); binds.push(okr_id); }
      const { results } = await env.DB.prepare(
        `SELECT t.id, t.date, t.description, t.okr_id, t.time_spent, t.status, t.notes,
                t.source_repo, t.assignment_id, o.objective, o.key_result
         FROM tasks t JOIN okrs o ON o.id = t.okr_id
         WHERE ${clauses.join(" AND ")}
         ORDER BY t.created_at DESC LIMIT ?`
      ).bind(...binds, limit).all();
      return new Response(JSON.stringify({ date, tasks: results }), { headers: CORS });
    }

    // ── parse-course-info (public POST — no auth required) ─────────────────
    if (url.pathname === "/api/parse-course-info" && request.method === "POST") {
      let body: Record<string, unknown>;
      try { body = await request.json() as Record<string, unknown>; }
      catch { return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers: CORS }); }

      const { text, file_base64, file_type } = body as { text?: string; file_base64?: string; file_type?: string };
      const hasFile = file_base64 && typeof file_base64 === "string" && file_base64.length > 0;
      const hasText = text && typeof text === "string" && text.trim().length >= 20;
      if (!hasFile && !hasText) {
        return new Response(
          JSON.stringify({ error: "Provide a base64-encoded PDF (file_base64) or at least 20 characters of text" }),
          { status: 422, headers: CORS }
        );
      }

      if (!env.ANTHROPIC_API_KEY) {
        return new Response(
          JSON.stringify({ error: "ANTHROPIC_API_KEY not configured" }),
          { status: 503, headers: CORS }
        );
      }

      const ciInstruction = `Extract course information from this syllabus. Return ONLY valid JSON with no markdown fences or explanation:
{
  "name": "Full course title",
  "course_code": "course code, e.g. SCI-133 or ENGL 101",
  "term": "semester and year, e.g. Fall 2026",
  "credits": 3,
  "instructor": "instructor full name or null"
}`;

      const ciInput: SyllabusInput = hasFile
        ? { file_base64: file_base64!, file_type: file_type || "application/pdf" }
        : { text: text! };

      const ciContent: unknown[] = ciInput.file_base64
        ? [
            { type: "document", source: { type: "base64", media_type: ciInput.file_type, data: ciInput.file_base64 } },
            { type: "text", text: ciInstruction },
          ]
        : [{ type: "text", text: `${ciInstruction}\n\nSyllabus:\n${(ciInput.text!).slice(0, 40000)}` }];

      let ciParsed: { name?: string; course_code?: string; term?: string; credits?: number | null; instructor?: string | null };
      try {
        const ciResp = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": env.ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01",
            "anthropic-beta": "pdfs-2024-09-25",
          },
          body: JSON.stringify({
            model: "claude-haiku-4-5-20251001",
            max_tokens: 512,
            messages: [{ role: "user", content: ciContent }],
          }),
        });
        if (!ciResp.ok) throw new Error(`Anthropic API ${ciResp.status}: ${await ciResp.text()}`);
        const ciData = await ciResp.json() as { content: Array<{ type: string; text: string }> };
        const ciRaw = ciData.content.find(c => c.type === "text")?.text?.trim() ?? "{}";
        const ciJson = ciRaw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
        ciParsed = JSON.parse(ciJson);
      } catch (e) {
        return new Response(
          JSON.stringify({ error: `Parse failed: ${e instanceof Error ? e.message : String(e)}` }),
          { status: 502, headers: CORS }
        );
      }

      return new Response(JSON.stringify({
        name: ciParsed.name ?? null,
        course_code: ciParsed.course_code ?? null,
        term: ciParsed.term ?? null,
        credits: ciParsed.credits ?? null,
        instructor: ciParsed.instructor ?? null,
      }), { headers: CORS });
    }

    // ── parse-assignment-doc: extract structured fields from one assignment doc ──
    if (url.pathname === "/api/parse-assignment-doc" && request.method === "POST") {
      let body: Record<string, unknown>;
      try { body = await request.json() as Record<string, unknown>; }
      catch { return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers: CORS }); }

      const { text, file_base64, file_type } = body as { text?: string; file_base64?: string; file_type?: string };
      const hasFile = file_base64 && typeof file_base64 === "string" && file_base64.length > 0;
      const hasText = text && typeof text === "string" && text.trim().length >= 10;
      if (!hasFile && !hasText)
        return new Response(JSON.stringify({ error: "Provide file_base64 or text" }), { status: 422, headers: CORS });

      if (!env.ANTHROPIC_API_KEY)
        return new Response(JSON.stringify({ error: "ANTHROPIC_API_KEY not configured" }), { status: 503, headers: CORS });

      const instruction = `Extract the assignment details from this document. Return ONLY valid JSON — no markdown, no explanation, no code fences:
{
  "title": "assignment title (required)",
  "due_date": "YYYY-MM-DD or null if not found",
  "deliverable_type": "one of: Exam | Essay | Project | Reading | Code | Presentation",
  "weight_pct": "number — percentage of final grade, 0 if not found"
}
Map types: quiz/midterm/final/test → Exam; lab/homework/problem set/worksheet/exercise → Code; paper/report/reflection/essay → Essay; project/capstone/portfolio → Project; reading/chapter → Reading; presentation/demo/talk → Presentation.`;

      const userContent: unknown[] = hasFile
        ? [
            { type: "document", source: { type: "base64", media_type: file_type || "application/pdf", data: file_base64 } },
            { type: "text", text: instruction },
          ]
        : [{ type: "text", text: `${instruction}\n\nDocument text:\n${(text as string).slice(0, 20000)}` }];

      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "pdfs-2024-09-25",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 512,
          messages: [{ role: "user", content: userContent }],
        }),
      });

      if (!resp.ok)
        return new Response(JSON.stringify({ error: `Anthropic API ${resp.status}` }), { status: 502, headers: CORS });

      const asnData2 = await resp.json() as { content: Array<{ type: string; text: string }> };
      const raw2 = asnData2.content.find(c => c.type === "text")?.text?.trim() ?? "{}";
      const json2 = raw2.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
      let parsedAsn: { title?: string; due_date?: string | null; deliverable_type?: string; weight_pct?: number };
      try { parsedAsn = JSON.parse(json2); }
      catch { return new Response(JSON.stringify({ error: "Model response could not be parsed" }), { status: 502, headers: CORS }); }

      const VALID_ASN_TYPES = new Set(["Essay","Exam","Project","Reading","Code","Presentation"]);
      return new Response(JSON.stringify({
        title: parsedAsn.title ?? "",
        due_date: parsedAsn.due_date ?? null,
        deliverable_type: VALID_ASN_TYPES.has(parsedAsn.deliverable_type ?? "") ? parsedAsn.deliverable_type : "Project",
        weight_pct: Number(parsedAsn.weight_pct) || 0,
      }), { headers: CORS });
    }

    // ── extract-text: pull raw text from a PDF or plain text (no auth) ─────────
    if (url.pathname === "/api/extract-text" && request.method === "POST") {
      let body: Record<string, unknown>;
      try { body = await request.json() as Record<string, unknown>; }
      catch { return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers: CORS }); }

      const { text, file_base64, file_type } = body as { text?: string; file_base64?: string; file_type?: string };
      const hasFile = file_base64 && typeof file_base64 === "string" && file_base64.length > 0;
      const hasText = text && typeof text === "string" && text.trim().length > 0;

      if (!hasFile && !hasText)
        return new Response(JSON.stringify({ error: "Provide file_base64 or text" }), { status: 422, headers: CORS });

      if (!env.ANTHROPIC_API_KEY)
        return new Response(JSON.stringify({ error: "ANTHROPIC_API_KEY not configured" }), { status: 503, headers: CORS });

      if (!hasFile) {
        return new Response(JSON.stringify({ text: (text as string).trim() }), { headers: CORS });
      }

      const userContent: unknown[] = [
        { type: "document", source: { type: "base64", media_type: file_type || "application/pdf", data: file_base64 } },
        { type: "text", text: "Extract all readable text from this document. Return only the raw extracted text — no commentary, no formatting markers, no preamble." },
      ];

      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "pdfs-2024-09-25",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 4096,
          messages: [{ role: "user", content: userContent }],
        }),
      });

      if (!resp.ok)
        return new Response(JSON.stringify({ error: `Anthropic API ${resp.status}` }), { status: 502, headers: CORS });

      const data = await resp.json() as { content: Array<{ type: string; text: string }> };
      const extracted = data.content.find(c => c.type === "text")?.text?.trim() ?? "";
      return new Response(JSON.stringify({ text: extracted }), { headers: CORS });
    }

    // ── parse-syllabus (public POST — no auth required) ──────────────────────

    const parseSylMatch = url.pathname.match(/^\/api\/courses\/([^/]+)\/parse-syllabus$/);
    if (parseSylMatch && request.method === "POST") {
      let body: Record<string, unknown>;
      try { body = await request.json() as Record<string, unknown>; }
      catch { return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers: CORS }); }

      const invalid = (msg: string) =>
        new Response(JSON.stringify({ error: msg }), { status: 422, headers: CORS });

      const courseId = parseSylMatch[1];
      const course = await env.DB.prepare(
        "SELECT id, name, okr_id FROM courses WHERE id = ?"
      ).bind(courseId).first<{ id: string; name: string; okr_id: string }>();
      if (!course) return new Response(JSON.stringify({ error: "Course not found" }), { status: 404, headers: CORS });

      const { text, file_base64, file_type } = body as { text?: string; file_base64?: string; file_type?: string };
      const hasFile = file_base64 && typeof file_base64 === "string" && file_base64.length > 0;
      const hasText = text && typeof text === "string" && text.trim().length >= 20;
      if (!hasFile && !hasText)
        return invalid("Provide either a base64-encoded PDF (file_base64) or at least 20 characters of syllabus text");

      if (!env.ANTHROPIC_API_KEY) {
        return new Response(
          JSON.stringify({ error: "ANTHROPIC_API_KEY not configured — add it in the Cloudflare dashboard" }),
          { status: 503, headers: CORS }
        );
      }

      const idRows = await env.DB.prepare(
        "SELECT id FROM assignments WHERE course_id = ?"
      ).bind(courseId).all<{ id: string }>();
      let maxSuffix = 0;
      for (const row of idRows.results ?? []) {
        const m = row.id.match(/-A(\d+)$/);
        if (m) maxSuffix = Math.max(maxSuffix, parseInt(m[1]!, 10));
      }
      const nextIdx = maxSuffix + 1;

      const syllabusInput: SyllabusInput = hasFile
        ? { file_base64: file_base64!, file_type: file_type || "application/pdf" }
        : { text: text! };

      let parsed: ParsedAssignment[];
      try {
        parsed = await callClaude(env.ANTHROPIC_API_KEY, `${course.name} (${course.id})`, syllabusInput);
      } catch (e) {
        return new Response(
          JSON.stringify({ error: `Parse failed: ${e instanceof Error ? e.message : String(e)}` }),
          { status: 502, headers: CORS }
        );
      }

      const VALID_TYPES = new Set(["Essay","Exam","Project","Reading","Code","Presentation"]);
      const assignments = parsed.map((a, i) => ({
        id: `${courseId}-A${nextIdx + i}`,
        course_id: courseId,
        okr_id: course.okr_id,
        title: a.title,
        due_date: a.due_date ?? null,
        deliverable_type: VALID_TYPES.has(a.deliverable_type) ? a.deliverable_type : "Project",
        weight_pct: Number(a.weight_pct) || 0,
        notes: a.notes ?? null,
        status: "Not Started",
      }));

      return new Response(JSON.stringify({ course, assignments, count: assignments.length }), { headers: CORS });
    }

    // ── POST /api/assignments (public — no write token required) ──────────────
    if (url.pathname === "/api/assignments" && request.method === "POST") {
      let body: Record<string, unknown>;
      try { body = await request.json() as Record<string, unknown>; }
      catch { return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers: CORS }); }
      const invalid422 = (msg: string) =>
        new Response(JSON.stringify({ error: msg }), { status: 422, headers: CORS });
      const { id, course_id, okr_id, title, due_date,
              deliverable_type = "Project", weight_pct = 0, notes = null } = body as Record<string, unknown>;
      if (!id || !course_id || !okr_id || !title)
        return invalid422("id, course_id, okr_id, and title are required");
      const asnCourse = await env.DB.prepare("SELECT id FROM courses WHERE id = ?").bind(course_id).first();
      if (!asnCourse) return invalid422(`Course '${course_id}' not found`);
      const asnOkr = await env.DB.prepare("SELECT id FROM okrs WHERE id = ?").bind(okr_id).first();
      if (!asnOkr) return invalid422(`OKR '${okr_id}' not found`);
      const row = await env.DB.prepare(
        `INSERT OR IGNORE INTO assignments (id, course_id, okr_id, title, due_date, deliverable_type, weight_pct, notes)
         VALUES (?,?,?,?,?,?,?,?) RETURNING *`
      ).bind(id, course_id, okr_id, title, due_date, deliverable_type, weight_pct, notes).first();
      return new Response(JSON.stringify({ assignment: row ?? { id, skipped: true } }), { headers: CORS });
    }

    // ── REST: write routes (bearer-token protected) ───────────────────────────

    const isWrite = ["POST", "PUT", "PATCH", "DELETE"].includes(request.method);
    if (isWrite && url.pathname.startsWith("/api/")) {
      if (env.MCP_SECRET_TOKEN) {
        const auth = request.headers.get("Authorization") ?? "";
        if (auth !== `Bearer ${env.MCP_SECRET_TOKEN}`) {
          return err(null, -32000, "Unauthorized", 401);
        }
      }

      let body: Record<string, unknown> = {};
      if (request.method !== "DELETE") {
        try { body = await request.json() as Record<string, unknown>; }
        catch { return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers: CORS }); }
      }

      const invalid = (msg: string) =>
        new Response(JSON.stringify({ error: msg }), { status: 422, headers: CORS });

      // POST /api/assignments/:id/generate-tasks
      const genTasksMatch = url.pathname.match(/^\/api\/assignments\/([^/]+)\/generate-tasks$/);
      if (genTasksMatch && request.method === "POST") {
        const assignmentId = genTasksMatch[1];
        const asnRow = await env.DB.prepare(
          `SELECT a.id, a.title, a.due_date, a.deliverable_type, a.weight_pct, a.okr_id,
                  c.name AS course_name, c.notes AS course_notes
           FROM assignments a JOIN courses c ON c.id = a.course_id
           WHERE a.id = ?`
        ).bind(assignmentId).first<{
          id: string; title: string; due_date: string | null;
          deliverable_type: string; weight_pct: number; okr_id: string;
          course_name: string; course_notes: string | null;
        }>();
        if (!asnRow) return new Response(JSON.stringify({ error: "Assignment not found" }), { status: 404, headers: CORS });
        if (!env.ANTHROPIC_API_KEY)
          return new Response(JSON.stringify({ error: "ANTHROPIC_API_KEY not configured" }), { status: 503, headers: CORS });
        let generated: GeneratedTask[];
        try {
          generated = await generateTasksForAssignment(env.ANTHROPIC_API_KEY, asnRow);
        } catch (e) {
          return new Response(
            JSON.stringify({ error: `Task generation failed: ${e instanceof Error ? e.message : String(e)}` }),
            { status: 502, headers: CORS }
          );
        }
        const tasks: unknown[] = [];
        for (const t of generated) {
          const row = await env.DB.prepare(
            `INSERT INTO tasks (description, okr_id, assignment_id, source_repo, time_spent, status)
             VALUES (?, ?, ?, 'college-tracker', ?, 'To Do') RETURNING *`
          ).bind(t.description, asnRow.okr_id, assignmentId, t.time_spent).first();
          if (row) tasks.push(row);
        }
        return new Response(JSON.stringify({ tasks, count: tasks.length }), { headers: CORS });
      }

      // POST /api/tasks
      if (url.pathname === "/api/tasks" && request.method === "POST") {
        const result = await handleLogAcademicTask(env, body);
        if ("error" in result) return invalid(result.error as string);
        return new Response(JSON.stringify(result), { headers: CORS });
      }

      // POST /api/okrs
      if (url.pathname === "/api/okrs" && request.method === "POST") {
        const { id, objective, key_result, category = "education", target_date = null, status = "In Progress" } = body as Record<string, unknown>;
        if (!id || !objective || !key_result)
          return invalid("id, objective, and key_result are required");
        try {
          const row = await env.DB.prepare(
            `INSERT INTO okrs (id, objective, key_result, category, target_date, status) VALUES (?,?,?,?,?,?) RETURNING *`
          ).bind(id, objective, key_result, category, target_date, status).first();
          return new Response(JSON.stringify({ okr: row }), { headers: CORS });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (msg.includes("UNIQUE") || msg.includes("unique")) {
            const existing = await env.DB.prepare("SELECT * FROM okrs WHERE id = ?").bind(id).first();
            return new Response(JSON.stringify({ okr: existing, skipped: true }), { headers: CORS });
          }
          throw e;
        }
      }

      // POST /api/courses
      if (url.pathname === "/api/courses" && request.method === "POST") {
        const { id, name, term, okr_id, instructor = null, credits = null } = body as Record<string, unknown>;
        if (!id || !name || !term || !okr_id)
          return invalid("id, name, term, and okr_id are required");
        const okr = await env.DB.prepare("SELECT id FROM okrs WHERE id = ?").bind(okr_id).first();
        if (!okr) return invalid(`OKR '${okr_id}' not found`);
        const row = await env.DB.prepare(
          `INSERT INTO courses (id, name, term, okr_id, instructor, credits) VALUES (?,?,?,?,?,?) RETURNING *`
        ).bind(id, name, term, okr_id, instructor, credits).first();
        return new Response(JSON.stringify({ course: row }), { headers: CORS });
      }

      // PUT /api/courses/:id
      const courseMatch = url.pathname.match(/^\/api\/courses\/([^/]+)$/);
      if (courseMatch && request.method === "PUT") {
        const courseId = courseMatch[1];
        const { name, term, okr_id, instructor, credits } = body as Record<string, unknown>;
        if (okr_id !== undefined) {
          const okr = await env.DB.prepare("SELECT id FROM okrs WHERE id = ?").bind(okr_id).first();
          if (!okr) return invalid(`OKR '${okr_id}' not found`);
        }
        const fields: string[] = [];
        const vals: unknown[] = [];
        if (name       !== undefined) { fields.push("name = ?");       vals.push(name); }
        if (term       !== undefined) { fields.push("term = ?");       vals.push(term); }
        if (okr_id     !== undefined) { fields.push("okr_id = ?");     vals.push(okr_id); }
        if (instructor !== undefined) { fields.push("instructor = ?"); vals.push(instructor); }
        if (credits    !== undefined) { fields.push("credits = ?");    vals.push(credits); }
        const { notes } = body as Record<string, unknown>;
        if (notes      !== undefined) { fields.push("notes = ?");      vals.push(notes); }
        if (!fields.length) return invalid("No updatable fields provided");
        const row = await env.DB.prepare(
          `UPDATE courses SET ${fields.join(", ")} WHERE id = ? RETURNING *`
        ).bind(...vals, courseId).first();
        if (!row) return new Response(JSON.stringify({ error: "Course not found" }), { status: 404, headers: CORS });
        return new Response(JSON.stringify({ course: row }), { headers: CORS });
      }

      // DELETE /api/courses/:id
      if (courseMatch && request.method === "DELETE") {
        const courseId = courseMatch[1];
        const existing = await env.DB.prepare("SELECT id FROM courses WHERE id = ?").bind(courseId).first();
        if (!existing) return new Response(JSON.stringify({ error: "Course not found" }), { status: 404, headers: CORS });
        await env.DB.prepare("DELETE FROM courses WHERE id = ?").bind(courseId).run();
        return new Response(JSON.stringify({ deleted: true, id: courseId }), { headers: CORS });
      }

      // PUT /api/assignments/:id
      const asnMatch = url.pathname.match(/^\/api\/assignments\/([^/]+)$/);
      if (asnMatch && request.method === "PUT") {
        const asnId = asnMatch[1];
        const { status, grade = null, notes = null } = body as Record<string, unknown>;
        const fields: string[] = [];
        const vals: unknown[] = [];
        if (status !== undefined) { fields.push("status = ?"); vals.push(status); }
        if (grade   !== undefined) { fields.push("grade = ?");  vals.push(grade); }
        if (notes   !== undefined) { fields.push("notes = ?");  vals.push(notes); }
        if (!fields.length) return invalid("No updatable fields provided");
        const row = await env.DB.prepare(
          `UPDATE assignments SET ${fields.join(", ")} WHERE id = ? RETURNING *`
        ).bind(...vals, asnId).first();
        if (!row) return new Response(JSON.stringify({ error: "Assignment not found" }), { status: 404, headers: CORS });
        return new Response(JSON.stringify({ assignment: row }), { headers: CORS });
      }
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
