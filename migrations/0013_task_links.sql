-- A resource link for a micro-task (a video, slides, the Canvas submit page),
-- set when steps come from an assignment's instruction file. College-tracker
-- owns this table; the shared tasks table is unchanged.
CREATE TABLE IF NOT EXISTS task_links (
  task_id INTEGER PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  url     TEXT NOT NULL,
  label   TEXT
);
