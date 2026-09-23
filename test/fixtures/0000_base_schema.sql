-- Test-only fixture: the okrs and tasks tables are owned by the
-- repo-dashboard repo, which shares this D1 database. This mirrors the
-- columns they have before college-tracker's own migrations (0003+) run.
CREATE TABLE IF NOT EXISTS okrs (
    id TEXT PRIMARY KEY,
    objective TEXT NOT NULL,
    key_result TEXT NOT NULL,
    target_date TEXT,
    status TEXT DEFAULT 'Planned',
    category TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT DEFAULT (DATE('now')),
    description TEXT NOT NULL,
    okr_id TEXT REFERENCES okrs(id),
    time_spent TEXT,
    status TEXT DEFAULT 'Done',
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
