# college-tracker

Cloudflare Worker + static UI for planning coursework against OKRs. It shares the
`repo-dashboard-work-items` D1 database with repo-dashboard, which owns the `okrs`
and `tasks` tables.

## Development

```sh
npm install
npm run typecheck
npm test          # vitest inside workerd with a local D1
npm run dev
```

Migrations are applied one file at a time (the shared database is not tracked by
wrangler's migrations table):

```sh
npm run db:migrate:local  -- migrations/0008_canvas_sync.sql
npm run db:migrate:remote -- migrations/0008_canvas_sync.sql
```

or run the **Apply D1 Migration** workflow in GitHub Actions with the file path.

## Canvas LMS sync

Canvas is the source of truth for institutional facts (courses, published
assignments, official due dates, points). College Tracker keeps personal state:
OKRs, micro-tasks, status, blockers, notes, weights and grades you enter. Sync is
read-only and never overwrites that personal state.

### Setup

1. Apply `migrations/0008_canvas_sync.sql` (see above).
2. In Canvas, go to **Account → Settings → Approved Integrations → New Access
   Token**. Personal tokens are for personal, single-user tools only; some schools
   disable them for students.
3. Store the token as a Worker secret (it is never sent to the browser):
   ```sh
   npx wrangler secret put CANVAS_API_TOKEN
   ```
4. Set your Canvas origin. Uncomment `[vars]` in `wrangler.toml` and set
   `CANVAS_BASE_URL = "https://<school>.instructure.com"`, or store it with
   `npx wrangler secret put CANVAS_BASE_URL`. Optionally set `CANVAS_TIMEZONE`
   (IANA name); otherwise your Canvas profile time zone is used to turn Canvas
   due timestamps into local due dates.
5. Canvas routes use the same auth as the rest of the app: open when
   `MCP_SECRET_TOKEN` is unset; otherwise a matching bearer token or a
   Cloudflare Access login. Either way the Canvas token is never exposed.

### Using it

On **Manage Courses → Canvas Sync**:

1. **Sync now** pulls your active Canvas courses.
2. For each course you care about, pick the matching local course (or **Create a
   new course from Canvas**) and keep **sync assignments** checked, then **Save**.
3. **Sync now** again to pull assignments. A cron also runs every 6 hours.

How assignments are matched:

- If exactly one unlinked local assignment in the course has the same title
  (ignoring case and punctuation), it is linked; your status, notes, blocker,
  weight, grade and tasks are kept.
- If several match, nothing is linked and the sync reports them as possible
  duplicates. Link one manually with
  `POST /api/canvas/assignments/:canvasId/link {"assignment_id": "..."}`.
- Otherwise a local assignment `<course>-C<canvasId>` is created.
- Canvas assignments with no due date are reported but not created.
- Unlinking (`POST /api/canvas/assignments/:canvasId/unlink`) is permanent: later
  syncs will not re-link or re-create it.
- If Canvas stops listing an assignment, it is flagged `canvas_state: "removed"`;
  nothing is deleted.

For linked assignments Canvas owns the title and due date (`PUT
/api/assignments/:id` rejects `due_date` with 409). Logging a finished micro-task
moves an assignment from Not Started to In Progress; it never marks it Submitted.

### API

Same auth as the app's other writes (see Setup step 5).

| Route | Purpose |
|---|---|
| `GET /api/canvas/status` | configured?, host, last run summary |
| `POST /api/canvas/sync` | run a sync now (409 if one is running) |
| `GET /api/canvas/courses` | Canvas courses and their link state |
| `POST /api/canvas/courses/:id/link` | `{local_course_id}` or `{create: true, okr_id}`, optional `sync_enabled` |
| `POST /api/canvas/courses/:id/unlink` | stop syncing a course |
| `GET /api/canvas/assignments?canvas_course_id=` | Canvas assignments and link state |
| `POST /api/canvas/assignments/:id/link` / `unlink` | manual assignment linking |

`GET /api/assignments`, `GET /api/deadlines` and MCP `get_upcoming_deadlines`
include `source`, `canvas_due_at`, `canvas_points`, `canvas_url` and
`canvas_state`. MCP tools `canvas_sync` and `canvas_sync_status` mirror the REST
routes.
