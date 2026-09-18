// UI wiring: upload → date → extract → results/review/audit/preview/exports.
// All processing happens locally in this browser tab; no passenger data
// leaves the machine. Core engine modules are unchanged — this file is the
// view layer.

import * as pdfjs from '../vendor/pdfjs/pdf.min.mjs';
import { pageFromPdfjsTextContent, extractRowsFromPages } from './extractor.js';
import { toPassengerRecords } from './validate.js';
import { buildSchedule } from './schedule.js';
import { formatDisplayDate, weekdayOf } from './normalize.js';
import { dateHistogram, shortChipDate, shortSourceLabel, reviewIssueCount } from './ui-data.js';
import { exportExcel, exportCsv, openPrintView } from './exports.js';
import { openAnnotatedSheets } from './sheetprint.js';
import { renderRecordPreview } from './preview.js';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;

const $ = (id) => document.getElementById(id);

const state = {
  files: [],          // { name, doc, extraction, records, error, pagesRead, pagesTotal, done }
  schedule: null,
  filesExpanded: false,   // user explicitly re-opened the file manager
  chipsExpanded: false,
  installPrompt: null,
};

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---------- Toast ----------

let toastTimer = null;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
}

// ---------- File loading ----------

async function addFiles(fileList) {
  // Snapshot: a FileList from an <input> is live and would empty out when
  // the input is cleared while this loop awaits.
  for (const file of Array.from(fileList)) {
    if (!file.name.toLowerCase().endsWith('.pdf')) continue;
    let name = file.name;
    let n = 2;
    while (state.files.some((f) => f.name === name)) name = `${file.name} (${n++})`;

    const entry = {
      name, doc: null, extraction: null, records: [], error: null,
      pagesRead: 0, pagesTotal: 0, done: false,
    };
    state.files.push(entry);
    state.filesExpanded = true; // keep the list visible while work is happening
    renderFileList();
    try {
      const data = new Uint8Array(await file.arrayBuffer());
      const doc = await pdfjs.getDocument({ data }).promise;
      entry.doc = doc;
      entry.pagesTotal = doc.numPages;
      const pages = [];
      for (let p = 1; p <= doc.numPages; p++) {
        const page = await doc.getPage(p);
        pages.push(pageFromPdfjsTextContent(await page.getTextContent(), p));
        entry.pagesRead = p;
        renderFileList();
      }
      entry.extraction = extractRowsFromPages(pages, name);
      entry.records = toPassengerRecords(entry.extraction);
    } catch (err) {
      entry.error = String(err && err.message ? err.message : err);
    }
    entry.done = true;
    renderFileList();
    renderDateChips();
    updateControls();
  }
  // Everything parsed: collapse the upload card to its summary line.
  if (state.files.length > 0 && state.files.every((f) => f.done)) {
    state.filesExpanded = false;
    renderFileList();
  }
}

function removeFile(name) {
  const i = state.files.findIndex((f) => f.name === name);
  if (i >= 0) {
    if (state.files[i].doc) state.files[i].doc.destroy();
    state.files.splice(i, 1);
  }
  state.schedule = null;
  state.filesExpanded = true;
  renderFileList();
  renderDateChips();
  renderResults();
  updateControls();
}

function fileHealth(f) {
  if (f.error) return 'bad';
  if (!f.done) return 'reading';
  const w = f.extraction ? f.extraction.fileWarnings : [];
  if (w.includes('no-text-layer') || w.includes('no-header-found')) return 'bad';
  if (w.includes('count-mismatch')) return 'warn';
  return 'ok';
}

function fileStatusHtml(f) {
  if (f.error) return `<span class="bad">Could not read this PDF: ${esc(f.error)}</span>`;
  if (!f.done) return `<span class="muted">Reading pages… ${f.pagesRead} of ${f.pagesTotal || '…'}</span>`;
  const w = f.extraction.fileWarnings;
  if (w.includes('no-text-layer')) return '<span class="bad">Could not reliably extract (no text layer — possibly scanned). Review manually.</span>';
  if (w.includes('no-header-found')) return '<span class="bad">Could not reliably extract (table header not found). Review manually.</span>';
  const n = f.records.length;
  let s = `${n} row${n === 1 ? '' : 's'} extracted`;
  if (f.extraction.statedTotal != null) {
    s += w.includes('count-mismatch')
      ? ` — <span class="warn">PDF states ${f.extraction.statedTotal}: mismatch, review required</span>`
      : ' · matches the PDF’s own total';
  }
  const review = f.records.filter((r) => r.reviewRequired).length;
  if (review > 0) s += ` — <span class="warn">${review} row${review === 1 ? '' : 's'} need review</span>`;
  return s;
}

function healthIcon(h) {
  if (h === 'ok') return '<span class="file-ok" aria-label="Parsed successfully">✓</span>';
  if (h === 'warn') return '<span class="file-ok file-warnicon" aria-label="Needs review">!</span>';
  if (h === 'bad') return '<span class="file-ok file-badicon" aria-label="Failed">✕</span>';
  return '';
}

function renderFileList() {
  const list = $('fileList');
  list.innerHTML = state.files.map((f) => `
    <li>
      ${healthIcon(fileHealth(f))}
      <div class="fileinfo">
        <span class="filename" title="${esc(f.name)}">${esc(f.name)}</span>
        <span class="filestatus">${fileStatusHtml(f)}</span>
        ${!f.done ? `<span class="fileprogress"><span style="width:${f.pagesTotal ? Math.round((f.pagesRead / f.pagesTotal) * 100) : 8}%"></span></span>` : ''}
      </div>
      <button class="removebtn" data-remove="${esc(f.name)}" title="Remove ${esc(f.name)}" aria-label="Remove ${esc(f.name)}">✕</button>
    </li>`).join('');
  list.querySelectorAll('[data-remove]').forEach((b) => {
    b.addEventListener('click', () => removeFile(b.dataset.remove));
  });

  // Collapsed summary vs full manager.
  const allDone = state.files.length > 0 && state.files.every((f) => f.done);
  const showBody = state.files.length === 0 || state.filesExpanded || !allDone;
  $('uploadBody').hidden = !showBody;
  const toggle = $('filesToggle');
  toggle.hidden = !allDone;
  toggle.setAttribute('aria-expanded', String(showBody));
  toggle.textContent = showBody ? 'Hide files' : 'Manage files';

  const summary = $('uploadSummary');
  if (allDone && !showBody) {
    const rows = state.files.reduce((a, f) => a + f.records.length, 0);
    const issues = state.files.filter((f) => fileHealth(f) !== 'ok').length;
    summary.hidden = false;
    summary.innerHTML = `${state.files.length} PDF${state.files.length === 1 ? '' : 's'} · ${rows} rows extracted · ` +
      (issues === 0
        ? 'all files parsed successfully <span class="okmark">✓</span>'
        : `<span class="warn">${issues} file${issues === 1 ? '' : 's'} need${issues === 1 ? 's' : ''} attention</span>`);
  } else {
    summary.hidden = true;
  }
  updateSteps();
}

// ---------- Date ----------

function allRecords() {
  return state.files.flatMap((f) => f.records);
}

function selectedDate() {
  return $('arrivalDate').value || null; // native input gives ISO
}

function renderDateChips() {
  const wrap = $('dateChips');
  const hist = dateHistogram(allRecords());
  if (hist.length === 0) { wrap.hidden = true; wrap.innerHTML = ''; return; }
  const MAX = 6;
  const shown = state.chipsExpanded ? hist : hist.slice(0, MAX);
  const sel = selectedDate();
  wrap.hidden = false;
  wrap.innerHTML = shown.map((h) => `
    <button class="datechip${h.date === sel ? ' is-selected' : ''}" data-date="${h.date}">
      ${esc(shortChipDate(h.date))}<span class="chipcount">· ${h.count}</span>
    </button>`).join('') +
    (hist.length > MAX && !state.chipsExpanded
      ? `<button class="datechip" id="moreDates" aria-expanded="false" aria-controls="dateChips">More dates (${hist.length - MAX})</button>`
      : '');
  wrap.querySelectorAll('[data-date]').forEach((b) => {
    b.addEventListener('click', () => {
      $('arrivalDate').value = b.dataset.date;
      updateControls();
      renderDateChips();
    });
  });
  const more = wrap.querySelector('#moreDates');
  if (more) more.addEventListener('click', () => { state.chipsExpanded = true; renderDateChips(); });
}

function updateControls() {
  const date = selectedDate();
  $('weekday').textContent = date ? formatDisplayDate(date) : '';
  const ready = date && state.files.some((f) => f.records.length > 0);
  const btn = $('extractBtn');
  btn.disabled = !ready;
  btn.textContent = date ? `Extract ${weekdayOf(date)} arrivals` : 'Extract arrivals';
  updateSteps();
}

function updateSteps() {
  const filesReady = state.files.length > 0 && state.files.every((f) => f.done);
  const dateSet = Boolean(selectedDate());
  const reviewing = Boolean(state.schedule);
  setStep('stepUpload', filesReady ? 'done' : 'active');
  setStep('stepDate', dateSet && filesReady ? 'done' : filesReady ? 'active' : '');
  setStep('stepReview', reviewing ? 'active' : '');
}

function setStep(id, mode) {
  const el = $(id);
  el.classList.toggle('is-done', mode === 'done');
  el.classList.toggle('is-active', mode === 'active');
}

// ---------- Extraction / results ----------

function extract() {
  const date = selectedDate();
  if (!date) return;
  state.schedule = buildSchedule(allRecords(), date);
  renderResults();
  updateSteps();
  $('results').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function recordById(id) {
  for (const f of state.files) {
    const r = f.records.find((x) => x.id === id);
    if (r) return { record: r, file: f };
  }
  return null;
}

function sourceMeta(p) {
  return `<span class="source" title="${esc(p.sourceFile)}">${esc(shortSourceLabel(p.sourceFile))}</span>`;
}

function passengerLine(p, s) {
  const dup = s.duplicateIds.has(p.id)
    ? ' <span class="badge badge-warn" title="Appears in more than one PDF — see review panel">duplicate?</span>' : '';
  return `<li>
    <button class="passenger" data-preview="${esc(p.id)}" title="Show this row in the source PDF">${esc(p.passengerName)}</button>
    ${sourceMeta(p)}${dup}
  </li>`;
}

function reviewPanelHtml(s, issueCount) {
  if (issueCount === 0) {
    return `<div class="reviewpanel is-ok" id="reviewPanel">
      <div class="reviewpanel-head">✓ No review or file-integrity issues for this date</div>
    </div>`;
  }
  const items = [];
  for (const f of state.files) {
    const w = f.extraction ? f.extraction.fileWarnings : [];
    if (w.includes('count-mismatch')) {
      items.push(`<li>Extraction may be incomplete: <strong>${esc(f.name)}</strong> states ${f.extraction.statedTotal} passengers but ${f.records.length} rows were reconstructed. <button class="linklike" data-auditfile="${esc(f.name)}">Open in audit</button></li>`);
    }
    if (f.error || w.includes('no-text-layer') || w.includes('no-header-found')) {
      items.push(`<li>Could not reliably extract <strong>${esc(f.name)}</strong> — its passengers are NOT in this schedule. Review the PDF manually.</li>`);
    }
  }
  for (const p of s.incompleteOnDate) {
    items.push(`<li><strong>${esc(p.passengerName)}</strong> is dated this day but has no flight/time on their row — excluded from the flight list. <button class="linklike" data-audit="${esc(p.id)}">Show row</button></li>`);
  }
  for (const grp of s.duplicates) {
    items.push(`<li>Possible duplicate (kept in schedule): <strong>${esc(grp[0].passengerName)}</strong> — ${esc(grp[0].flightNumber ?? '')} ${esc(grp[0].arrivalTime ?? '')} appears in ${grp.map((r) => `<em>${esc(shortSourceLabel(r.sourceFile))}</em>`).join(' and ')}. <button class="linklike" data-audit="${esc(grp[0].id)}">Show row</button></li>`);
  }
  for (const p of s.needsReview) {
    items.push(`<li>Review required: <strong>${esc(p.passengerName || '(no name)')}</strong> (${esc(p.flags.join(', '))}). <button class="linklike" data-audit="${esc(p.id)}">Show row</button></li>`);
  }
  if (s.noDate.length > 0) {
    items.push(`<li>${s.noDate.length} row${s.noDate.length === 1 ? ' has' : 's have'} no arrival date and ${s.noDate.length === 1 ? 'is' : 'are'} excluded — a date is never assumed. <button class="linklike" data-audit-open>See all in audit</button></li>`);
  }
  return `<div class="reviewpanel is-warn" id="reviewPanel">
    <button class="reviewpanel-head" id="reviewToggle" aria-expanded="false" aria-controls="reviewBody">
      <span>⚠ ${issueCount} item${issueCount === 1 ? '' : 's'} to review</span><span class="chev">▾</span>
    </button>
    <div class="reviewpanel-body" id="reviewBody" hidden><ul>${items.join('')}</ul></div>
  </div>`;
}

function renderResults() {
  const s = state.schedule;
  const el = $('results');
  if (!s) { el.innerHTML = ''; return; }

  const display = formatDisplayDate(s.selectedDate);
  const cities = [...new Set(s.groups.map((g) => g.arrivalCity).filter(Boolean))];
  const cityLine = cities.length === 1 ? `${cities[0]} Arrivals` : 'Arrivals';
  const issueCount = reviewIssueCount(s, state.files);
  const dupCount = s.duplicateIds.size;

  const groupsHtml = s.groups.length === 0
    ? '<p class="noresults">No passengers found whose own row matches this date.</p>'
    : s.groups.map((g) => `
      <div class="flightgroup">
        <span class="time">${esc(g.time)}</span>
        <span class="flighthead">
          <span class="flightno">${esc(g.flightNumber)}</span>
          ${cities.length !== 1 && g.arrivalCity ? `<span class="city">${esc(g.arrivalCity)}</span>` : ''}
        </span>
        <span class="pcount">${g.passengers.length} passenger${g.passengers.length === 1 ? '' : 's'}</span>
        <ul class="passengers">${g.passengers.map((p) => passengerLine(p, s)).join('')}</ul>
      </div>`).join('');

  el.innerHTML = `
    <div class="results-head">
      <h2>${esc(display)}</h2>
      <p class="results-sub">${esc(cityLine)}</p>
    </div>
    <div class="statstrip totals">
      <span class="statchip"><strong>${s.totals.flights}</strong> flight${s.totals.flights === 1 ? '' : 's'}</span>
      <span class="statchip"><strong>${s.totals.passengers}</strong> passenger${s.totals.passengers === 1 ? '' : 's'}${dupCount > 0 ? ` <span class="warn">(incl. ${dupCount} possible duplicates)</span>` : ''}</span>
      <span class="statchip"><strong>${state.files.length}</strong> PDF${state.files.length === 1 ? '' : 's'}</span>
      <span class="statchip ${issueCount === 0 ? 'is-ok' : 'is-warn'}"><strong>${issueCount}</strong> review issue${issueCount === 1 ? '' : 's'}</span>
    </div>
    ${reviewPanelHtml(s, issueCount)}
    <div id="toolbarSentinel"></div>
    <div class="toolbar" id="toolbar">
      <button id="printBtn" class="btn btn-primary">Print schedule</button>
      <button id="sheetsBtn" class="btn" title="Original passenger sheets with the extracted arrival summary added above">Print sheets + summary</button>
      <div class="menuwrap">
        <button id="exportMenuBtn" class="btn" aria-haspopup="true" aria-expanded="false" aria-controls="exportMenu">Export ▾</button>
        <div class="menu" id="exportMenu" role="menu" hidden>
          <button id="xlsxBtn" role="menuitem">Excel (.xlsx)</button>
          <button id="csvBtn" role="menuitem">CSV</button>
        </div>
      </div>
      <span class="spacer"></span>
      <button id="auditBtn" class="ghostbtn" aria-expanded="false" aria-controls="audit">Audit data</button>
      <p class="toolbar-note">“Print sheets + summary” reprints each original report with its arrival summary added at the top.</p>
    </div>
    <div class="board">${groupsHtml}</div>
    <div id="auditWrap" hidden>
      <div class="drawer-backdrop" id="auditBackdrop"></div>
      <aside class="drawer audit" id="audit" role="dialog" aria-modal="true" aria-label="Extracted data">
        <div class="drawer-head">
          <h3>Extracted data — all rows</h3>
          <input id="auditFilter" class="drawer-filter" type="search" placeholder="Filter rows…" aria-label="Filter rows">
          <button id="auditClose" class="ghostbtn">✕ Close</button>
        </div>
        <div class="drawer-body" id="auditBody"></div>
      </aside>
    </div>`;

  $('printBtn').addEventListener('click', () => openPrintView(s));
  $('sheetsBtn').addEventListener('click', onPrintSheets);
  $('xlsxBtn').addEventListener('click', () => { exportExcel(s); closeExportMenu(); toast(`arrivals-${s.selectedDate}.xlsx downloaded`); });
  $('csvBtn').addEventListener('click', () => { exportCsv(s); closeExportMenu(); toast(`arrivals-${s.selectedDate}.csv downloaded`); });
  $('exportMenuBtn').addEventListener('click', toggleExportMenu);
  $('auditBtn').addEventListener('click', () => (isAuditOpen() ? closeAudit() : openAudit()));
  $('auditClose').addEventListener('click', closeAudit);
  $('auditBackdrop').addEventListener('click', closeAudit);
  $('auditFilter').addEventListener('input', () => filterAudit($('auditFilter').value));

  const reviewToggle = $('reviewToggle');
  if (reviewToggle) {
    reviewToggle.addEventListener('click', () => {
      const body = $('reviewBody');
      const open = body.hidden;
      body.hidden = !open;
      reviewToggle.setAttribute('aria-expanded', String(open));
    });
  }
  el.querySelectorAll('[data-preview]').forEach((b) => {
    b.addEventListener('click', () => showPreview(b.dataset.preview));
  });
  el.querySelectorAll('[data-audit]').forEach((b) => {
    b.addEventListener('click', () => openAudit(b.dataset.audit));
  });
  el.querySelectorAll('[data-auditfile]').forEach((b) => {
    b.addEventListener('click', () => openAudit(null, b.dataset.auditfile));
  });
  el.querySelectorAll('[data-audit-open]').forEach((b) => {
    b.addEventListener('click', () => openAudit());
  });

  // Zero-jump sticky shadow: the toolbar is position:sticky (always in flow);
  // the sentinel only toggles its elevated look.
  const sentinel = $('toolbarSentinel');
  new IntersectionObserver(([e]) => {
    $('toolbar').classList.toggle('is-stuck', !e.isIntersecting);
  }, { rootMargin: '-57px 0px 0px 0px' }).observe(sentinel);
}

// ---------- Export menu ----------

function toggleExportMenu() {
  const menu = $('exportMenu');
  if (!menu) return;
  if (menu.hidden) {
    menu.hidden = false;
    $('exportMenuBtn').setAttribute('aria-expanded', 'true');
    menu.querySelector('button').focus();
  } else {
    closeExportMenu();
  }
}

function closeExportMenu(refocus = true) {
  const menu = $('exportMenu');
  if (!menu || menu.hidden) return;
  menu.hidden = true;
  const btn = $('exportMenuBtn');
  btn.setAttribute('aria-expanded', 'false');
  if (refocus) btn.focus();
}

// ---------- Audit drawer (brief §19) ----------

function isAuditOpen() {
  const w = $('auditWrap');
  return w && !w.hidden;
}

function statusLabel(r, s) {
  if (r.reviewRequired) return `⚠ review (${r.flags.join(', ')})`;
  if (r.arrivalDate == null) return 'no date on row';
  if (r.arrivalDate !== s.selectedDate) return 'different date';
  return '✓ included';
}

function openAudit(highlightId = null, fileName = null) {
  const s = state.schedule;
  if (!s) return;
  const body = $('auditBody');
  const rows = allRecords().map((r) => {
    const included = r.arrivalDate === s.selectedDate && r.flightNumber && r.arrivalTime;
    const cls = [r.reviewRequired ? 'bad' : included ? '' : 'muted'];
    return `<tr class="${cls.join(' ')}" data-id="${esc(r.id)}" data-file="${esc(r.sourceFile)}">
      <td><button class="passenger" data-preview="${esc(r.id)}">${esc(r.passengerName || '(no name)')}</button></td>
      <td>${esc(r.bookingId ?? '')}</td>
      <td>${esc(r.flightNumber ?? '')}</td>
      <td>${esc(r.arrivalTime ?? '')}</td>
      <td>${esc(r.arrivalCity ?? '')}</td>
      <td>${esc(r.raw?.date || '')}</td>
      <td>${esc(statusLabel(r, s))}</td>
      <td class="source" title="${esc(r.sourceFile)}">${esc(shortSourceLabel(r.sourceFile))} p${r.sourcePage}</td>
    </tr>`;
  }).join('');
  body.innerHTML = `<table>
    <thead><tr><th>Passenger</th><th>Booking ID</th><th>Flight</th><th>Time</th><th>City</th><th>Date (as printed)</th><th>Status</th><th>Source</th></tr></thead>
    <tbody>${rows}</tbody></table>`;
  body.querySelectorAll('[data-preview]').forEach((b) => {
    b.addEventListener('click', () => showPreview(b.dataset.preview));
  });

  $('auditWrap').hidden = false;
  $('auditBtn').setAttribute('aria-expanded', 'true');
  $('auditFilter').value = '';

  let target = null;
  if (highlightId) target = body.querySelector(`tr[data-id="${CSS.escape(highlightId)}"]`);
  else if (fileName) target = body.querySelector(`tr[data-file="${CSS.escape(fileName)}"]`);
  if (target) {
    target.classList.add('is-flash');
    target.scrollIntoView({ block: 'center' });
  }
}

function closeAudit() {
  $('auditWrap').hidden = true;
  const btn = $('auditBtn');
  btn.setAttribute('aria-expanded', 'false');
  btn.focus();
}

function filterAudit(q) {
  const needle = q.trim().toLowerCase();
  $('auditBody').querySelectorAll('tbody tr').forEach((tr) => {
    tr.hidden = needle !== '' && !tr.textContent.toLowerCase().includes(needle);
  });
}

// ---------- Source preview (brief §20) ----------

async function showPreview(id) {
  const hit = recordById(id);
  if (!hit || !hit.file.doc) return;
  const { record, file } = hit;
  $('previewTitle').textContent = `${record.passengerName || '(row)'} — ${record.sourceFile}, page ${record.sourcePage}`;
  const dlg = $('previewDialog');
  dlg.showModal();
  const canvas = $('previewCanvas');
  const wrap = $('previewScroll');
  wrap.classList.add('is-loading');
  try {
    const info = await renderRecordPreview(file.doc, record, canvas, Math.min(900, wrap.clientWidth - 8));
    if (info) {
      wrap.scrollTop = Math.max(0, info.scrollY * canvas.clientHeight - wrap.clientHeight / 2);
    }
  } finally {
    wrap.classList.remove('is-loading');
  }
}

// ---------- Annotated sheets with progress ----------

function showSheetsProgress(files) {
  let cancelled = false;
  const el = document.createElement('div');
  el.className = 'progress-overlay';
  el.innerHTML = `
    <div class="progresscard" role="alertdialog" aria-label="Preparing arrival sheets" aria-live="polite">
      <h3>Preparing arrival sheets</h3>
      <p class="progress-status" id="spStatus">Starting…</p>
      <div class="progress-bar"><span id="spBar"></span></div>
      <ul class="progress-files">${files.map((f, i) => `<li id="spFile${i}"><span class="tick">·</span><span class="pf-name" title="${esc(f.name)}">${esc(f.name)}</span></li>`).join('')}</ul>
      <button class="btn" id="spCancel">Cancel</button>
    </div>`;
  document.body.appendChild(el);
  el.querySelector('#spCancel').addEventListener('click', () => { cancelled = true; });
  return {
    status(t) { const s = el.querySelector('#spStatus'); if (s) s.textContent = t; },
    bar(f) { const b = el.querySelector('#spBar'); if (b) b.style.width = `${Math.round(f * 100)}%`; },
    fileDone(i) {
      const li = el.querySelector(`#spFile${i}`);
      if (li) { li.classList.add('done'); li.querySelector('.tick').textContent = '✓'; }
    },
    cancelled: () => cancelled,
    close() { el.remove(); },
  };
}

async function onPrintSheets() {
  const btn = $('sheetsBtn');
  if (btn.disabled) return;
  btn.disabled = true;
  const overlay = showSheetsProgress(state.files.filter((f) => f.doc));
  try {
    const ok = await openAnnotatedSheets(state.files, state.schedule.selectedDate, overlay);
    if (ok) toast('Sheets ready — check the print dialog');
  } catch (err) {
    toast(`Could not prepare sheets: ${err && err.message ? err.message : err}`);
  } finally {
    overlay.close();
    btn.disabled = false;
  }
}

// ---------- Init ----------

function init() {
  const drop = $('dropzone');
  const input = $('fileInput');
  drop.addEventListener('click', () => input.click());
  drop.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
  });
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('drag'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('drag');
    addFiles(e.dataTransfer.files);
  });
  input.addEventListener('change', () => { addFiles(input.files); input.value = ''; });

  $('filesToggle').addEventListener('click', () => {
    state.filesExpanded = $('uploadBody').hidden;
    renderFileList();
  });

  $('arrivalDate').addEventListener('change', () => { updateControls(); renderDateChips(); });
  $('extractBtn').addEventListener('click', extract);
  $('previewClose').addEventListener('click', () => $('previewDialog').close());

  for (const [btnId, dlgId] of [['helpBtn', 'helpDialog'], ['aboutBtn', 'aboutDialog']]) {
    $(btnId).addEventListener('click', () => $(dlgId).showModal());
  }
  document.querySelectorAll('[data-close]').forEach((b) => {
    b.addEventListener('click', () => $(b.dataset.close).close());
  });

  // One persistent handler pair for menu dismissal (results re-render safe).
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.menuwrap')) closeExportMenu(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const menu = $('exportMenu');
    if (menu && !menu.hidden) { closeExportMenu(); return; }
    if (isAuditOpen()) closeAudit();
  });

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    state.installPrompt = e;
    $('installBtn').hidden = false;
  });
  $('installBtn').addEventListener('click', async () => {
    if (!state.installPrompt) return;
    state.installPrompt.prompt();
    await state.installPrompt.userChoice;
    state.installPrompt = null;
    $('installBtn').hidden = true;
  });

  updateControls();
}

init();
