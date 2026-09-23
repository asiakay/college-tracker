// Export one assignment's micro-tasks (its broken-down steps) as CSV, Excel or PowerPoint.
// Files are built in the browser. The Excel and PowerPoint writers are loaded
// from jsDelivr (pinned, with SRI) only when those exports are used.

const LIBS = {
  xlsx: {
    src: 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js',
    integrity: 'sha384-vtjasyidUo0kW94K5MXDXntzOJpQgBKXmE7e2Ga4LG0skTTLeBi97eFAXsqewJjw',
    global: 'XLSX',
  },
  pptx: {
    src: 'https://cdn.jsdelivr.net/npm/pptxgenjs@3.12.0/dist/pptxgen.bundle.js',
    integrity: 'sha384-Cck14aA9cifjYolcnjebXRfWGkz5ltHMBiG4px/j8GS+xQcb7OhNQWZYyWjQ+UwQ',
    global: 'PptxGenJS',
  },
};
const loading = {};

function loadLib(name) {
  const lib = LIBS[name];
  if (window[lib.global]) return Promise.resolve(window[lib.global]);
  loading[name] ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = lib.src;
    s.integrity = lib.integrity;
    s.crossOrigin = 'anonymous';
    s.onload = () => (window[lib.global] ? resolve(window[lib.global]) : reject(new Error(`${name} library didn't load`)));
    s.onerror = () => { delete loading[name]; reject(new Error(`couldn't load the ${name === 'xlsx' ? 'Excel' : 'PowerPoint'} writer — check your connection`)); };
    document.head.appendChild(s);
  });
  return loading[name];
}

const COLUMNS = ['#', 'Step', 'Status', 'Time estimate', 'Resource', 'Resource URL', 'Details', 'Last moved', 'Done on'];

function day(iso) { return iso ? String(iso).slice(0, 10) : ''; }

/** The assignment's steps in the order they were created (a breakdown's step order), plus header facts. */
export function exportData(tasks, { parseDuration, fmtMinutes }) {
  const steps = [...tasks].sort((a, b) => a.id - b.id);
  const first = steps[0] || {};
  const mins = (list) => list.reduce((n, t) => n + (parseDuration(t.time_spent || '') || 0), 0);
  const total = mins(steps);
  const remaining = mins(steps.filter(t => t.status !== 'Done'));
  return {
    assignment: first.assignment_title || 'Assignment',
    course: first.course_name || '',
    due: first.due_date || '',
    canvasUrl: first.canvas_url || '',
    fileTitle: first.canvas_material_title || '',
    fileUrl: first.canvas_material_url || '',
    total: total ? fmtMinutes(total) : '',
    remaining: remaining ? fmtMinutes(remaining) : '',
    done: steps.filter(t => t.status === 'Done').length,
    rows: steps.map((t, i) => [
      i + 1, t.description || '', t.status || '', t.time_spent || '',
      t.link_url ? (t.link_label || 'Link') : '', t.link_url || '', t.notes || '',
      day(t.last_moved_at), t.status === 'Done' ? day(t.done_at || t.date) : '',
    ]),
  };
}

function headerLines(d) {
  return [
    ['Assignment', d.assignment],
    ['Course', d.course],
    ['Due', d.due],
    ['Canvas assignment', d.canvasUrl],
    ['Instructions file', d.fileTitle ? `${d.fileTitle}${d.fileUrl ? ` (${d.fileUrl})` : ''}` : ''],
    ['Progress', `${d.done}/${d.rows.length} done${d.total ? ` · ~${d.total} total` : ''}${d.remaining ? ` · ~${d.remaining} left` : ''}`],
    ['Exported', new Date().toISOString().slice(0, 10)],
  ].filter(([, v]) => v);
}

// ── CSV ──────────────────────────────────────────────────────────────────────

function csvCell(v) {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // never let a spreadsheet run a cell as a formula
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(d) {
  const lines = [...headerLines(d), [], COLUMNS, ...d.rows];
  return '﻿' + lines.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

// ── Excel ────────────────────────────────────────────────────────────────────

async function toXlsx(d) {
  const XLSX = await loadLib('xlsx');
  const head = headerLines(d);
  const top = [[d.assignment], ...head.slice(1).map(([k, v]) => [k, v]), []];
  const aoa = [...top, COLUMNS, ...d.rows, [], ['', 'Total', '', d.total ? `~${d.total}` : '']];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const tableStart = top.length + 1; // first step row (0-based)
  d.rows.forEach((r, i) => {
    if (!r[5]) return;
    const cell = ws[XLSX.utils.encode_cell({ r: tableStart + i, c: 4 })];
    if (cell) cell.l = { Target: r[5], Tooltip: r[5] };
  });
  // Header links: the Canvas assignment line
  top.forEach((row, r) => {
    if (row[0] === 'Canvas assignment' && d.canvasUrl) ws[XLSX.utils.encode_cell({ r, c: 1 })].l = { Target: d.canvasUrl };
  });
  ws['!cols'] = [{ wch: 5 }, { wch: 58 }, { wch: 12 }, { wch: 13 }, { wch: 22 }, { wch: 40 }, { wch: 40 }, { wch: 12 }, { wch: 12 }];
  ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: tableStart - 1, c: 0 }, e: { r: tableStart - 1 + d.rows.length, c: COLUMNS.length - 1 } }) };
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Steps');
  const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  return new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

// ── PowerPoint ───────────────────────────────────────────────────────────────

const INK = '1F2328', MID = '57606A', ACCENT = '0969DA', GREEN = '1A7F37';
const PER_SLIDE = 6;

async function toPptx(d) {
  const PptxGenJS = await loadLib('pptx');
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_16x9'; // 10 × 5.625 in
  pptx.title = `${d.assignment} – steps`;

  const title = pptx.addSlide();
  title.addText(d.course || ' ', { x: 0.6, y: 0.9, w: 8.8, h: 0.4, fontSize: 16, color: MID });
  title.addText(d.assignment, { x: 0.6, y: 1.3, w: 8.8, h: 1.1, fontSize: 34, bold: true, color: INK, fit: 'shrink' });
  const facts = [d.due && `Due ${d.due}`, `${d.rows.length} step${d.rows.length === 1 ? '' : 's'}`, d.total && `~${d.total}`,
    d.done && `${d.done} done`].filter(Boolean).join('  ·  ');
  title.addText(facts, { x: 0.6, y: 2.5, w: 8.8, h: 0.4, fontSize: 16, color: INK });
  const links = [];
  if (d.canvasUrl) links.push({ text: 'Canvas assignment ↗', options: { hyperlink: { url: d.canvasUrl }, color: ACCENT } });
  if (d.fileUrl) {
    if (links.length) links.push({ text: '     ' });
    links.push({ text: `${d.fileTitle || 'Instructions file'} ↗`, options: { hyperlink: { url: d.fileUrl }, color: ACCENT } });
  }
  if (links.length) title.addText(links, { x: 0.6, y: 3.1, w: 8.8, h: 0.4, fontSize: 14 });

  for (let start = 0; start < d.rows.length; start += PER_SLIDE) {
    const slide = pptx.addSlide();
    const pages = Math.ceil(d.rows.length / PER_SLIDE);
    slide.addText(`Steps${pages > 1 ? ` (${start / PER_SLIDE + 1}/${pages})` : ''}`, {
      x: 0.5, y: 0.25, w: 9, h: 0.5, fontSize: 22, bold: true, color: INK,
    });
    d.rows.slice(start, start + PER_SLIDE).forEach((r, i) => {
      const [n, step, status, time, label, url, notes] = r;
      const done = status === 'Done';
      const runs = [
        { text: `${done ? '☑' : '☐'}  ${n}. `, options: { color: done ? GREEN : MID } },
        { text: step, options: { bold: true, color: done ? MID : INK, strike: done ? 'sngStrike' : undefined } },
        { text: [time && `  ·  ${time}`, status === 'In Progress' && '  ·  in progress'].filter(Boolean).join(''), options: { color: MID } },
      ];
      if (url || notes) runs.push({ text: '', options: { breakLine: true } });
      if (url) runs.push({ text: `▶ ${label} ↗`, options: { hyperlink: { url }, color: ACCENT, fontSize: 12 } });
      if (url && notes) runs.push({ text: '   ', options: { fontSize: 12 } });
      if (notes) runs.push({ text: notes, options: { color: MID, fontSize: 12 } });
      slide.addText(runs, { x: 0.5, y: 0.95 + i * 0.75, w: 9, h: 0.7, fontSize: 15, valign: 'top', fit: 'shrink' });
    });
  }
  const blob = await pptx.write({ outputType: 'blob' });
  return blob;
}

// ── Download ─────────────────────────────────────────────────────────────────

function fileName(d, ext) {
  // Plain ASCII separators: Chromium drops a download name containing some characters (e.g. "–").
  const base = [d.course, d.assignment, 'steps'].filter(Boolean).join(' - ')
    .replace(/[\u2010-\u2015]/g, '-').replace(/[\\/:*?"<>|]+/g, '-').slice(0, 120);
  return `${base}.${ext}`;
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Builds and downloads the file; returns its name. Throws with a readable message. */
export async function exportAssignment(tasks, format, helpers) {
  if (!tasks.length) throw new Error('this assignment has no steps yet — use Break down first');
  const d = exportData(tasks, helpers);
  let blob, ext;
  if (format === 'csv') { blob = new Blob([toCsv(d)], { type: 'text/csv;charset=utf-8' }); ext = 'csv'; }
  else if (format === 'xlsx') { blob = await toXlsx(d); ext = 'xlsx'; }
  else if (format === 'pptx') { blob = await toPptx(d); ext = 'pptx'; }
  else throw new Error(`unknown format ${format}`);
  const name = fileName(d, ext);
  download(blob, name);
  return name;
}
