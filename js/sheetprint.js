// "Annotated sheet" printing: reproduce each source PDF with that file's
// extracted day-summary added to its first page — the digital version of the
// manual workflow of handwriting "05:10 EI/122 × 7" at the top of each report.
//
// The summary is drawn INTO the header whitespace (like the handwriting) only
// after checking, using the page's own text coordinates, that the space is
// genuinely empty. If anything printed would be covered — a different
// template, or simply a long summary — the page canvas is extended upward and
// the summary gets its own band above the untouched original instead.

import { formatDisplayDate } from './normalize.js';
import { printHtml } from './exports.js';

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

/**
 * Does `rect` intersect any of `rects` (expanded by `margin`)?
 * Pure function (Node-testable) — the safety check that decides between
 * overlay mode and band mode.
 */
export function rectIntersectsAny(rect, rects, margin = 0) {
  return rects.some((r) =>
    rect.x < r.x + r.w + margin &&
    rect.x + rect.w > r.x - margin &&
    rect.y < r.y + r.h + margin &&
    rect.y + rect.h > r.y - margin);
}

/** Compute the summary block's lines, fonts and box size for a page height H. */
function layoutSummary(ctx, H, summary, selectedDate) {
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

  // Split into columns when long, so the block stays shallow.
  const maxRows = 8;
  const columns = [];
  for (let i = 0; i < lines.length; i += maxRows) columns.push(lines.slice(i, i + maxRows));

  const fs = Math.max(14, Math.round(H * 0.021));
  const lineH = Math.round(fs * 1.4);
  const pad = Math.round(fs * 0.8);
  const gap = Math.round(pad * 1.5);

  const colWidths = columns.map((col) => {
    let w = 0;
    for (const l of col) {
      ctx.font = `${l.bold ? '600 ' : ''}${fs}px -apple-system, "Segoe UI", Helvetica, Arial, sans-serif`;
      w = Math.max(w, ctx.measureText(l.text).width);
    }
    return w;
  });
  const boxW = colWidths.reduce((a, b) => a + b, 0) + gap * (columns.length - 1) + pad * 2;
  const boxH = Math.max(...columns.map((c) => c.length)) * lineH + pad * 2;
  return { columns, colWidths, fs, lineH, pad, gap, boxW, boxH };
}

/** Draw the laid-out summary block with its top-left corner at (x0, y0). */
function drawSummaryBox(ctx, x0, y0, L) {
  ctx.save();
  ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
  ctx.strokeStyle = '#1d4ed8';
  ctx.lineWidth = Math.max(2, Math.round(L.fs / 8));
  ctx.beginPath();
  ctx.roundRect(x0, y0, L.boxW, L.boxH, L.pad);
  ctx.fill();
  ctx.stroke();

  let cx = x0 + L.pad;
  L.columns.forEach((col, ci) => {
    let cy = y0 + L.pad + L.fs;
    for (const l of col) {
      ctx.font = `${l.bold ? '600 ' : ''}${L.fs}px -apple-system, "Segoe UI", Helvetica, Arial, sans-serif`;
      ctx.fillStyle = l.color;
      ctx.fillText(l.text, cx, cy);
      cy += L.lineH;
    }
    cx += L.colWidths[ci] + L.gap;
  });
  ctx.restore();
}

/** Viewport-space bounding boxes of every piece of printed text on the page. */
function textRectsInViewport(textContent, viewport) {
  const rects = [];
  for (const it of textContent.items) {
    if (!it.str || it.str.trim() === '') continue;
    const x = it.transform[4];
    const y = it.transform[5];
    const [ax0, ay0, ax1, ay1] = viewport.convertToViewportRectangle(
      [x, y, x + (it.width || 0), y + (it.height || 0)],
    );
    rects.push({
      x: Math.min(ax0, ax1),
      y: Math.min(ay0, ay1),
      w: Math.abs(ax1 - ax0),
      h: Math.abs(ay1 - ay0),
    });
  }
  return rects;
}

/**
 * Render one page; on page 1 add the summary — overlaid into header
 * whitespace when that space is verified empty, otherwise in a new band
 * that extends the canvas above the untouched page.
 * Returns { canvas, mode: 'overlay' | 'band' | null }.
 */
async function renderAnnotatedPage(page, summary, selectedDate, isFirst) {
  const viewport = page.getViewport({ scale: 2 });
  const pageCanvas = document.createElement('canvas');
  pageCanvas.width = Math.floor(viewport.width);
  pageCanvas.height = Math.floor(viewport.height);
  const pctx = pageCanvas.getContext('2d');
  await page.render({ canvasContext: pctx, viewport }).promise;
  if (!isFirst) return { canvas: pageCanvas, mode: null };

  const W = pageCanvas.width;
  const H = pageCanvas.height;
  const L = layoutSummary(pctx, H, summary, selectedDate);

  // Intended overlay spot: top-right header area, like the handwritten notes.
  // A few candidate positions are tried; the box is only ever drawn on a spot
  // verified to contain no printed text.
  const x0 = W - L.boxW - Math.round(W * 0.015);
  const textRects = textRectsInViewport(await page.getTextContent(), viewport);
  for (const yFrac of [0.03, 0.06, 0.09]) {
    const y0 = Math.round(H * yFrac);
    const spot = { x: x0, y: y0, w: L.boxW, h: L.boxH };
    if (!rectIntersectsAny(spot, textRects, Math.round(L.fs / 4))) {
      drawSummaryBox(pctx, x0, y0, L);
      return { canvas: pageCanvas, mode: 'overlay' };
    }
  }

  // Band mode: extend the canvas upward; the original page is not touched.
  const bandPad = Math.round(L.pad * 0.75);
  const bandH = L.boxH + bandPad * 2;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H + bandH;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, bandH);
  drawSummaryBox(ctx, x0, bandPad, layoutSummary(ctx, H, summary, selectedDate));
  ctx.strokeStyle = '#c8ccd2';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, bandH - 1);
  ctx.lineTo(W, bandH - 1);
  ctx.stroke();
  ctx.drawImage(pageCanvas, 0, bandH);
  return { canvas, mode: 'band' };
}

/**
 * Prepare and print every readable uploaded PDF, page by page, with the
 * per-file summary added to each file's first page.
 *
 * No popup window: real Safari popup blockers were eating the tab, so the
 * document prints from a hidden same-page iframe (see printHtml) and the
 * print dialog opens only once every page image has decoded.
 *
 * files: [{ name, doc, records }] (pdf.js doc); selectedDate: ISO.
 * ui (optional): { status(text), bar(fraction), fileDone(index),
 * thumbnail(dataUrl), cancelled() → bool } — drives the in-page progress
 * overlay; returning true from cancelled() aborts cleanly. thumbnail
 * receives a small (~240px) preview of each page as it renders; callers
 * should REPLACE the previous image, never accumulate.
 * Resolves true when the print dialog was opened, false when cancelled.
 */
export async function openAnnotatedSheets(files, selectedDate, ui = {}) {
  const readable = files.filter((f) => f.doc);
  const totalPages = readable.reduce((a, f) => a + f.doc.numPages, 0);

  const sections = [];
  let donePages = 0;
  for (let fi = 0; fi < readable.length; fi++) {
    const f = readable[fi];
    const summary = buildFileSummary(f.records, selectedDate);
    const imgs = [];
    for (let p = 1; p <= f.doc.numPages; p++) {
      if (ui.cancelled?.()) return false;
      ui.status?.(`Rendering ${f.name} — page ${p} of ${f.doc.numPages}…`);
      const page = await f.doc.getPage(p);
      const { canvas } = await renderAnnotatedPage(page, summary, selectedDate, p === 1);
      imgs.push({
        src: canvas.toDataURL('image/jpeg', 0.85),
        landscape: canvas.width > canvas.height,
      });
      if (ui.thumbnail) {
        // Deliberately tiny: a dedicated ~240px canvas at modest JPEG
        // quality, regenerated per page — never the full-size dataURL.
        const t = document.createElement('canvas');
        t.width = 240;
        t.height = Math.round((canvas.height / canvas.width) * 240);
        t.getContext('2d').drawImage(canvas, 0, 0, t.width, t.height);
        ui.thumbnail(t.toDataURL('image/jpeg', 0.7));
      }
      donePages += 1;
      ui.bar?.(donePages / totalPages);
    }
    ui.fileDone?.(fi);
    sections.push({ name: f.name, imgs });
  }
  if (ui.cancelled?.()) return false;
  ui.status?.('Opening print dialog…');

  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const body = sections.map((s) =>
    s.imgs.map((im) => `<img class="${im.landscape ? 'landscape' : 'portrait'}" src="${im.src}" alt="${esc(s.name)}">`).join('\n'),
  ).join('\n');

  await printHtml(`<!DOCTYPE html><html><head><meta charset="utf-8">
  <title>Arrival sheets — ${esc(formatDisplayDate(selectedDate))}</title>
  <style>
    body { margin: 0; }
    img { display: block; width: 100%; page-break-after: always; }
    img:last-child { page-break-after: auto; }
    @page { size: landscape; margin: 0.4cm; }
  </style></head><body>${body}</body></html>`);
  return true;
}
