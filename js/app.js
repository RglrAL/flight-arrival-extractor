// UI wiring: setup (upload → date) → operations (schedule, review, audit,
// preview, exports). All processing happens locally in this browser tab; no
// passenger data leaves the machine. Core engine modules are unchanged —
// this file is the view layer.

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
const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)');

const state = {
  files: [],          // { name, doc, extraction, records, error, pagesRead, pagesTotal, done }
  schedule: null,
  mode: 'setup',      // 'setup' | 'ops'
  filesExpanded: false,
  chipsExpanded: false,
  installPrompt: null,
};

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---------- Theme (System · Light · Dark) ----------

const THEME_KEY = 'fae-theme';
const THEME_COLORS = { light: '#f3f6fa', dark: '#10161d' };
const systemDark = window.matchMedia('(prefers-color-scheme: dark)');

function themePref() {
  try { return localStorage.getItem(THEME_KEY) || 'system'; } catch { return 'system'; }
}

function applyTheme(pref, animate = false) {
  const effective = pref === 'system' ? (systemDark.matches ? 'dark' : 'light') : pref;
  const root = document.documentElement;
  if (animate && !REDUCED.matches) {
    root.classList.add('theme-anim');
    setTimeout(() => root.classList.remove('theme-anim'), 260);
  }
  root.dataset.theme = effective;
  $('themeColorMeta').setAttribute('content', THEME_COLORS[effective]);
  document.querySelectorAll('#themeCtl [data-theme-opt]').forEach((b) => {
    b.setAttribute('aria-checked', String(b.dataset.themeOpt === pref));
  });
}

function initTheme() {
  applyTheme(themePref());
  document.querySelectorAll('#themeCtl [data-theme-opt]').forEach((b) => {
    b.addEventListener('click', () => {
      try { localStorage.setItem(THEME_KEY, b.dataset.themeOpt); } catch { /* private mode */ }
      applyTheme(b.dataset.themeOpt, true);
    });
  });
  systemDark.addEventListener('change', () => {
    if (themePref() === 'system') applyTheme('system', true);
  });
}

// ---------- Motion helpers (large layout transitions, 250–320ms) ----------

function collapseSection(el, done) {
  if (el.hidden) { done?.(); return; }
  if (REDUCED.matches) { el.hidden = true; done?.(); return; }
  el.style.height = `${el.scrollHeight}px`;
  el.style.overflow = 'hidden';
  requestAnimationFrame(() => {
    el.style.transition = 'height 300ms cubic-bezier(0.2,0.7,0.3,1), opacity 300ms cubic-bezier(0.2,0.7,0.3,1)';
    el.style.height = '0px';
    el.style.opacity = '0';
  });
  el.addEventListener('transitionend', () => {
    el.hidden = true;
    el.style.cssText = '';
    done?.();
  }, { once: true });
}

function expandSection(el) {
  if (!el.hidden) return;
  el.hidden = false;
  if (REDUCED.matches) return;
  const target = el.scrollHeight;
  el.style.height = '0px';
  el.style.opacity = '0';
  el.style.overflow = 'hidden';
  requestAnimationFrame(() => {
    el.style.transition = 'height 300ms cubic-bezier(0.2,0.7,0.3,1), opacity 300ms cubic-bezier(0.2,0.7,0.3,1)';
    el.style.height = `${target}px`;
    el.style.opacity = '1';
  });
  el.addEventListener('transitionend', () => { el.style.cssText = ''; }, { once: true });
}

// ---------- Setup ⇄ operations mode ----------

function renderCommandBar() {
  const rows = state.files.reduce((a, f) => a + f.records.length, 0);
  $('cbFiles').textContent = `${state.files.length} PDF${state.files.length === 1 ? '' : 's'} · ${rows} rows`;
  $('cbDate').textContent = state.schedule ? formatDisplayDate(state.schedule.selectedDate) : '';
}

function setMode(mode) {
  if (state.mode === mode) return;
  state.mode = mode;
  const setup = $('setupArea');
  const bar = $('commandBar');
  if (mode === 'ops') {
    renderCommandBar();
    collapseSection(setup, () => { bar.hidden = false; });
  } else {
    bar.hidden = true;
    expandSection(setup);
  }
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
  setMode('setup');
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
    state.filesExpanded = true;
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

  const allDone = state.files.length > 0 && state.files.every((f) => f.done);
  const showBody = state.files.length === 0 || state.filesExpanded || !allDone;
  $('uploadBody').hidden = !showBody;
  const toggle = $('filesToggle');
  toggle.hidden = !allDone;
  toggle.setAttribute('aria-expanded', String(showBody));
  toggle.textContent = showBody ? 'Hide files' : 'Manage files';

  const summary = $('uploadSummary');
  const compact = allDone && !showBody;
  $('uploadCard').classList.toggle('is-compact', compact);
  if (compact) {
    const rows = state.files.reduce((a, f) => a + f.records.length, 0);
    const issues = state.files.filter((f) => fileHealth(f) !== 'ok').length;
    summary.hidden = false;
    summary.innerHTML = `<span>${state.files.length} PDF${state.files.length === 1 ? '' : 's'} · ${rows} rows extracted · ` +
      (issues === 0
        ? 'all files parsed successfully <span class="okmark">✓</span>'
        : `<span class="warn">${issues} file${issues === 1 ? '' : 's'} need${issues === 1 ? 's' : ''} attention</span>`) +
      '</span><button id="addMoreBtn" class="ghostbtn">+ Add PDFs</button>';
    summary.querySelector('#addMoreBtn').addEventListener('click', () => $('fileInput').click());
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
  setMode('ops');
  $('results').scrollIntoView({ behavior: REDUCED.matches ? 'auto' : 'smooth', block: 'start' });
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

function passengerLine(p, s, showSource = true) {
  const dup = s.duplicateIds.has(p.id)
    ? ' <span class="badge badge-warn" title="Appears in more than one PDF — see review panel">duplicate?</span>' : '';
  return `<li>
    <button class="passenger" data-preview="${esc(p.id)}" title="Show this row in the source PDF">${esc(p.passengerName)}</button>
    ${showSource ? sourceMeta(p) : ''}${dup}
  </li>`;
}

function passengerStatus(p, s) {
  if (p.reviewRequired) return '<span class="badge badge-warn">Needs review</span>';
  if (s.duplicateIds.has(p.id)) return '<span class="badge badge-warn">Possible duplicate</span>';
  return '<span class="badge badge-ok">Ready</span>';
}

function inspectorHtml(g, s, idx) {
  const rows = g.passengers.map((p) => `<tr>
    <td>${esc(p.passengerName)}</td>
    <td>${esc(p.bookingId ?? '')}</td>
    <td>${passengerStatus(p, s)}</td>
    <td class="srcfull" title="${esc(p.sourceFile)}">${esc(p.sourceFile)} · p${p.sourcePage}</td>
    <td><button class="linklike" data-preview="${esc(p.id)}">View source row</button></td>
  </tr>`).join('');
  return `<div class="inspector" id="insp-${idx}" hidden>
    <div class="inspector-inner">
      <table>
        <thead><tr><th>Passenger</th><th>Booking ID</th><th>Status</th><th>Source</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </div>`;
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
    items.push(`<li>${s.noDate.length} row${s.noDate.length === 1 ? ' has' : 's have'} no arrival date and ${s.noDate.length === 1 ? 'is' : 'are'} excluded. <button class="linklike" data-audit-open>See all in audit</button> <span class="reviewnote">A date is never assumed.</span></li>`);
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
    : s.groups.map((g, i) => {
      const uniformSource = g.passengers.every((p) => p.sourceFile === g.passengers[0].sourceFile);
      return `
      <div class="flightgroup">
        <span class="time">${esc(g.time)}</span>
        <button class="flighthead" data-insp="${i}" aria-expanded="false" aria-controls="insp-${i}" title="Show flight details">
          <span class="flightno">${esc(g.flightNumber)}</span>
          ${cities.length !== 1 && g.arrivalCity ? `<span class="city">${esc(g.arrivalCity)}</span>` : ''}
          ${uniformSource ? sourceMeta(g.passengers[0]) : ''}
          <span class="chev">▾</span>
        </button>
        <span class="pcount">${g.passengers.length} passenger${g.passengers.length === 1 ? '' : 's'}</span>
        <ul class="passengers">${g.passengers.map((p) => passengerLine(p, s, !uniformSource)).join('')}</ul>
        ${inspectorHtml(g, s, i)}
      </div>`;
    }).join('');

  el.innerHTML = `
    <div class="hero">
      <div class="hero-main">
        <div class="hero-date">
          <h2>${esc(display)}</h2>
          <p class="results-sub">${esc(cityLine)}</p>
        </div>
        <div class="hero-stats totals">
          <div class="hstat"><strong>${s.totals.flights}</strong><span>flight${s.totals.flights === 1 ? '' : 's'}</span></div>
          <div class="hstat"><strong>${s.totals.passengers}</strong><span>passenger${s.totals.passengers === 1 ? '' : 's'}</span>${dupCount > 0 ? `<span class="statnote warn">incl. ${dupCount} possible duplicates</span>` : ''}</div>
          <div class="hstat"><strong>${state.files.length}</strong><span>PDF${state.files.length === 1 ? '' : 's'}</span></div>
          <div class="hstat ${issueCount === 0 ? 'is-ok' : 'is-warn'}"><strong>${issueCount}</strong><span>review issue${issueCount === 1 ? '' : 's'}</span></div>
        </div>
      </div>
    </div>
    <div id="toolbarSentinel"></div>
    <div class="hero-actions" id="toolbar">
      <button id="printBtn" class="btn btn-primary">Print schedule</button>
      <button id="sheetsBtn" class="btn" title="Original passenger sheets with the extracted arrival summary added above">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M6 2h9l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Zm8 1.5V8h4.5L14 3.5ZM7 12h10v1.5H7V12Zm0 3.5h10V17H7v-1.5Z"/></svg>
        Print sheets + summary
      </button>
      <div class="menuwrap">
        <button id="exportMenuBtn" class="btn" aria-haspopup="true" aria-expanded="false" aria-controls="exportMenu">Export ▾</button>
        <div class="menu" id="exportMenu" role="menu" hidden>
          <button id="xlsxBtn" role="menuitem">Excel (.xlsx)</button>
          <button id="csvBtn" role="menuitem">CSV</button>
        </div>
      </div>
      <span class="spacer"></span>
      <button id="auditBtn" class="btn-quiet" aria-expanded="false" aria-controls="audit">Audit data</button>
      <p class="toolbar-note">“Print sheets + summary” — the original sheets with the arrival summary added above the table.</p>
    </div>
    ${reviewPanelHtml(s, issueCount)}
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

  $('printBtn').addEventListener('click', () => { openPrintView(s); toast('Print dialog opening…'); });
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
      if (open) expandSection(body); else collapseSection(body);
      reviewToggle.setAttribute('aria-expanded', String(open));
    });
  }
  el.querySelectorAll('[data-insp]').forEach((b) => {
    b.addEventListener('click', () => {
      const insp = $(`insp-${b.dataset.insp}`);
      const open = insp.hidden;
      if (open) expandSection(insp); else collapseSection(insp);
      b.setAttribute('aria-expanded', String(open));
    });
  });
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

  // The action row is position:sticky (always in flow — zero layout jump);
  // the sentinel only toggles its pinned look.
  const sentinel = $('toolbarSentinel');
  new IntersectionObserver(([e]) => {
    $('toolbar').classList.toggle('is-stuck', !e.isIntersecting);
  }, { rootMargin: '-55px 0px 0px 0px' }).observe(sentinel);
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
  const hl = $('previewHighlight');
  hl.hidden = true;
  hl.classList.remove('is-visible');
  wrap.classList.add('is-loading');
  try {
    const info = await renderRecordPreview(file.doc, record, canvas, Math.min(900, wrap.clientWidth - 8));
    wrap.classList.remove('is-loading');
    if (info && info.rect) {
      hl.style.left = `${info.rect.x}px`;
      hl.style.top = `${info.rect.y}px`;
      hl.style.width = `${info.rect.w}px`;
      hl.style.height = `${info.rect.h}px`;
      hl.hidden = false;
      // Highlight fades in just after the page appears.
      setTimeout(() => hl.classList.add('is-visible'), REDUCED.matches ? 0 : 160);
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
      <h3 id="spTitle">Preparing arrival sheets</h3>
      <p class="progress-status" id="spStatus">Starting…</p>
      <div class="progress-bar"><span id="spBar"></span></div>
      <ul class="progress-files">${files.map((f, i) => `<li id="spFile${i}"><span class="tick">·</span><span class="pf-name" title="${esc(f.name)}">${esc(f.name)}</span></li>`).join('')}</ul>
      <button class="btn" id="spCancel">Cancel</button>
      <div class="pv-wrap">
        <img class="pv-thumb" id="spThumb" alt="Current sheet preview">
        <p class="pv-caption">Live preview</p>
      </div>
    </div>`;
  document.body.appendChild(el);
  el.querySelector('#spCancel').addEventListener('click', () => { cancelled = true; });
  return {
    status(t) { const s = el.querySelector('#spStatus'); if (s) s.textContent = t; },
    bar(f) {
      const b = el.querySelector('#spBar');
      if (b) b.style.width = `${Math.round(f * 100)}%`;
      if (f >= 1) {
        const title = el.querySelector('#spTitle');
        if (title && !title.dataset.done) {
          title.dataset.done = '1';
          title.innerHTML = 'Sheets ready <svg class="done-check" viewBox="0 0 52 52" style="width:18px;height:18px;vertical-align:-3px"><path fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" d="M12 27l9 9 19-19"/></svg>';
        }
      }
    },
    // Replace-only: one <img>, its src swapped per page — thumbnails never accumulate.
    thumbnail(dataUrl) {
      const img = el.querySelector('#spThumb');
      if (img) { img.src = dataUrl; img.classList.add('has-img'); }
    },
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
  initTheme();

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

  // Command bar (operations mode)
  $('cbAdd').addEventListener('click', () => $('fileInput').click());
  $('cbChange').addEventListener('click', () => {
    setMode('setup');
    $('dateCard').scrollIntoView({ behavior: REDUCED.matches ? 'auto' : 'smooth', block: 'center' });
  });
  $('cbFiles').addEventListener('click', () => {
    state.filesExpanded = true;
    renderFileList();
    setMode('setup');
  });
  $('cbReextract').addEventListener('click', extract);

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
