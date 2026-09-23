-- Links found inside an assignment's linked module file (slides, videos, …),
-- shown as Materials. Replaced whenever the file is read again.
CREATE TABLE IF NOT EXISTS canvas_material_links (
  assignment_id TEXT NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  position      INTEGER NOT NULL,
  url           TEXT NOT NULL,
  label         TEXT NOT NULL,
  PRIMARY KEY (assignment_id, url)
);

-- When the linked file's links were last read (NULL = not yet).
ALTER TABLE canvas_materials ADD COLUMN links_read_at TEXT;
