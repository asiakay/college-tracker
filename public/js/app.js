// College Tracker — app.js
// All REST calls go to the same Worker origin (no CORS needed in prod).
// In local dev point BASE_URL at the wrangler dev server.

const BASE = '';  // same origin

// ── Auth ──────────────────────────────────────────────────────────────────
function getToken() {
  try { return localStorage.getItem('ct_token') || localStorage.getItem('ct_write_token') || ''; } catch { return ''; }
}
function setToken(t) {
  try { localStorage.setItem('ct_token', t); } catch {}
}

// ── Fetch helpers ──────────────────────────────────────────────────────────
async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...opts.headers };
  const tok = getToken();
  if (tok) headers['Authorization'] = `Bearer ${tok}`;
  const res = await fetch(BASE + path, { ...opts, headers });
  if (res.status === 401) {
    setToken('');
    try { localStorage.removeItem('ct_write_token'); } catch {}
    showTokenPrompt();
    throw new Error('Unauthorized');
  }
  return res.json();
}

function get(path) { return api(path); }
function post(path, body) { return api(path, { method: 'POST', body: JSON.stringify(body) }); }
function put(path, body) { return api(path, { method: 'PUT', body: JSON.stringify(body) }); }

// ── Toast ──────────────────────────────────────────────────────────────────
function toast(msg, type = 'ok') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  document.getElementById('toast-area').appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

// ── Date helpers ───────────────────────────────────────────────────────────
function today() { return new Date().toISOString().slice(0, 10); }

function countdown(dateStr) {
  const due = new Date(dateStr + 'T23:59:59');
  const now = new Date();
  const diff = Math.ceil((due - now) / 86400000);
  if (diff < 0) return { label: `${-diff}d overdue`, cls: 'urgent' };
  if (diff === 0) return { label: 'due today', cls: 'urgent' };
  if (diff === 1) return { label: 'tomorrow', cls: 'soon' };
  if (diff <= 7)  return { label: `in ${diff} days`, cls: 'soon' };
  return { label: `in ${diff} days`, cls: '' };
}

function urgencyClass(dateStr) {
  const { cls } = countdown(dateStr);
  if (cls === 'urgent') return 'urgency-red';
  if (cls === 'soon')   return 'urgency-amber';
  return 'urgency-muted';
}

function fmt(dateStr) {
  if (!dateStr) return '';
  const [y, m, d] = dateStr.split('-');
  return `${m}/${d}/${y}`;
}

// ── Status chips ───────────────────────────────────────────────────────────
const STATUS_CHIP = {
  'Not Started': 'chip-not',
  'In Progress': 'chip-prog',
  'Submitted':   'chip-sub',
  'Graded':      'chip-graded',
};

function statusChip(s) {
  return `<span class="chip ${STATUS_CHIP[s] || 'chip-not'}">${s}</span>`;
}

// ── Tab routing ────────────────────────────────────────────────────────────
const VIEWS = {
  today:     { el: 'view-today',     load: loadToday },
  deadlines: { el: 'view-deadlines', load: loadDeadlines },
  courses:   { el: 'view-courses',   load: loadCourses },
  progress:  { el: 'view-progress',  load: loadProgress },
  history:   { el: 'view-history',   load: loadHistory },
};

let currentTab = 'today';

function switchTab(name) {
  if (!VIEWS[name]) return;
  document.querySelectorAll('.tab-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === name);
    b.setAttribute('aria-selected', b.dataset.tab === name ? 'true' : 'false');
  });
  Object.entries(VIEWS).forEach(([k, v]) => {
    document.getElementById(v.el).classList.toggle('active', k === name);
  });
  const toggle = document.getElementById('log-toggle');
  toggle.classList.toggle('visible', name === 'today' || name === 'progress');

  currentTab = name;
  VIEWS[name].load();
}

// ── TODAY ──────────────────────────────────────────────────────────────────
async function loadToday() {
  const [dl, tasks] = await Promise.all([
    get('/api/deadlines?days=7').catch(() => ({ deadlines: [] })),
    get(`/api/tasks?date=${today()}`).catch(() => ({ tasks: [] })),
  ]);
  renderTodayDeadlines(dl.deadlines || []);
  renderTodayTasks(tasks.tasks || []);
}

function renderTodayDeadlines(items) {
  const el = document.getElementById('today-deadlines');
  const overdue  = items.filter(a => countdown(a.due_date).label.includes('overdue'));
  const upcoming = items.filter(a => !countdown(a.due_date).label.includes('overdue'));

  if (!overdue.length && !upcoming.length) {
    el.innerHTML = `<div class="empty"><div class="empty-icon">🎉</div>Nothing due this week</div>`;
    return;
  }

  const card = a => {
    const cd = countdown(a.due_date);
    return `<div class="card">
      <div class="asn-row">
        <div class="asn-urgency ${urgencyClass(a.due_date)}"></div>
        <div class="asn-body">
          <div class="asn-title">${esc(a.title)}</div>
          <div class="asn-meta">
            <span class="chip chip-course">${esc(a.course_name)}</span>
            <span class="asn-due ${cd.cls}">${cd.label}</span>
            ${statusChip(a.status)}
          </div>
        </div>
      </div>
    </div>`;
  };

  let html = '';
  if (overdue.length) {
    html += `<div class="today-col-title section-overdue">⚠ Past due (${overdue.length})</div>`;
    html += overdue.map(card).join('');
  }
  if (upcoming.length) {
    if (overdue.length) html += `<div class="today-col-title" style="margin-top:16px">Due this week</div>`;
    html += upcoming.slice(0, 6).map(card).join('');
  }
  el.innerHTML = html;
}

function renderTodayTasks(tasks) {
  const el = document.getElementById('today-tasks');
  if (!tasks.length) {
    el.innerHTML = `<div class="empty"><div class="empty-icon">📋</div>Nothing logged yet today<br>Use the Log task button below to start a session.</div>`;
    return;
  }
  el.innerHTML = `<div class="card">${tasks.map(t => `
    <div class="task-row">
      <div class="task-time">${t.time_spent || '—'}</div>
      <div class="task-body">
        <div class="task-desc">${esc(t.description)}</div>
        <div class="task-okr">${esc(t.key_result)}${t.assignment_id ? `<span class="task-asn"># ${esc(t.assignment_id)}</span>` : ''}</div>
      </div>
    </div>`).join('')}</div>`;
}

// ── DEADLINES ─────────────────────────────────────────────────────────────
let allDeadlines = [];

async function loadDeadlines() {
  const days = document.getElementById('dl-days-filter').value || 14;
  const data = await get(`/api/deadlines?days=${days}`).catch(() => ({ deadlines: [] }));
  allDeadlines = data.deadlines || [];
  populateCourseFilter(allDeadlines);
  renderDeadlines();
}

function populateCourseFilter(items) {
  const sel = document.getElementById('dl-course-filter');
  const current = sel.value;
  const courses = [...new Set(items.map(i => i.course_name))].sort();
  sel.innerHTML = `<option value="">All courses</option>` +
    courses.map(c => `<option${c === current ? ' selected' : ''}>${esc(c)}</option>`).join('');
}

function renderDeadlines() {
  const courseF = document.getElementById('dl-course-filter').value;
  const statusF = document.getElementById('dl-status-filter').value;

  const rows = allDeadlines.filter(a =>
    (!courseF || a.course_name === courseF) &&
    (!statusF || a.status === statusF)
  );

  const tbody = document.getElementById('deadlines-body');
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="6"><div class="empty">No assignments match the current filters.</div></td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map(a => {
    const cd = countdown(a.due_date);
    const rowCls = cd.cls === 'urgent' ? 'row-red' : cd.cls === 'soon' ? 'row-amber' : '';
    const id = `s-${a.id}`;
    const canBreakDown = a.status !== 'Submitted' && a.status !== 'Graded';
    return `<tr class="${rowCls}" data-id="${esc(a.id)}">
      <td>
        ${esc(a.title)}
        ${canBreakDown ? `<button class="btn-breakdown" data-asn="${esc(a.id)}" title="Generate study tasks">Break down →</button>` : ''}
      </td>
      <td><span class="chip chip-course">${esc(a.course_name)}</span></td>
      <td><span class="chip chip-type">${esc(a.deliverable_type)}</span></td>
      <td class="mono">${a.weight_pct ? a.weight_pct + '%' : '—'}</td>
      <td class="mono asn-due ${cd.cls}" title="${esc(a.due_date)}">${fmt(a.due_date)} · ${cd.label}</td>
      <td>
        <div class="status-wrap" id="${id}">
          <span class="status-chip chip ${STATUS_CHIP[a.status] || 'chip-not'}">${esc(a.status)}</span>
          <select class="status-select" aria-label="Change status">
            ${['Not Started','In Progress','Submitted','Graded'].map(s =>
              `<option${s === a.status ? ' selected' : ''}>${s}</option>`).join('')}
          </select>
          <button class="status-save">Save</button>
        </div>
      </td>
    </tr>`;
  }).join('');

  // Status chip → edit mode on click
  tbody.querySelectorAll('.status-chip').forEach(chip => {
    chip.style.cursor = 'pointer';
    chip.addEventListener('click', () => {
      chip.closest('.status-wrap').classList.toggle('status-editing');
    });
  });

  // Save button
  tbody.querySelectorAll('.status-save').forEach(btn => {
    btn.addEventListener('click', async () => {
      const wrap = btn.closest('.status-wrap');
      const row = btn.closest('tr');
      const id = row.dataset.id;
      const sel = wrap.querySelector('.status-select');
      const newStatus = sel.value;
      try {
        await put(`/api/assignments/${encodeURIComponent(id)}`, { status: newStatus });
        toast('Status updated');
        const a = allDeadlines.find(x => x.id === id);
        if (a) a.status = newStatus;
        renderDeadlines();
      } catch (e) {
        if (e.message !== 'Unauthorized') toast('Failed to update', 'fail');
      }
    });
  });

  // Break down → generate study tasks for an assignment
  tbody.querySelectorAll('.btn-breakdown').forEach(btn => {
    btn.addEventListener('click', async () => {
      const token = getToken();
      if (!token) {
        toast('Save your write token in the Log task drawer first', 'fail');
        return;
      }
      btn.textContent = 'Generating…';
      btn.disabled = true;
      try {
        const r = await fetch(`/api/assignments/${encodeURIComponent(btn.dataset.asn)}/generate-tasks`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || r.status);
        btn.textContent = `✓ ${d.count} tasks`;
        toast(`${d.count} tasks generated`);
      } catch (e) {
        btn.textContent = 'Break down →';
        btn.disabled = false;
        toast(`Task generation failed: ${e.message}`, 'fail');
      }
    });
  });
}

// ── COURSES ────────────────────────────────────────────────────────────────
let courseData = [];
let asnData = [];
let okrData = [];

async function loadCourses() {
  const [courses, asns, okrs] = await Promise.all([
    get('/api/courses').catch(() => ({ courses: [] })),
    get('/api/assignments').catch(() => ({ assignments: [] })),
    get('/api/okrs').catch(() => ({ okrs: [] })),
  ]);
  courseData = courses.courses || [];
  asnData = asns.assignments || [];
  okrData = okrs.okrs || [];
  renderCourses();
}

function renderCourses() {
  const grid = document.getElementById('course-grid');
  if (!courseData.length) {
    grid.innerHTML = `<div class="empty"><div class="empty-icon">📚</div>No courses found.<br>Seed courses via the D1 dashboard or MCP tool.</div>`;
    return;
  }
  grid.innerHTML = courseData.map(course => {
    const myAsns = asnData.filter(a => a.course_id === course.id);
    const done = myAsns.filter(a => ['Submitted','Graded'].includes(a.status)).length;
    const pct = myAsns.length ? Math.round((done / myAsns.length) * 100) : 0;
    const okr = okrData.find(o => o.id === course.okr_id);

    return `<div class="course-card" id="card-${esc(course.id)}">
      <div class="course-name">${esc(course.name)}</div>
      <div class="course-meta">${esc(course.term)} · <span class="mono">${esc(course.id)}</span>${course.instructor ? ` · ${esc(course.instructor)}` : ''}</div>
      ${okr ? `<div style="font-size:11.5px;color:var(--ink-low);margin-bottom:8px;">OKR: ${esc(okr.objective)}</div>` : ''}
      <div class="course-prog-label">
        <span>Assignments</span>
        <span>${done} / ${myAsns.length}</span>
      </div>
      <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
      <div class="course-asn-list">
        ${myAsns.length ? myAsns.map(a => `
          <div class="course-asn-item">
            ${statusChip(a.status)}
            <span class="course-asn-title">${esc(a.title)}</span>
            <span class="course-asn-due">${fmt(a.due_date)}</span>
          </div>`).join('') : `<div style="font-size:12px;color:var(--ink-low);padding:6px 0;">No assignments yet.</div>`}
      </div>
      <button class="btn-add-asn" data-course="${esc(course.id)}" data-okr="${esc(course.okr_id)}">+ Add assignment</button>
      <button class="btn-import-syllabus" data-course="${esc(course.id)}" data-name="${esc(course.name)}">📄 Import syllabus</button>
      <div class="add-asn-form" id="form-${esc(course.id)}">
        <div class="form-grid">
          <div class="form-group">
            <label class="form-label">ID</label>
            <input class="form-input asn-id" placeholder="e.g. SCI133-A1" />
          </div>
          <div class="form-group">
            <label class="form-label">Title</label>
            <input class="form-input asn-title" placeholder="Lab Report #1" />
          </div>
          <div class="form-group">
            <label class="form-label">Due date</label>
            <input class="form-input asn-due" type="date" />
          </div>
          <div class="form-group">
            <label class="form-label">Type</label>
            <select class="form-select asn-type">
              <option>Project</option><option>Essay</option><option>Exam</option>
              <option>Reading</option><option>Code</option><option>Presentation</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">Weight %</label>
            <input class="form-input asn-weight" type="number" min="0" max="100" placeholder="20" />
          </div>
        </div>
        <div class="form-actions">
          <button class="btn-save asn-save" data-course="${esc(course.id)}" data-okr="${esc(course.okr_id)}">Save</button>
          <button class="btn-cancel asn-cancel" data-course="${esc(course.id)}">Cancel</button>
        </div>
      </div>
    </div>`;
  }).join('');

  // Import syllabus
  grid.querySelectorAll('.btn-import-syllabus').forEach(btn => {
    btn.addEventListener('click', () => openSyllabusModal(btn.dataset.course, btn.dataset.name));
  });

  // Add assignment toggle
  grid.querySelectorAll('.btn-add-asn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.getElementById('form-' + btn.dataset.course).classList.add('open');
    });
  });

  // Cancel
  grid.querySelectorAll('.asn-cancel').forEach(btn => {
    btn.addEventListener('click', () => {
      document.getElementById('form-' + btn.dataset.course).classList.remove('open');
    });
  });

  // Save assignment
  grid.querySelectorAll('.asn-save').forEach(btn => {
    btn.addEventListener('click', async () => {
      const form = document.getElementById('form-' + btn.dataset.course);
      const id     = form.querySelector('.asn-id').value.trim();
      const title  = form.querySelector('.asn-title').value.trim();
      const due    = form.querySelector('.asn-due').value;
      const type   = form.querySelector('.asn-type').value;
      const weight = parseFloat(form.querySelector('.asn-weight').value) || 0;
      if (!id || !title || !due) { toast('ID, title, and due date are required', 'fail'); return; }
      try {
        const res = await post('/api/assignments', {
          id, course_id: btn.dataset.course, okr_id: btn.dataset.okr,
          title, due_date: due, deliverable_type: type, weight_pct: weight,
        });
        if (res.error) { toast(res.error, 'fail'); return; }
        toast('Assignment added');
        form.classList.remove('open');
        const { assignments } = await get('/api/assignments').catch(() => ({ assignments: asnData }));
        asnData = assignments || asnData;
        renderCourses();
      } catch (e) {
        if (e.message !== 'Unauthorized') toast('Failed to save', 'fail');
      }
    });
  });
}

// ── OKR PROGRESS ──────────────────────────────────────────────────────────
async function loadProgress() {
  const [prog, asns] = await Promise.all([
    get('/api/progress').catch(() => ({ progress: [] })),
    get('/api/assignments').catch(() => ({ assignments: [] })),
  ]);
  renderProgress(prog.progress || [], asns.assignments || []);
}

function renderProgress(rows, assignments = []) {
  const el = document.getElementById('progress-list');
  if (!rows.length) {
    el.innerHTML = `<div class="empty"><div class="empty-icon">🎯</div>No OKRs found.</div>`;
    return;
  }
  el.innerHTML = rows.map(r => {
    const pct = r.task_progress_pct || 0;
    const asnFrac = r.total_assignments
      ? `${r.completed_assignments || 0}/${r.total_assignments}`
      : '—';
    const taskFrac = r.total_micro_tasks
      ? `${r.completed_micro_tasks || 0}/${r.total_micro_tasks}`
      : '—';
    const myAsns = assignments.filter(a => a.okr_id === r.okr_id)
      .sort((a, b) => (a.due_date || '').localeCompare(b.due_date || ''));
    const asnListHtml = myAsns.length
      ? myAsns.map(a => `
          <div class="course-asn-item">
            ${statusChip(a.status)}
            <span class="course-asn-title">${esc(a.title)}</span>
            ${a.due_date ? `<span class="course-asn-due">${fmt(a.due_date)}</span>` : ''}
            ${a.weight_pct ? `<span class="course-asn-due">${a.weight_pct}%</span>` : ''}
          </div>`).join('')
      : `<div style="font-size:12px;color:var(--ink-low);padding:6px 0;">No assignments yet — import a syllabus or add one from the Courses tab.</div>`;
    return `<div class="okr-row">
      <div class="okr-row-header">
        <div>
          <div class="okr-objective">${esc(r.objective)}</div>
          <div class="okr-kr">${esc(r.key_result)}</div>
        </div>
        <button class="btn-log" data-okr="${esc(r.okr_id)}">Log task</button>
      </div>
      <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
      <div class="okr-stats">
        <span><strong>${pct}%</strong> task completion</span>
        <span>Assignments: <strong>${asnFrac}</strong></span>
        <span>Tasks: <strong>${taskFrac}</strong></span>
        ${r.target_date ? `<span>Target: <strong class="mono">${fmt(r.target_date)}</strong></span>` : ''}
        ${r.milestone_status ? statusChip(r.milestone_status) : ''}
      </div>
      <div class="course-asn-list">${asnListHtml}</div>
    </div>`;
  }).join('');

  el.querySelectorAll('.btn-log').forEach(btn => {
    btn.addEventListener('click', () => {
      const okrSel = document.getElementById('log-okr');
      if (okrSel) { okrSel.value = btn.dataset.okr; }
      openLogDrawer();
    });
  });
}

// ── HISTORY ────────────────────────────────────────────────────────────────
async function loadHistory() {
  const input = document.getElementById('history-date');
  if (!input.value) input.value = today();
  const data = await get(`/api/tasks?date=${input.value}&limit=100`).catch(() => ({ tasks: [] }));
  renderHistory(data.tasks || [], input.value);
}

function renderHistory(tasks, date) {
  const el = document.getElementById('history-list');
  if (!tasks.length) {
    el.innerHTML = `<div class="empty"><div class="empty-icon">📅</div>Nothing logged on ${fmt(date)}.</div>`;
    return;
  }
  // Group by OKR
  const byOkr = {};
  tasks.forEach(t => {
    const key = t.okr_id;
    if (!byOkr[key]) byOkr[key] = { label: t.key_result || t.okr_id, tasks: [] };
    byOkr[key].tasks.push(t);
  });
  el.innerHTML = Object.entries(byOkr).map(([okrId, group]) => `
    <div class="okr-row">
      <div style="font-size:12px;color:var(--ink-low);margin-bottom:8px;font-family:'JetBrains Mono',monospace;">${esc(okrId)}</div>
      <div class="okr-kr" style="margin-bottom:10px;">${esc(group.label)}</div>
      ${group.tasks.map(t => `
        <div class="task-row">
          <div class="task-time">${t.time_spent || '—'}</div>
          <div class="task-body">
            <div class="task-desc">${esc(t.description)}</div>
            ${t.assignment_id ? `<div class="task-okr"><span class="task-asn"># ${esc(t.assignment_id)}</span></div>` : ''}
          </div>
          <span class="chip ${t.status === 'Done' ? 'chip-graded' : 'chip-prog'}">${esc(t.status || 'Done')}</span>
        </div>`).join('')}
    </div>`).join('');
}

// ── LOG DRAWER ─────────────────────────────────────────────────────────────
let logDrawerOpen = false;
let okrCache = [];
let asnCache = [];

function openLogDrawer() {
  logDrawerOpen = true;
  document.getElementById('log-drawer').classList.add('open');
  checkTokenPrompt();
}

function closeLogDrawer() {
  logDrawerOpen = false;
  document.getElementById('log-drawer').classList.remove('open');
}

function checkTokenPrompt() {
  const prompt = document.getElementById('token-prompt');
  if (!getToken()) prompt.classList.add('visible');
  else prompt.classList.remove('visible');
}

function showTokenPrompt() {
  document.getElementById('token-prompt').classList.add('visible');
  openLogDrawer();
}

async function populateLogSelects() {
  if (!okrCache.length) {
    const data = await get('/api/okrs').catch(() => ({ okrs: [] }));
    okrCache = data.okrs || [];
  }
  const okrSel = document.getElementById('log-okr');
  const current = okrSel.value;
  okrSel.innerHTML = `<option value="">Select OKR…</option>` +
    okrCache.map(o => `<option value="${esc(o.id)}"${o.id === current ? ' selected' : ''}>${esc(o.id)} — ${esc(o.objective)}</option>`).join('');

  // Populate assignment select based on chosen OKR
  await refreshAsnSelect(current);
}

async function refreshAsnSelect(okrId) {
  if (!asnCache.length) {
    const data = await get('/api/assignments').catch(() => ({ assignments: [] }));
    asnCache = data.assignments || [];
  }
  const asnSel = document.getElementById('log-asn');
  const filtered = okrId ? asnCache.filter(a => a.okr_id === okrId) : asnCache;
  asnSel.innerHTML = `<option value="">None</option>` +
    filtered.map(a => `<option value="${esc(a.id)}">${esc(a.title)} (${esc(a.course_name)})</option>`).join('');
}

// ── SYLLABUS IMPORT MODAL ──────────────────────────────────────────────────
let syllabusTargetCourse = null;
let parsedAssignments = [];
let selectedPdfBase64 = null;   // set when a PDF is chosen via the upload zone

function openSyllabusModal(courseId, courseName) {
  syllabusTargetCourse = courseId;
  selectedPdfBase64 = null;
  document.getElementById('modal-title').textContent = `Import syllabus — ${courseName}`;
  document.getElementById('syllabus-text').value = '';
  document.getElementById('syllabus-file').value = '';
  setUploadZoneState('idle', 'Click to upload PDF or DOCX');
  showModalStep(1);
  document.getElementById('syllabus-backdrop').removeAttribute('hidden');
}

function closeSyllabusModal() {
  document.getElementById('syllabus-backdrop').setAttribute('hidden', '');
  syllabusTargetCourse = null;
  parsedAssignments = [];
  selectedPdfBase64 = null;
}

function showModalStep(step) {
  document.getElementById('modal-step1').hidden = step !== 1;
  document.getElementById('modal-step2').hidden = step !== 2;
  document.getElementById('modal-loading').hidden = step !== 'loading';
}

function setUploadZoneState(state, label) {
  const zone = document.getElementById('upload-zone');
  zone.classList.toggle('has-file', state === 'done');
  document.getElementById('upload-label').textContent = label;
}

function initUploadZone() {
  const zone  = document.getElementById('upload-zone');
  const input = document.getElementById('syllabus-file');

  input.addEventListener('change', () => {
    const file = input.files[0];
    if (file) loadPdfFile(file);
  });

  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('drag-over');
    const file = e.dataTransfer?.files[0];
    const ok = file && (file.type === 'application/pdf' || file.name.match(/\.docx?$/i));
    if (ok) loadPdfFile(file);
    else toast('Please drop a PDF or DOCX file', 'fail');
  });
}

function loadPdfFile(file) {
  const isDocx = file.name.match(/\.docx?$/i);
  if (isDocx) {
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        if (!window.mammoth) throw new Error('mammoth not loaded');
        const result = await window.mammoth.extractRawText({ arrayBuffer: reader.result });
        if (!result.value || result.value.trim().length < 20) {
          toast('Could not extract text from this file — try a PDF instead', 'fail');
          return;
        }
        selectedPdfBase64 = null;
        document.getElementById('syllabus-text').value = result.value;
        setUploadZoneState('done', `📄 ${file.name}`);
        // Auto-parse once text is ready
        parseSyllabus();
      } catch (e) {
        toast(`Could not read DOCX: ${e.message}`, 'fail');
      }
    };
    reader.onerror = () => toast('Could not read file', 'fail');
    reader.readAsArrayBuffer(file);
  } else {
    const reader = new FileReader();
    reader.onload = () => {
      const b64 = reader.result.split(',')[1];
      selectedPdfBase64 = b64;
      setUploadZoneState('done', `📄 ${file.name}`);
      document.getElementById('syllabus-text').value = '';
      // Auto-parse once file is ready
      parseSyllabus();
    };
    reader.onerror = () => toast('Could not read file', 'fail');
    reader.readAsDataURL(file);
  }
}

async function parseSyllabus() {

  const text = document.getElementById('syllabus-text').value.trim();
  const hasPdf = !!selectedPdfBase64;

  if (!hasPdf && text.length < 20) {
    toast('Upload a PDF or paste some syllabus text first', 'fail');
    return;
  }
  if (!hasPdf && text.length > 40000) toast('Syllabus is long — only the first ~40,000 characters will be parsed', 'fail');

  showModalStep('loading');

  const payload = hasPdf
    ? { file_base64: selectedPdfBase64, file_type: 'application/pdf' }
    : { text };

  try {
    const res = await post(`/api/courses/${encodeURIComponent(syllabusTargetCourse)}/parse-syllabus`, payload);
    if (res.error) { toast(res.error, 'fail'); showModalStep(1); return; }

    parsedAssignments = res.assignments || [];
    if (!parsedAssignments.length) {
      toast('No assignments found — try pasting more of the syllabus', 'fail');
      showModalStep(1);
      return;
    }

    // Build preview table
    document.getElementById('modal-preview-hint').textContent =
      `Claude found ${parsedAssignments.length} assignment${parsedAssignments.length === 1 ? '' : 's'}. Uncheck any you don't want to import.`;

    const tbody = document.getElementById('preview-body');
    tbody.innerHTML = parsedAssignments.map((a, i) => {
      const noDate = !a.due_date;
      const dateCell = noDate
        ? '<span style="color:var(--ink-low);font-size:10px;">No date</span>'
        : `<span class="mono" style="font-size:11.5px;">${esc(a.due_date)}</span>`;
      return `
      <tr>
        <td><input type="checkbox" class="preview-check" data-idx="${i}" checked></td>
        <td>${esc(a.title)}<br><span style="font-size:11px;color:var(--ink-low);font-family:'JetBrains Mono',monospace;">${esc(a.id)}</span></td>
        <td><span class="chip chip-type">${esc(a.deliverable_type)}</span></td>
        <td>${dateCell}</td>
        <td class="mono" style="font-size:11.5px;">${a.weight_pct ? esc(String(a.weight_pct)) + '%' : '—'}</td>
      </tr>`;
    }).join('');

    // Select-all toggle
    document.getElementById('select-all').addEventListener('change', e => {
      document.querySelectorAll('.preview-check').forEach(cb => { cb.checked = e.target.checked; });
      updateImportButton();
    });

    updateImportButton();
    tbody.querySelectorAll('.preview-check').forEach(cb => {
      cb.addEventListener('change', updateImportButton);
    });

    showModalStep(2);
  } catch (e) {
    if (e.message !== 'Unauthorized') toast('Parse failed — check your write token', 'fail');
    showModalStep(1);
  }
}

function updateImportButton() {
  const n = document.querySelectorAll('.preview-check:checked').length;
  document.getElementById('modal-import').textContent = `Import ${n} assignment${n === 1 ? '' : 's'}`;
  document.getElementById('modal-import').disabled = n === 0;
}

async function confirmImport() {
  const checked = [...document.querySelectorAll('.preview-check:checked')].map(cb => {
    return parsedAssignments[parseInt(cb.dataset.idx)];
  });
  if (!checked.length) return;

  document.getElementById('modal-import').disabled = true;
  document.getElementById('modal-import').textContent = 'Importing…';

  let ok = 0;
  const errors = [];
  for (const a of checked) {
    try {
      const res = await post('/api/assignments', {
        id: a.id, course_id: a.course_id, okr_id: a.okr_id,
        title: a.title, due_date: a.due_date, deliverable_type: a.deliverable_type,
        weight_pct: a.weight_pct, notes: a.notes,
      });
      if (res.error) errors.push(a.title);
      else ok++;
    } catch { errors.push(a.title); }
  }

  closeSyllabusModal();
  if (ok) toast(`Imported ${ok} assignment${ok === 1 ? '' : 's'} ✓`);
  if (errors.length) toast(`${errors.length} failed: ${errors.slice(0, 2).join(', ')}`, 'fail');

  // Refresh courses view and bust the log-drawer assignment cache
  const { assignments } = await get('/api/assignments').catch(() => ({ assignments: asnData }));
  asnData = assignments || asnData;
  asnCache = [...asnData];
  renderCourses();
}

// ── INIT ───────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {

  // Tabs
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // Log drawer toggle
  document.getElementById('log-toggle').addEventListener('click', openLogDrawer);
  document.getElementById('log-close').addEventListener('click', closeLogDrawer);

  // Token save
  document.getElementById('token-save').addEventListener('click', () => {
    const v = document.getElementById('token-input').value.trim();
    if (v) {
      setToken(v);
      document.getElementById('token-prompt').classList.remove('visible');
      document.getElementById('token-input').value = '';
      toast('Token saved');
    }
  });

  // OKR select → refresh assignments
  document.getElementById('log-okr').addEventListener('change', e => {
    refreshAsnSelect(e.target.value);
  });

  // Populate selects when drawer opens
  document.getElementById('log-toggle').addEventListener('click', populateLogSelects);

  // Log submit
  document.getElementById('log-submit').addEventListener('click', async () => {
    const okr_id     = document.getElementById('log-okr').value;
    const description = document.getElementById('log-desc').value.trim();
    const time_spent  = document.getElementById('log-time').value.trim() || null;
    const assignment_id = document.getElementById('log-asn').value || null;
    const notes       = document.getElementById('log-notes').value.trim() || null;

    if (!okr_id)      { toast('Select an OKR', 'fail'); return; }
    if (!description) { toast('Description is required', 'fail'); return; }

    try {
      const res = await post('/api/tasks', {
        okr_id, description, time_spent, assignment_id, notes,
        source_repo: 'college-tracker', status: 'Done',
      });
      if (res.error) { toast(res.error, 'fail'); return; }
      toast('Session logged ✓');
      // Clear form
      document.getElementById('log-desc').value = '';
      document.getElementById('log-time').value = '';
      document.getElementById('log-notes').value = '';
      document.getElementById('log-asn').value = '';
      asnCache = [];
      // Refresh active view if it shows today's tasks
      if (currentTab === 'today') loadToday();
      if (currentTab === 'progress') loadProgress();
      if (currentTab === 'history') loadHistory();
    } catch (e) {
      if (e.message !== 'Unauthorized') toast('Failed to log task', 'fail');
    }
  });

  // Syllabus modal
  initUploadZone();
  document.getElementById('modal-close').addEventListener('click', closeSyllabusModal);
  document.getElementById('modal-parse').addEventListener('click', parseSyllabus);
  document.getElementById('modal-import').addEventListener('click', confirmImport);
  document.getElementById('modal-back').addEventListener('click', () => showModalStep(1));
  document.getElementById('syllabus-backdrop').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeSyllabusModal();
  });

  // Deadlines filters
  document.getElementById('dl-course-filter').addEventListener('change', renderDeadlines);
  document.getElementById('dl-status-filter').addEventListener('change', renderDeadlines);
  document.getElementById('dl-days-filter').addEventListener('change', loadDeadlines);

  // History datepicker
  document.getElementById('history-date').addEventListener('change', loadHistory);
  document.getElementById('history-date').value = today();

  // Initial load
  switchTab('today');
});

// ── Escape helper ──────────────────────────────────────────────────────────
function esc(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
