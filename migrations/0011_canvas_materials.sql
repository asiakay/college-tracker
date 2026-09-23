-- The student's choice of Canvas module item (usually a file) that holds the
-- material for an assignment. Student-owned: sync never writes this table.
CREATE TABLE IF NOT EXISTS canvas_materials (
  assignment_id    TEXT PRIMARY KEY REFERENCES assignments(id) ON DELETE CASCADE,
  canvas_host      TEXT NOT NULL,
  canvas_course_id TEXT NOT NULL,
  module_id        TEXT NOT NULL,
  item_id          TEXT NOT NULL,
  title            TEXT NOT NULL,
  item_type        TEXT,
  html_url         TEXT NOT NULL,
  linked_at        TEXT NOT NULL
);
