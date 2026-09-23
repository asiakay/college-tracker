-- Canvas LMS sync (v1: courses + assignments, read-only).
--
-- Canvas-owned facts live in canvas_* snapshot tables. Each snapshot row
-- links *to* an existing local row (courses.id / assignments.id); local
-- primary keys and student-owned columns are never replaced.
-- All Canvas ids are stored as TEXT (requested with
-- Accept: application/json+canvas-string-ids). Timestamps are ISO-8601 UTC.
-- Additive only: no existing table is rebuilt.

CREATE TABLE IF NOT EXISTS canvas_courses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    canvas_host TEXT NOT NULL,
    canvas_id TEXT NOT NULL,
    local_course_id TEXT REFERENCES courses(id) ON DELETE SET NULL,
    sync_enabled INTEGER NOT NULL DEFAULT 0,
    name TEXT,
    course_code TEXT,
    workflow_state TEXT,
    term_name TEXT,
    start_at TEXT,
    end_at TEXT,
    html_url TEXT,
    content_hash TEXT NOT NULL,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    last_changed_at TEXT NOT NULL,
    removed_at TEXT,
    UNIQUE (canvas_host, canvas_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_canvas_courses_local
    ON canvas_courses(local_course_id) WHERE local_course_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS canvas_assignments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    canvas_host TEXT NOT NULL,
    canvas_id TEXT NOT NULL,
    canvas_course_id TEXT NOT NULL,
    local_assignment_id TEXT REFERENCES assignments(id) ON DELETE SET NULL,
    -- created / title_match / manual = linked; ignored = student unlinked it,
    -- so sync keeps the snapshot current but never re-links or re-creates it.
    link_method TEXT CHECK (link_method IN ('created', 'title_match', 'manual', 'ignored')),
    name TEXT NOT NULL,
    due_at TEXT,
    due_date_local TEXT,
    lock_at TEXT,
    unlock_at TEXT,
    points_possible REAL,
    grading_type TEXT,
    submission_types TEXT,
    published INTEGER,
    html_url TEXT,
    canvas_updated_at TEXT,
    content_hash TEXT NOT NULL,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    last_changed_at TEXT NOT NULL,
    removed_at TEXT,
    UNIQUE (canvas_host, canvas_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_canvas_assignments_local
    ON canvas_assignments(local_assignment_id) WHERE local_assignment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_canvas_assignments_course
    ON canvas_assignments(canvas_host, canvas_course_id);

CREATE TABLE IF NOT EXISTS canvas_sync_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trigger TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'partial', 'failed')),
    summary_json TEXT,
    error TEXT
);

-- Single-row lease so cron and manual runs never overlap.
CREATE TABLE IF NOT EXISTS canvas_sync_lock (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    run_id INTEGER,
    locked_until TEXT
);
INSERT OR IGNORE INTO canvas_sync_lock (id) VALUES (1);
