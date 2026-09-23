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
  /** With include[]=total_scores: the student's own enrollment(s). */
  enrollments?: Array<{
    type?: string | null;
    computed_current_score?: number | null;
    computed_current_grade?: string | null;
  }> | null;
}

/** The current student's submission (include[]=submission). */
export interface CanvasSubmissionJson {
  workflow_state?: string | null; // unsubmitted | submitted | pending_review | graded
  submitted_at?: string | null;
  graded_at?: string | null;
  score?: number | null;          // null until the grade is posted to the student
  grade?: string | null;
  late?: boolean | null;
  missing?: boolean | null;
  excused?: boolean | null;
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
  submission?: CanvasSubmissionJson | null;
}

export interface CanvasModuleItemJson {
  id: string;
  module_id?: string;
  title?: string | null;
  type?: string | null; // File | Page | Assignment | Quiz | ExternalUrl | SubHeader | ...
  html_url?: string | null;
  published?: boolean | null;
}

export interface CanvasModuleJson {
  id: string;
  name?: string | null;
  position?: number | null;
  items_count?: number | null;
  /** With include[]=items; Canvas omits it when a module has too many items. */
  items?: CanvasModuleItemJson[] | null;
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
