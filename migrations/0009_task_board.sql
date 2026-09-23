-- Micro-task board: the student's priority order and a movement history.
-- The tasks table itself is owned by repo-dashboard and is not modified.

CREATE TABLE IF NOT EXISTS task_positions (
    task_id INTEGER PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS task_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    from_status TEXT,            -- NULL = task created
    to_status TEXT NOT NULL,
    at TEXT NOT NULL             -- ISO-8601 UTC
);
CREATE INDEX IF NOT EXISTS ix_task_events_at ON task_events(at);
CREATE INDEX IF NOT EXISTS ix_task_events_task ON task_events(task_id);
