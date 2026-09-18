// "Annotated sheet" printing: reproduce each source PDF with that file's
// extracted day-summary drawn into the header of its first page — the digital
// version of the manual workflow of handwriting "05:10 EI/122 × 7" at the top
// of each report before printing it.

import { formatDisplayDate } from './normalize.js';

/**
 * Per-file summary of a selected date, from that file's validated records.
 * Pure function (Node-testable).
 * Returns { flights: [{ time, flightNumber, arrivalCity, count }], total, incomplete }
 * — flights time-sorted, total = passengers with a flight+time on the date,
 * incomplete = passengers dated that day but with no flight/time on their row.
 */
export function buildFileSummary(records, selectedDate) {
  const onDate = records.filter((r) => r.arrivalDate === selectedDate);
  const scheduled = onDate.filter((r) => r.flightNumber != null && r.arrivalTime != null);
  const incomplete = onDate.length - scheduled.length;

  const map = new Map();
  for (const r of scheduled) {
    const key = `${r.arrivalTime}|${r.flightNumber}|${r.arrivalCity ?? ''}`;
    if (!map.has(key)) {
      map.set(key, { time: r.arrivalTime, flightNumber: r.flightNumber, arrivalCity: r.arrivalCity, count: 0 });
    }
    map.get(key).count += 1;
  }
  const flights = [...map.values()].sort(
    (a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : a.flightNumber.localeCompare(b.flightNumber)),
  );
  return { flights, total: scheduled.length, incomplete };
}

/** Draw the summary block onto the first-page canvas, top-right header area. */
function drawSummaryOverlay(ctx, W, H, summary, selectedDate) {
  const showCity = new Set(summary.flights.map((f) => f.arrivalCity ?? '')).size > 1;
  const lines = [];
  lines.push({ text: formatDisplayDate(selectedDate), color: '#b02a37', bold: true });
  if (summary.flights.length === 0) {
    lines.push({ text: 'No arrivals this date in this report', color: '#1d4ed8', bold: false });
  } else {
    for (const f of summary.flights) {
      const city = showCity && f.arrivalCity ? `  (${f.arrivalCity})` : '';
      lines.push({ text: `${f.time}   ${f.flightNumber}${city}   × ${f.count}`, color: '#1d4ed8', bold: true });
    }
    lines.push({ text: `Total: ${summary.total} passenger${summary.total === 1 ? '' : 's'}`, color: '#b02a37', bold: true });
  }
  if (summary.incomplete > 0) {
    lines.push({ text: `⚠ +${summary.incomplete} dated this day, no flight on row`, color: '#8a5a00', bold: false });
  }

  // Split into two columns when long, so the block stays inside the header band.
  const maxRows = 8;
  const columns = [];
  for (let i = 0; i < lines.length; i += maxRows) columns.push(lines.slice(i, i + maxRows));

  const fs = Math.max(14, Math.round(H * 0.021));
  const lineH = Math.round(fs * 1.4);
  const pad = Math.round(fs * 0.8);

  ctx.save();
  const colWidths = columns.map((col) => {
    let w = 0;
    for (const l of col) {
      ctx.font = `${l.bold ? '600 ' : ''}${fs}px -apple-system, "Segoe UI", Helvetica, Arial, sans-serif`;
      w = Math.max(w, ctx.measureText(l.text).width);
    }
    return w;
  });
  const gap = pad * 1.5;
  const boxW = colWidths.reduce((a, b) => a + b, 0) + gap * (columns.length - 1) + pad * 2;
  const boxH = Math.max(...columns.map((c) => c.length)) * lineH + pad * 2;
  // Below the report's "Date:" line (~top 20%), keeping it readable.
  const x0 = W - boxW - Math.round(W * 0.015);
  const y0 = Math.round(H * 0.03);

  ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
  ctx.strokeStyle = '#1d4ed8';
  ctx.lineWidth = Math.max(2, Math.round(fs / 8));
  ctx.beginPath();
  ctx.roundRect(x0, y0, boxW, boxH, pad);
  ctx.fill();
  ctx.stroke();

  let cx = x0 + pad;
  columns.forEach((col, ci) => {
    let cy = y0 + pad + fs;
    for (const l of col) {
      ctx.font = `${l.bold ? '600 ' : ''}${fs}px -apple-system, "Segoe UI", Helvetica, Arial, sans-serif`;
      ctx.fillStyle = l.color;
      ctx.fillText(l.text, cx, cy);
      cy += lineH;
    }
    cx += colWidths[ci] + gap;
  });
  ctx.restore();
}

/**
 * Open a print view containing every readable uploaded PDF, page by page,
 * with the per-file summary drawn onto each file's first page.
 * files: [{ name, doc, records }] (pdf.js doc); selectedDate: ISO.
 * The window must be opened synchronously by the caller's click handler.
 */
export async function openAnnotatedSheets(files, selectedDate, win) {
  const sections = [];
  for (const f of files) {
    if (!f.doc) continue;
    const summary = buildFileSummary(f.records, selectedDate);
    const imgs = [];
    for (let p = 1; p <= f.doc.numPages; p++) {
      const page = await f.doc.getPage(p);
      const viewport = page.getViewport({ scale: 2 });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      const ctx = canvas.getContext('2d');
      await page.render({ canvasContext: ctx, viewport }).promise;
      if (p === 1) drawSummaryOverlay(ctx, canvas.width, canvas.height, summary, selectedDate);
      imgs.push({ src: canvas.toDataURL('image/jpeg', 0.85), landscape: viewport.width > viewport.height });
    }
    sections.push({ name: f.name, imgs });
  }

  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const body = sections.map((s) =>
    s.imgs.map((im) => `<img class="${im.landscape ? 'landscape' : 'portrait'}" src="${im.src}" alt="${esc(s.name)}">`).join('\n'),
  ).join('\n');

  win.document.open();
  win.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8">
  <title>Arrival sheets — ${esc(formatDisplayDate(selectedDate))}</title>
  <style>
    body { margin: 0; }
    img { display: block; width: 100%; page-break-after: always; }
    img:last-child { page-break-after: auto; }
    @page { size: landscape; margin: 0.4cm; }
    @media screen { body { background: #555; } img { margin: 0 auto 12px; max-width: 1100px; box-shadow: 0 2px 10px rgba(0,0,0,0.5); } }
  </style></head><body>${body}</body></html>`);
  win.document.close();
  win.focus();
  setTimeout(() => win.print(), 500);
}
