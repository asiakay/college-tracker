-- Canvas submission state and grades (snapshot only; the local assignment's
-- status and grade are updated forward-only by the sync).
ALTER TABLE canvas_assignments ADD COLUMN submission_state TEXT;
ALTER TABLE canvas_assignments ADD COLUMN submitted_at TEXT;
ALTER TABLE canvas_assignments ADD COLUMN graded_at TEXT;
ALTER TABLE canvas_assignments ADD COLUMN score REAL;
ALTER TABLE canvas_assignments ADD COLUMN grade TEXT;
ALTER TABLE canvas_assignments ADD COLUMN late INTEGER;
ALTER TABLE canvas_assignments ADD COLUMN missing INTEGER;
ALTER TABLE canvas_assignments ADD COLUMN excused INTEGER;

-- Course total as Canvas computes it for the student.
ALTER TABLE canvas_courses ADD COLUMN current_score REAL;
ALTER TABLE canvas_courses ADD COLUMN current_grade TEXT;
