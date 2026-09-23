/**
 * Shapes of the Canvas REST responses we read. Only the fields we use are
 * declared. All ids are strings because every request sends
 * `Accept: application/json+canvas-string-ids`.
 */

export interface CanvasProfileJson {
  id: string;
  name?: string;
  time_zone?: string | null;
}

export interface CanvasCourseJson {
  id: string;
  name?: string | null;
  course_code?: string | null;
  workflow_state?: string | null;
  start_at?: string | null;
  end_at?: string | null;
  term?: { name?: string | null } | null;
}

export interface CanvasAssignmentJson {
  id: string;
  course_id?: string;
  name?: string | null;
  due_at?: string | null;
  lock_at?: string | null;
  unlock_at?: string | null;
  points_possible?: number | null;
  grading_type?: string | null;
  submission_types?: string[] | null;
  published?: boolean | null;
  html_url?: string | null;
  updated_at?: string | null;
}

/**
 * Everything the sync needs from Canvas. The HTTP client implements it;
 * tests substitute a fake so reconciliation logic never touches fetch().
 */
export interface CanvasReader {
  getProfile(): Promise<CanvasProfileJson>;
  listCourses(): Promise<CanvasCourseJson[]>;
  listAssignments(canvasCourseId: string): Promise<CanvasAssignmentJson[]>;
}
