-- Claude's current "What should I do next?" picks (one set; replaced each time
-- the student asks again). College-tracker owns this table.
CREATE TABLE IF NOT EXISTS task_picks (
  rank      INTEGER PRIMARY KEY CHECK (rank BETWEEN 1 AND 3),
  task_id   INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  reason    TEXT NOT NULL,
  picked_at TEXT NOT NULL
);
