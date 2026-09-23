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
  tasks:     { el: 'view-tasks',     load: loadTasks },
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

/** 150 → "2h 30m", 45 → "45m". */
function fmtMinutes(mins) {
  const h = Math.floor(mins / 60), m = Math.round(mins % 60);
  return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
}

// ── MICRO-TASK BOARD ───────────────────────────────────────────────────────
// All micro-tasks load at once and filters apply locally, so a drag in a
// filtered view can be merged back into the full column order.
const MT_STATUSES = ['To Do', 'In Progress', 'Done'];
let mtTasks = [];
let mtProgress = null;
let mtSortables = [];
let mtSaving = false;
let mtPicks = []; // Claude's suggestions, highlighted until the next load or drag

async function loadTasks() {
  mtPicks = [];
  renderSuggestions();
  const data = await get('/api/microtasks').catch(() => null);
  if (!data) {
    document.getElementById('mt-progress').innerHTML = `<div class="empty">Couldn't load micro-tasks.</div>`;
    return;
  }
  mtTasks = data.tasks || [];
  mtProgress = data.progress;
  populateTaskFilters();
  renderTasks();
}

function mtVisible(t) {
  const course = document.getElementById('mt-course-filter').value;
  const asn = document.getElementById('mt-asn-filter').value;
  return (!course || t.course_id === course) && (!asn || t.assignment_id === asn);
}

function populateTaskFilters() {
  const courseSel = document.getElementById('mt-course-filter');
  const asnSel = document.getElementById('mt-asn-filter');
  const course = courseSel.value, asn = asnSel.value;
  const courses = new Map();
  mtTasks.forEach(t => { if (t.course_id) courses.set(t.course_id, t.course_name || t.course_id); });
  courseSel.innerHTML = '<option value="">All courses</option>' +
    [...courses].map(([id, name]) => `<option value="${esc(id)}"${id === course ? ' selected' : ''}>${esc(name)}</option>`).join('');
  const asns = new Map();
  mtTasks.forEach(t => {
    if (t.assignment_id && (!courseSel.value || t.course_id === courseSel.value)) asns.set(t.assignment_id, t.assignment_title || t.assignment_id);
  });
  asnSel.innerHTML = '<option value="">All assignments</option>' +
    [...asns].map(([id, title]) => `<option value="${esc(id)}"${id === asn ? ' selected' : ''}>${esc(title)}</option>`).join('');
}

function ago(iso) {
  if (!iso) return '';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

function renderTaskCard(t) {
  const cd = t.due_date ? countdown(t.due_date) : null;
  const options = MT_STATUSES.map(s => `<option${s === t.status ? ' selected' : ''}>${s}</option>`).join('');
  const rank = mtPicks.findIndex(p => p.task_id === t.id);
  return `<div class="mt-card${t.status === 'Done' ? ' mt-done' : ''}${rank >= 0 ? ` mt-pick mt-pick-${rank + 1}` : ''}" data-id="${t.id}">
    <div class="mt-card-top">
      <span class="mt-desc">${rank >= 0 ? `<span class="mt-pick-badge">#${rank + 1}</span> ` : ''}${esc(t.description)}</span>
      <select class="mt-move" aria-label="Move task">${options}</select>
    </div>
    <div class="mt-meta">
      ${t.course_name ? `<span class="chip chip-course">${esc(t.course_name)}</span>` : ''}
      ${t.assignment_title ? `<span class="mt-asn">${esc(t.assignment_title)}</span>` : ''}
      ${t.canvas_url ? `<a class="chip chip-canvas" href="${esc(t.canvas_url)}" target="_blank" rel="noopener" title="Open in Canvas">Canvas ↗</a>` : ''}
    </div>
    ${t.link_url ? `<a class="mt-task-link" href="${esc(t.link_url)}" target="_blank" rel="noopener" title="${esc(t.link_url)}">▶ ${esc(t.link_label || 'Open link')} ↗</a>` : ''}
    ${t.notes && t.status !== 'Done' ? `<div class="mt-task-notes" title="${esc(t.notes)}">${esc(t.notes)}</div>` : ''}
    <div class="mt-foot">
      ${cd && t.status !== 'Done' ? `<span class="mt-due ${cd.cls}">${cd.label}</span>` : ''}
      ${t.time_spent ? `<span>⏱ ${esc(t.time_spent)}</span>` : ''}
      ${t.last_moved_at ? `<span class="mt-moved">moved ${ago(t.last_moved_at)}</span>` : ''}
    </div>
    ${rank >= 0 ? `<div class="mt-suggest-links mt-card-links">${pickCanvasLinks(t) ||
      `<span class="mt-no-canvas">Not linked to Canvas · <a href="manage-courses.html">link this course</a></span>`}</div>` : ''}
  </div>`;
}

function renderTaskProgress() {
  const move = mtProgress?.movement;
  const mvEl = document.getElementById('mt-movement');
  if (move) {
    const max = Math.max(1, ...move.done_by_day.map(d => d.done));
    mvEl.innerHTML = `
      <div class="mt-stats">
        <div><span class="mt-stat">${move.moved_today}</span> moved today</div>
        <div><span class="mt-stat">${move.done_this_week}</span> done this week</div>
        ${move.remaining_due_this_week_min ? `<div><span class="mt-stat">~${fmtMinutes(move.remaining_due_this_week_min)}</span> of work due this week</div>` : ''}
      </div>
      <div class="mt-spark" role="img" aria-label="Micro-tasks completed per day, last 14 days">
        ${move.done_by_day.map(d => `<div class="mt-bar" title="${esc(d.date)}: ${d.done} done"><div style="height:${Math.round((d.done / max) * 100)}%"></div></div>`).join('')}
      </div>`;
  }
  const course = document.getElementById('mt-course-filter').value;
  const asn = document.getElementById('mt-asn-filter').value;
  const rows = (mtProgress?.assignments || []).filter(a => (!course || a.course_id === course) && (!asn || a.id === asn));
  document.getElementById('mt-progress').innerHTML = rows.map(a => {
    const donePct = a.total ? (a.done / a.total) * 100 : 0;
    const progPct = a.total ? (a.in_progress / a.total) * 100 : 0;
    const cd = a.due_date ? countdown(a.due_date) : null;
    return `<div class="mt-prog-row">
      <div class="mt-prog-head">
        <span class="mt-prog-title">${esc(a.title)}${a.canvas_url ? ` <a class="chip chip-canvas" href="${esc(a.canvas_url)}" target="_blank" rel="noopener">Canvas ↗</a>` : ''}</span>
        <span class="mt-prog-count">${a.est_remaining_min ? `~${fmtMinutes(a.est_remaining_min)} left · ` : ''}${a.done}/${a.total} done${cd ? ` · <span class="mt-due ${cd.cls}">${cd.label}</span>` : ''}</span>
      </div>
      <div class="mt-prog-bar"><div class="mt-prog-done" style="width:${donePct}%"></div><div class="mt-prog-doing" style="width:${progPct}%"></div></div>
    </div>`;
  }).join('');
}

function renderTasks() {
  renderTaskProgress();
  document.querySelectorAll('#view-tasks .mt-col').forEach(col => {
    const status = col.dataset.status;
    const items = mtTasks.filter(t => t.status === status && mtVisible(t));
    col.querySelector('.mt-count').textContent = items.length;
    col.querySelector('.mt-list').innerHTML = items.length
      ? items.map(renderTaskCard).join('')
      : `<div class="mt-empty">${status === 'To Do' ? 'Nothing queued. Use “Break down →” on an assignment.' : 'Drop tasks here'}</div>`;
  });
  document.querySelectorAll('#view-tasks .mt-card .mt-card-links').forEach(bindCanvasLinkers);
  document.querySelectorAll('#view-tasks .mt-move').forEach(sel => {
    sel.addEventListener('change', () => {
      const id = Number(sel.closest('.mt-card').dataset.id);
      moveTaskToTop(id, sel.value);
    });
  });
  initTaskSortables();
}

/** Where a pick should take the student in Canvas: the chosen module file, the assignment, else the course. */
function pickCanvasLinks(t) {
  if (!t) return '';
  const links = [];
  if (t.canvas_material_url) {
    links.push(`<a class="mt-open-canvas" href="${esc(t.canvas_material_url)}" target="_blank" rel="noopener" title="Open the linked Canvas material">📄 ${esc(t.canvas_material_title || 'Material')} ↗</a>`);
    if (t.canvas_material_download_url) {
      links.push(`<a class="mt-open-canvas secondary" href="${esc(t.canvas_material_download_url)}" target="_blank" rel="noopener" title="Download from Canvas (you must be logged in to Canvas)">⬇ Download</a>`);
    }
    if (t.canvas_material_download_url && t.assignment_id) {
      links.push(`<button type="button" class="mt-link-btn mt-breakdown-btn" data-asn="${esc(t.assignment_id)}" data-file="${esc(t.canvas_material_title || '')}"
        title="Have Claude turn this file into concrete steps you can review">✨ Break down this file</button>`);
    }
  }
  if (t.canvas_url) {
    links.push(`<a class="mt-open-canvas${t.canvas_material_url ? ' secondary' : ''}" href="${esc(t.canvas_url)}" target="_blank" rel="noopener">Open in Canvas ↗</a>`);
  }
  if (!t.canvas_course_url) return links.join(' ');
  if (!t.canvas_material_url && !t.canvas_url) {
    // Many courses post work as files in Modules rather than as Canvas assignments.
    const modules = `${String(t.canvas_course_url).replace(/\/+$/, '')}/modules`;
    links.push(`<a class="mt-open-canvas secondary" href="${esc(modules)}" target="_blank" rel="noopener">Course modules ↗</a>`);
  }
  if (t.assignment_id) {
    const data = `data-asn="${esc(t.assignment_id)}" data-ccid="${esc(t.canvas_course_id)}"`;
    links.push(`<button type="button" class="mt-link-btn" data-kind="material" ${data}
      title="Choose the file or page in Canvas Modules for this assignment">${t.canvas_material_url ? 'Change file…' : 'Link module file…'}</button>`);
    if (!t.canvas_url) {
      links.push(`<button type="button" class="mt-link-btn" data-kind="assignment" ${data}
        title="This assignment isn't linked to its Canvas assignment yet">Link to Canvas assignment…</button>`);
    }
    links.push('<span class="mt-link-slot"></span>');
  }
  return links.join(' ');
}

function bindCanvasLinkers(root) {
  root.querySelectorAll('.mt-link-btn').forEach(btn => btn.addEventListener('click', () =>
    (btn.classList.contains('mt-breakdown-btn') ? openBreakdown(btn.dataset.asn, btn.dataset.file)
      : btn.dataset.kind === 'material' ? showMaterialLinker(btn) : showCanvasLinker(btn))));
}

/** Reload the board after a link change without losing Claude's picks. */
async function reloadKeepingPicks() {
  const keep = mtPicks;
  await loadTasks();
  mtPicks = keep;
  renderTasks();
  renderSuggestions();
}

/** Let the student pick the Canvas module item (usually a file) that holds this assignment's material. */
async function showMaterialLinker(btn) {
  const slot = btn.parentElement.querySelector('.mt-link-slot');
  btn.disabled = true;
  let modules;
  try {
    const res = await get(`/api/canvas/courses/${encodeURIComponent(btn.dataset.ccid)}/modules`);
    if (res.error) throw new Error(res.error);
    modules = (res.modules || []).filter(m => m.items.length);
  } catch (e) {
    btn.disabled = false;
    if (e.message !== 'Unauthorized') toast(`Couldn't load Canvas modules: ${e.message}`, 'fail');
    return;
  }
  if (!modules.length) { btn.disabled = false; toast('This Canvas course has no module items', 'fail'); return; }
  slot.innerHTML = `<select class="mt-link-select" aria-label="Canvas module item">
      ${modules.map(m => `<optgroup label="${esc(m.name)}">${m.items.map(i =>
        `<option value="${esc(m.id)}:${esc(i.id)}">${i.type === 'File' ? '📄 ' : ''}${esc(i.title)}</option>`).join('')}</optgroup>`).join('')}
    </select> <button type="button" class="mt-link-save">Use this file</button>`;
  slot.querySelector('.mt-link-save').addEventListener('click', async () => {
    const [moduleId, itemId] = slot.querySelector('.mt-link-select').value.split(':');
    try {
      const res = await post('/api/canvas/materials', {
        assignment_id: btn.dataset.asn, canvas_course_id: btn.dataset.ccid, module_id: moduleId, item_id: itemId,
      });
      if (res.error) throw new Error(res.error);
      toast(`Linked “${res.title}” ✓`);
      await reloadKeepingPicks();
    } catch (e) {
      if (e.message !== 'Unauthorized') toast(`Couldn't link: ${e.message}`, 'fail');
    }
  });
}

function renderSuggestions() {
  const el = document.getElementById('mt-suggest');
  if (!el) return;
  if (!mtPicks.length) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;
  el.innerHTML = `<div class="mt-suggest-head">Claude suggests</div><ol>${mtPicks.map(p => {
    const t = mtTasks.find(x => x.id === p.task_id);
    return `<li><strong>${esc(t ? t.description : `Task ${p.task_id}`)}</strong>${t && t.assignment_title ? ` <span class="mt-asn">${esc(t.assignment_title)}</span>` : ''}<div class="mt-suggest-reason">${esc(p.reason)}</div><div class="mt-suggest-links">${pickCanvasLinks(t)}</div></li>`;
  }).join('')}</ol>`;
  bindCanvasLinkers(el);
}

/** Let the student link an unlinked assignment to its Canvas assignment, then keep the picks. */
async function showCanvasLinker(btn) {
  const slot = btn.parentElement.querySelector('.mt-link-slot');
  btn.disabled = true;
  let list;
  try {
    const res = await get(`/api/canvas/assignments?canvas_course_id=${encodeURIComponent(btn.dataset.ccid)}`);
    if (res.error) throw new Error(res.error);
    list = (res.assignments || []).filter(a => !a.removed_at);
  } catch (e) {
    btn.disabled = false;
    if (e.message !== 'Unauthorized') toast(`Couldn't load Canvas assignments: ${e.message}`, 'fail');
    return;
  }
  if (!list.length) { btn.disabled = false; toast('No Canvas assignments synced for this course yet — run Sync now', 'fail'); return; }
  const task = mtTasks.find(t => t.assignment_id === btn.dataset.asn);
  slot.innerHTML = `<select class="mt-link-select" aria-label="Canvas assignment">
      ${list.map(a => `<option value="${esc(a.canvas_id)}"${task && a.due_date_local === task.due_date ? ' selected' : ''}>${esc(a.name)}${a.due_date_local ? ` — due ${fmt(a.due_date_local)}` : ''}</option>`).join('')}
    </select> <button type="button" class="mt-link-save">Link</button>`;
  slot.querySelector('.mt-link-save').addEventListener('click', async () => {
    const canvasId = slot.querySelector('.mt-link-select').value;
    try {
      const res = await post(`/api/canvas/assignments/${encodeURIComponent(canvasId)}/link`, { assignment_id: btn.dataset.asn });
      if (res.error) throw new Error(res.error);
      toast('Linked to Canvas ✓');
      await reloadKeepingPicks();
    } catch (e) {
      if (e.message !== 'Unauthorized') toast(`Couldn't link: ${e.message}`, 'fail');
    }
  });
}

// ── Break down from the linked Canvas file ──────────────────────────────────
let bdAssignment = null;
let bdRun = 0;

function parseDuration(text) {
  const str = String(text || '').trim().toLowerCase();
  let total = 0, matched = false;
  for (const m of str.matchAll(/(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours|m|min|mins|minute|minutes)?(?![a-z])/g)) {
    total += (m[2] || 'm').startsWith('h') ? Number(m[1]) * 60 : Number(m[1]);
    matched = true;
  }
  return matched ? Math.round(total) : null;
}

function closeBreakdown() {
  bdRun++;
  bdAssignment = null;
  document.getElementById('bd-backdrop').setAttribute('hidden', '');
}

function updateBreakdownTotal() {
  const rows = [...document.querySelectorAll('#bd-steps li')].filter(li => li.querySelector('.bd-keep').checked);
  const mins = rows.reduce((n, li) => n + (parseDuration(li.querySelector('.bd-time').value) || 0), 0);
  document.getElementById('bd-add').textContent = `Add ${rows.length} step${rows.length === 1 ? '' : 's'}`;
  document.getElementById('bd-add').disabled = !rows.length;
  document.getElementById('bd-total').textContent = mins ? `~${fmtMinutes(mins)} total` : '';
}

async function openBreakdown(assignmentId, fileTitle) {
  const run = ++bdRun;
  bdAssignment = assignmentId;
  document.getElementById('bd-file').textContent = fileTitle || 'the linked file';
  document.getElementById('bd-loading').hidden = false;
  document.getElementById('bd-review').hidden = true;
  document.getElementById('bd-backdrop').removeAttribute('hidden');
  let res;
  try {
    res = await api(`/api/assignments/${encodeURIComponent(assignmentId)}/breakdown-preview`, { method: 'POST', body: '{}' });
    if (res.error) throw new Error(res.error);
  } catch (e) {
    if (run !== bdRun) return;
    closeBreakdown();
    if (e.message !== 'Unauthorized') toast(`Couldn't break down the file: ${e.message}`, 'fail');
    return;
  }
  if (run !== bdRun) return; // closed or reopened meanwhile

  const src = document.getElementById('bd-source');
  src.textContent = res.source.title;
  src.href = res.source.html_url;
  const warn = document.getElementById('bd-warnings');
  warn.innerHTML = (res.warnings || []).map(w => `<li>⚠ ${esc(w)}</li>`).join('');
  warn.hidden = !(res.warnings || []).length;
  document.getElementById('bd-steps').innerHTML = res.steps.map((st, i) => `
    <li data-i="${i}">
      <input type="checkbox" class="bd-keep" checked aria-label="Keep step ${i + 1}">
      <div class="bd-step">
        <input class="bd-desc" value="${esc(st.description)}" maxlength="200" aria-label="Step ${i + 1}">
        <div class="bd-meta">
          <input class="bd-time" value="${esc(st.time_estimate || '')}" placeholder="time" size="7" aria-label="Time estimate">
          ${st.link_url ? `<a class="mt-task-link" href="${esc(st.link_url)}" target="_blank" rel="noopener" title="${esc(st.link_url)}">▶ ${esc(st.link_label || 'Link')} ↗</a>` : ''}
        </div>
        ${st.detail ? `<div class="bd-detail">${esc(st.detail)}</div>` : ''}
      </div>
    </li>`).join('');
  document.getElementById('bd-steps').dataset.steps = JSON.stringify(res.steps);
  const n = res.replaceable_todo || 0;
  document.getElementById('bd-replace-n').textContent = n;
  document.getElementById('bd-replace').checked = n > 0;
  document.getElementById('bd-replace-wrap').hidden = !n;
  document.getElementById('bd-loading').hidden = true;
  document.getElementById('bd-review').hidden = false;
  updateBreakdownTotal();
}

async function addBreakdownSteps() {
  const btn = document.getElementById('bd-add');
  const original = JSON.parse(document.getElementById('bd-steps').dataset.steps || '[]');
  const steps = [...document.querySelectorAll('#bd-steps li')]
    .filter(li => li.querySelector('.bd-keep').checked)
    .map(li => {
      const st = original[Number(li.dataset.i)] || {};
      return {
        description: li.querySelector('.bd-desc').value.trim() || st.description,
        time_spent: li.querySelector('.bd-time').value.trim() || null,
        link_url: st.link_url || null,
        link_label: st.link_label || null,
        notes: st.detail || null,
      };
    });
  if (!steps.length || !bdAssignment) return;
  const replace = !document.getElementById('bd-replace-wrap').hidden && document.getElementById('bd-replace').checked;
  btn.disabled = true;
  try {
    const res = await post(`/api/assignments/${encodeURIComponent(bdAssignment)}/tasks/bulk`, { steps, replace_todo: replace });
    if (res.error) throw new Error(res.error);
    closeBreakdown();
    toast(`Added ${res.created} step${res.created === 1 ? '' : 's'}${res.removed ? `, removed ${res.removed} old` : ''} ✓`);
    if (currentTab === 'tasks') await reloadKeepingPicks(); else if (currentTab === 'deadlines') loadDeadlines();
  } catch (e) {
    btn.disabled = false;
    if (e.message !== 'Unauthorized') toast(`Couldn't add steps: ${e.message}`, 'fail');
  }
}

async function suggestNextTask() {
  const btn = document.getElementById('mt-suggest-btn');
  btn.disabled = true;
  btn.textContent = 'Thinking…';
  try {
    const res = await api('/api/microtasks/suggest', { method: 'POST', body: '{}' });
    if (res.error) throw new Error(res.error);
    mtPicks = res.picks || [];
    if (!mtPicks.length) toast('Nothing open to suggest — add tasks with “Break down →”');
    renderTasks();
    renderSuggestions();
    const first = document.querySelector('#view-tasks .mt-pick-1');
    if (first) first.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } catch (e) {
    if (e.message !== 'Unauthorized') toast(`Couldn't get a suggestion: ${e.message}`, 'fail');
  } finally {
    btn.disabled = false;
    btn.textContent = '✨ What should I do next?';
  }
}

function initTaskSortables() {
  mtSortables.forEach(s => s.destroy());
  mtSortables = [];
  if (!window.Sortable) return; // status menus still work without drag-and-drop
  document.querySelectorAll('#view-tasks .mt-list').forEach(list => {
    mtSortables.push(window.Sortable.create(list, {
      group: 'microtasks',
      animation: 150,
      filter: '.mt-move, a, button, select, .mt-empty',
      preventOnFilter: false,
      delay: 150,
      delayOnTouchOnly: true,
      ghostClass: 'mt-ghost',
      onEnd: onTaskDrop,
    }));
  });
}

/** Full column order (all tasks, including ones hidden by filters). */
function mtColumnIds(status, exclude) {
  return mtTasks.filter(t => t.status === status && t.id !== exclude).map(t => t.id);
}

/** Merge the visible order after a drop back into the full column order. */
function mergeColumnOrder(fullBefore, domIds) {
  const visibleBefore = new Set(mtTasks.filter(t => mtVisible(t)).map(t => t.id));
  const domKnown = domIds.filter(id => fullBefore.includes(id));
  let k = 0;
  const result = fullBefore.map(id => (visibleBefore.has(id) ? domKnown[k++] : id));
  for (const id of domIds.filter(id => !fullBefore.includes(id))) {
    const prev = domIds[domIds.indexOf(id) - 1];
    if (prev === undefined) {
      const first = result.findIndex(x => domIds.includes(x));
      result.splice(first < 0 ? 0 : first, 0, id);
    } else {
      result.splice(result.indexOf(prev) + 1, 0, id);
    }
  }
  return result;
}

async function onTaskDrop(evt) {
  const id = Number(evt.item.dataset.id);
  const from = evt.from.closest('.mt-col').dataset.status;
  const to = evt.to.closest('.mt-col').dataset.status;
  if (from === to && evt.oldIndex === evt.newIndex) return;
  const domIds = [...evt.to.querySelectorAll('.mt-card')].map(el => Number(el.dataset.id));
  const target = mergeColumnOrder(mtColumnIds(to, from === to ? null : id), domIds);
  const updates = [{ status: to, ids: target }];
  if (from !== to) updates.push({ status: from, ids: mtColumnIds(from, id) });
  await saveTaskColumns(updates, from !== to && to === 'Done');
}

async function moveTaskToTop(id, status) {
  const task = mtTasks.find(t => t.id === id);
  if (!task || task.status === status) return;
  const updates = [
    { status, ids: [id, ...mtColumnIds(status, id)] },
    { status: task.status, ids: mtColumnIds(task.status, id) },
  ];
  await saveTaskColumns(updates, status === 'Done');
}

async function saveTaskColumns(updates, finished) {
  if (mtSaving) return;
  mtSaving = true;
  try {
    for (const u of updates) {
      if (!u.ids.length) continue;
      const res = await api('/api/microtasks/column', { method: 'PUT', body: JSON.stringify({ status: u.status, ordered_ids: u.ids }) });
      if (res.error) throw new Error(res.error);
    }
    if (finished) toast('Task done ✓');
  } catch (e) {
    if (e.message !== 'Unauthorized') toast(`Couldn't save: ${e.message}`, 'fail');
  } finally {
    mtSaving = false;
    await loadTasks();
  }
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

// Canvas-backed assignments link to Canvas; removed ones are flagged.
function canvasBadge(a) {
  if (a.source !== 'canvas') return '';
  if (a.canvas_state === 'removed') return `<span class="chip chip-canvas" title="No longer listed in Canvas">Canvas: removed</span>`;
  const link = a.canvas_url
    ? `<a class="chip chip-canvas" href="${esc(a.canvas_url)}" target="_blank" rel="noopener" title="Open in Canvas">Canvas ↗</a>`
    : `<span class="chip chip-canvas">Canvas</span>`;
  return link
    + (a.canvas_missing ? ` <span class="chip chip-missing" title="Canvas marks this missing">Missing</span>` : '')
    + (a.canvas_late ? ` <span class="chip chip-late" title="Canvas marks this late">Late</span>` : '');
}

/** Grade shown next to an assignment: Canvas grades are percents of points. */
function gradeLabel(a) {
  if (a.grade === null || a.grade === undefined || a.grade === '') return '';
  const pct = a.source === 'canvas' && a.canvas_points ? '%' : '';
  return `<span class="course-asn-grade" title="Grade">${esc(a.grade)}${pct}</span>`;
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
    tbody.innerHTML = `<tr><td colspan="7"><div class="empty">No assignments match the current filters.</div></td></tr>`;
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
        ${canvasBadge(a)}
        ${canBreakDown ? `<button class="btn-breakdown" data-asn="${esc(a.id)}"${a.has_canvas_material ? ' data-file="1"' : ''}
          title="${a.has_canvas_material ? 'Break down the linked Canvas file into steps' : 'Generate study tasks'}">Break down →</button>` : ''}
      </td>
      <td><span class="chip chip-course">${esc(a.course_name)}</span></td>
      <td><span class="chip chip-type">${esc(a.deliverable_type)}</span></td>
      <td class="mono">${a.weight_pct ? a.weight_pct + '%' : '—'}</td>
      <td class="mono asn-due ${cd.cls}" title="${esc(a.due_date)}">${fmt(a.due_date)} · ${cd.label}</td>
      <td class="mono">${a.est_remaining_min ? '~' + fmtMinutes(a.est_remaining_min) : '—'}</td>
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
      if (btn.dataset.file) { openBreakdown(btn.dataset.asn); return; }
      btn.textContent = 'Generating…';
      btn.disabled = true;
      try {
        const r = await fetch(`/api/assignments/${encodeURIComponent(btn.dataset.asn)}/generate-tasks`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
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
      ${course.canvas_current_score !== null && course.canvas_current_score !== undefined
        ? `<div class="course-grade">Canvas grade: <strong>${esc(course.canvas_current_score)}%</strong>${course.canvas_current_grade ? ` (${esc(course.canvas_current_grade)})` : ''}</div>`
        : ''}
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
            <span class="course-asn-title">${esc(a.title)} ${canvasBadge(a)}</span>
            ${gradeLabel(a)}
            <span class="course-asn-due">${fmt(a.due_date)}</span>
          </div>`).join('') : `<div style="font-size:12px;color:var(--ink-low);padding:6px 0;">No assignments yet.</div>`}
      </div>
      <button class="btn-add-asn" data-course="${esc(course.id)}" data-okr="${esc(course.okr_id)}">+ Add assignment</button>
      <button class="btn-import-syllabus" data-course="${esc(course.id)}" data-name="${esc(course.name)}">📄 Import syllabus</button>
      <div class="add-asn-form" id="form-${esc(course.id)}">
        <div class="asn-doc-upload" id="asn-upload-${esc(course.id)}">
          <label class="asn-doc-label">📎 Parse from PDF or Word doc
            <input type="file" class="asn-doc-file" accept=".pdf,.docx,.doc" hidden />
          </label>
          <span class="asn-doc-status"></span>
        </div>
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

  // Assignment doc upload → parse fields
  grid.querySelectorAll('.asn-doc-file').forEach(fileInput => {
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files && fileInput.files[0];
      if (!file) return;
      const form = fileInput.closest('.add-asn-form');
      const statusEl = form.querySelector('.asn-doc-status');
      statusEl.textContent = 'Parsing…';
      try {
        let payload;
        if (file.name.match(/\.docx?$/i) && typeof mammoth !== 'undefined') {
          const buf = await file.arrayBuffer();
          const result = await mammoth.extractRawText({ arrayBuffer: buf });
          payload = { text: result.value };
        } else {
          const b64 = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result.split(',')[1]);
            reader.onerror = reject;
            reader.readAsDataURL(file);
          });
          payload = { file_base64: b64, file_type: file.type || 'application/pdf' };
        }
        const res = await fetch('/api/parse-assignment-doc', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (!res.ok || data.error) { statusEl.textContent = '⚠ ' + (data.error || 'Parse failed'); return; }
        if (data.title)  form.querySelector('.asn-title').value = data.title;
        if (data.due_date) form.querySelector('.asn-due').value = data.due_date;
        if (data.weight_pct) form.querySelector('.asn-weight').value = data.weight_pct;
        if (data.deliverable_type) {
          const sel = form.querySelector('.asn-type');
          const opt = [...sel.options].find(o => o.value === data.deliverable_type);
          if (opt) sel.value = data.deliverable_type;
        }
        statusEl.textContent = '✓ Fields filled — review below';
      } catch (e) {
        statusEl.textContent = '⚠ ' + (e.message || 'Upload failed');
      } finally {
        fileInput.value = '';
      }
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
    get('/api/progress?category=education').catch(() => ({ progress: [] })),
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
            <span class="course-asn-title">${esc(a.title)} ${canvasBadge(a)}</span>
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
      if (currentTab === 'tasks') loadTasks();
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

  // Break down from the linked Canvas file
  document.getElementById('bd-close').addEventListener('click', closeBreakdown);
  document.getElementById('bd-backdrop').addEventListener('click', e => { if (e.target === e.currentTarget) closeBreakdown(); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !document.getElementById('bd-backdrop').hidden) closeBreakdown();
  });
  document.getElementById('bd-steps').addEventListener('input', updateBreakdownTotal);
  document.getElementById('bd-add').addEventListener('click', addBreakdownSteps);

  // Deadlines filters
  document.getElementById('dl-course-filter').addEventListener('change', renderDeadlines);
  document.getElementById('dl-status-filter').addEventListener('change', renderDeadlines);
  document.getElementById('dl-days-filter').addEventListener('change', loadDeadlines);

  // Micro-task board filters
  document.getElementById('mt-course-filter').addEventListener('change', () => { populateTaskFilters(); renderTasks(); });
  document.getElementById('mt-asn-filter').addEventListener('change', renderTasks);
  document.getElementById('mt-suggest-btn').addEventListener('click', suggestNextTask);

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
