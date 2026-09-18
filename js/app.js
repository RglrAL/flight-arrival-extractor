// UI wiring: upload → date → extract → results/audit/preview/exports.
// All processing happens locally in this browser tab; no passenger data
// leaves the machine.

import * as pdfjs from '../vendor/pdfjs/pdf.min.mjs';
import { pageFromPdfjsTextContent, extractRowsFromPages } from './extractor.js';
import { toPassengerRecords } from './validate.js';
import { buildSchedule } from './schedule.js';
import { formatDisplayDate, weekdayOf } from './normalize.js';
import { exportExcel, exportCsv, openPrintView } from './exports.js';
import { renderRecordPreview } from './preview.js';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;

const $ = (id) => document.getElementById(id);

const state = {
  files: [],        // { name, doc, extraction, records, error }
  schedule: null,
};

// ---------- File loading ----------

async function addFiles(fileList) {
  // Snapshot: a FileList from an <input> is live and would empty out when
  // the input is cleared while this loop awaits.
  for (const file of Array.from(fileList)) {
    if (!file.name.toLowerCase().endsWith('.pdf')) continue;
    let name = file.name;
    let n = 2;
    while (state.files.some((f) => f.name === name)) name = `${file.name} (${n++})`;

    const entry = { name, doc: null, extraction: null, records: [], error: null };
    state.files.push(entry);
    renderFileList();
    try {
      const data = new Uint8Array(await file.arrayBuffer());
      const doc = await pdfjs.getDocument({ data }).promise;
      const pages = [];
      for (let p = 1; p <= doc.numPages; p++) {
        const page = await doc.getPage(p);
        pages.push(pageFromPdfjsTextContent(await page.getTextContent(), p));
      }
      entry.doc = doc;
      entry.extraction = extractRowsFromPages(pages, name);
      entry.records = toPassengerRecords(entry.extraction);
    } catch (err) {
      entry.error = String(err && err.message ? err.message : err);
    }
    renderFileList();
    updateControls();
  }
}

function removeFile(name) {
  const i = state.files.findIndex((f) => f.name === name);
  if (i >= 0) {
    if (state.files[i].doc) state.files[i].doc.destroy();
    state.files.splice(i, 1);
  }
  state.schedule = null;
  renderFileList();
  renderResults();
  updateControls();
}

function fileStatusHtml(f) {
  if (f.error) return `<span class="bad">⚠ Could not read this PDF: ${esc(f.error)}</span>`;
  if (!f.extraction) return '<span class="muted">Reading…</span>';
  const w = f.extraction.fileWarnings;
  if (w.includes('no-text-layer')) return '<span class="bad">⚠ Could not reliably extract this PDF (no text layer — possibly scanned). Please review it manually.</span>';
  if (w.includes('no-header-found')) return '<span class="bad">⚠ Could not reliably extract this PDF (table header not found). Please review it manually.</span>';
  const n = f.records.length;
  const review = f.records.filter((r) => r.reviewRequired).length;
  let s = `${n} passenger row${n === 1 ? '' : 's'} extracted`;
  if (f.extraction.statedTotal != null) {
    s += w.includes('count-mismatch')
      ? ` — <span class="bad">⚠ PDF says ${f.extraction.statedTotal}: mismatch, review required</span>`
      : ` <span class="ok">(matches the PDF's own total ✓)</span>`;
  }
  if (review > 0) s += ` — <span class="warn">${review} row${review === 1 ? '' : 's'} need review</span>`;
  return s;
}

function renderFileList() {
  const el = $('fileList');
  el.innerHTML = state.files.map((f) => `
    <li>
      <div class="fileinfo">
        <span class="filename">${esc(f.name)}</span>
        <span class="filestatus">${fileStatusHtml(f)}</span>
      </div>
      <button class="linkbtn" data-remove="${esc(f.name)}" title="Remove">✕</button>
    </li>`).join('');
  el.querySelectorAll('[data-remove]').forEach((b) => {
    b.addEventListener('click', () => removeFile(b.dataset.remove));
  });
}

// ---------- Date ----------

function selectedDate() {
  return $('arrivalDate').value || null; // native input gives ISO
}

function updateControls() {
  const date = selectedDate();
  $('weekday').textContent = date ? `${formatDisplayDate(date)}` : '';
  const ready = date && state.files.some((f) => f.records.length > 0);
  const btn = $('extractBtn');
  btn.disabled = !ready;
  btn.textContent = date ? `Extract ${weekdayOf(date)} Arrivals` : 'Extract Arrivals';
}

// ---------- Extraction / results ----------

function extract() {
  const date = selectedDate();
  if (!date) return;
  const all = state.files.flatMap((f) => f.records);
  state.schedule = buildSchedule(all, date);
  renderResults();
  $('results').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function recordById(id) {
  for (const f of state.files) {
    const r = f.records.find((x) => x.id === id);
    if (r) return { record: r, file: f };
  }
  return null;
}

function passengerLine(p, s) {
  const dup = s.duplicateIds.has(p.id) ? ' <span class="warn" title="Possible duplicate — appears in more than one PDF">⚠ possible duplicate</span>' : '';
  return `<li>
    <button class="passenger" data-preview="${esc(p.id)}" title="Show this row in the source PDF">${esc(p.passengerName)}</button>
    <span class="source">${esc(p.sourceFile)}</span>${dup}
  </li>`;
}

function renderResults() {
  const s = state.schedule;
  const el = $('results');
  if (!s) { el.innerHTML = ''; return; }

  const display = formatDisplayDate(s.selectedDate);
  const cities = [...new Set(s.groups.map((g) => g.arrivalCity).filter(Boolean))];
  const cityLine = cities.length === 1 ? `${cities[0]} Arrivals` : 'Arrivals';

  const groupsHtml = s.groups.length === 0
    ? '<p class="muted">No passengers found whose own row matches this date.</p>'
    : s.groups.map((g) => `
      <div class="flightgroup">
        <div class="flighthead">
          <span class="time">${esc(g.time)}</span>
          <span class="flightno">${esc(g.flightNumber)}</span>
          ${cities.length !== 1 && g.arrivalCity ? `<span class="city">${esc(g.arrivalCity)}</span>` : ''}
          <span class="pcount">${g.passengers.length} passenger${g.passengers.length === 1 ? '' : 's'}</span>
        </div>
        <ul class="passengers">${g.passengers.map((p) => passengerLine(p, s)).join('')}</ul>
      </div>`).join('');

  const warnings = [];
  if (s.incompleteOnDate.length > 0) {
    warnings.push(`<div class="warnblock"><h4>⚠ Dated ${esc(display)} but incomplete (no flight/time on their row) — not shown in the schedule above</h4>
      <ul>${s.incompleteOnDate.map((p) => `<li><button class="passenger" data-preview="${esc(p.id)}">${esc(p.passengerName)}</button> <span class="source">${esc(p.sourceFile)}</span></li>`).join('')}</ul></div>`);
  }
  if (s.noDate.length > 0) {
    warnings.push(`<div class="warnblock"><h4>Rows with no arrival date on them: ${s.noDate.length} (excluded — a date is never assumed)</h4></div>`);
  }
  if (s.duplicates.length > 0) {
    warnings.push(`<div class="warnblock"><h4>⚠ Possible duplicates (kept in the schedule — please review)</h4>
      <ul>${s.duplicates.map((grp) => `<li>${esc(grp[0].passengerName)} — ${esc(grp[0].flightNumber ?? '')} ${esc(grp[0].arrivalTime ?? '')}: appears in ${grp.map((r) => `<em>${esc(r.sourceFile)}</em>`).join(' and ')}</li>`).join('')}</ul></div>`);
  }
  if (s.needsReview.length > 0) {
    warnings.push(`<div class="warnblock"><h4>⚠ ${s.needsReview.length} extracted row${s.needsReview.length === 1 ? '' : 's'} need${s.needsReview.length === 1 ? 's' : ''} review (see “View extracted data”)</h4></div>`);
  }

  el.innerHTML = `
    <hr>
    <h2>${esc(display)}</h2>
    <h3>${esc(cityLine)}</h3>
    ${groupsHtml}
    <p class="totals">Total flights: <strong>${s.totals.flights}</strong> &nbsp;·&nbsp; Total passengers: <strong>${s.totals.passengers}</strong>${s.totals.incompleteOnDate ? ` &nbsp;·&nbsp; <span class="warn">${s.totals.incompleteOnDate} incomplete (listed below)</span>` : ''}</p>
    ${warnings.join('')}
    <div class="exportrow">
      <button id="xlsxBtn" class="secondary">Export Excel</button>
      <button id="csvBtn" class="secondary">Export CSV</button>
      <button id="printBtn" class="secondary">Print / PDF</button>
      <button id="auditBtn" class="secondary">View extracted data</button>
    </div>
    <div id="audit" class="audit" hidden></div>`;

  $('xlsxBtn').addEventListener('click', () => exportExcel(s));
  $('csvBtn').addEventListener('click', () => exportCsv(s));
  $('printBtn').addEventListener('click', () => openPrintView(s));
  $('auditBtn').addEventListener('click', toggleAudit);
  el.querySelectorAll('[data-preview]').forEach((b) => {
    b.addEventListener('click', () => showPreview(b.dataset.preview));
  });
}

// ---------- Audit view (brief §19) ----------

function toggleAudit() {
  const el = $('audit');
  if (!el.hidden) { el.hidden = true; return; }
  const s = state.schedule;
  const all = state.files.flatMap((f) => f.records);
  const rows = all.map((r) => {
    const included = r.arrivalDate === s.selectedDate;
    const cls = r.reviewRequired ? 'bad' : included ? '' : 'muted';
    return `<tr class="${cls}">
      <td><button class="passenger" data-preview="${esc(r.id)}">${esc(r.passengerName || '(no name)')}</button></td>
      <td>${esc(r.bookingId ?? '')}</td>
      <td>${esc(r.flightNumber ?? '')}</td>
      <td>${esc(r.arrivalTime ?? '')}</td>
      <td>${esc(r.arrivalCity ?? '')}</td>
      <td>${esc(r.raw?.date || '')}</td>
      <td>${r.extractionConfidence}%</td>
      <td>${included ? '✓ included' : esc(statusLabel(r, s))}</td>
      <td class="source">${esc(r.sourceFile)} p${r.sourcePage}</td>
    </tr>`;
  }).join('');
  el.innerHTML = `<table>
    <thead><tr><th>Passenger</th><th>Booking ID</th><th>Flight</th><th>Time</th><th>City</th><th>Date (as printed)</th><th>Confidence</th><th>Status</th><th>Source</th></tr></thead>
    <tbody>${rows}</tbody></table>`;
  el.hidden = false;
  el.querySelectorAll('[data-preview]').forEach((b) => {
    b.addEventListener('click', () => showPreview(b.dataset.preview));
  });
}

function statusLabel(r, s) {
  if (r.reviewRequired) return `⚠ review (${r.flags.join(', ')})`;
  if (r.arrivalDate == null) return 'no date on row';
  if (r.arrivalDate !== s.selectedDate) return 'different date';
  return '';
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
  const info = await renderRecordPreview(file.doc, record, canvas, Math.min(900, wrap.clientWidth - 8));
  if (info) {
    wrap.scrollTop = Math.max(0, info.scrollY * canvas.clientHeight - wrap.clientHeight / 2);
  }
}

// ---------- Init ----------

function init() {
  const drop = $('dropzone');
  const input = $('fileInput');
  drop.addEventListener('click', () => input.click());
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('drag'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('drag');
    addFiles(e.dataTransfer.files);
  });
  input.addEventListener('change', () => { addFiles(input.files); input.value = ''; });

  $('arrivalDate').addEventListener('change', updateControls);
  $('extractBtn').addEventListener('click', extract);
  $('previewClose').addEventListener('click', () => $('previewDialog').close());
  updateControls();
}

init();
