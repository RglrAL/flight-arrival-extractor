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
import { terminalFor, tdFromFileName, pickupBand, PICKUP_BANDS } from './ui-data.js';

// Summary "ink" colours (print is always on white paper). Terminal is
// double-encoded — the T1/T2 label carries the information, colour just
// makes the split scannable; lines with no known terminal stay neutral.
const INK = {
  head: '#b02a37',     // date + totals (red, like the pen original)
  td: '#334155',       // tour director line
  T1: '#047857',       // Terminal 1 flights — green
  T2: '#1d4ed8',       // Terminal 2 flights — blue
  neutral: '#334155',  // unknown terminal — no colour claim
  warn: '#8a5a00',
};

/**
 * Per-file summary of a selected date, from that file's validated records.
 * Pure function (Node-testable).
 * Returns { flights: [{ time, flightNumber, arrivalCity, count }], total,
 * incomplete, cutoff } — flights time-sorted, total = passengers with a
 * flight+time on the date, incomplete = passengers dated that day but with
 * no flight/time on their row. When `cutoff` (HH:MM) is given, flights at
 * or after it are excluded (the operation's day ends at 1pm).
 */
export function buildFileSummary(records, selectedDate, cutoff = null) {
  const onDate = records.filter((r) => r.arrivalDate === selectedDate);
  const scheduled = onDate.filter((r) =>
    r.flightNumber != null && r.arrivalTime != null && (cutoff == null || r.arrivalTime < cutoff));
  const incomplete = onDate.filter((r) => r.flightNumber == null || r.arrivalTime == null).length;

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
  return { flights, total: scheduled.length, incomplete, cutoff };
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

/**
 * Compute the summary block's lines, fonts and box size for a page height H.
 * maxBoxH caps the block's height: the column split adapts (more, shorter
 * columns) so the box fits the space between the TD line and the table.
 */
function layoutSummary(ctx, H, summary, selectedDate, maxBoxH = Infinity) {
  const showCity = new Set(summary.flights.map((f) => f.arrivalCity ?? '')).size > 1;
  const lines = [];
  lines.push({ text: formatDisplayDate(selectedDate), color: INK.head, bold: true });
  if (summary.flights.length === 0) {
    lines.push({ text: 'No arrivals this date in this report', color: INK.T2, bold: false });
  } else {
    const termCounts = { T1: 0, T2: 0 };
    for (const f of summary.flights) {
      const city = showCity && f.arrivalCity ? `  (${f.arrivalCity})` : '';
      const term = terminalFor(f.flightNumber, f.arrivalCity);
      if (term) termCounts[term] += f.count;
      lines.push({
        text: `${f.time}   ${f.flightNumber}${city}   × ${f.count}${term ? `   ${term}` : ''}`,
        color: term ? INK[term] : INK.neutral,
        bold: true,
        // Same highlighter colour as the flight's rows in the table below.
        bg: pickupBand(f.time)?.color ?? null,
      });
    }
    const both = termCounts.T1 > 0 && termCounts.T2 > 0;
    const cutoffNote = summary.cutoff ? ' (to 1pm)' : '';
    lines.push({
      text: `Total: ${summary.total} passenger${summary.total === 1 ? '' : 's'}${cutoffNote}${both ? `  ·  T1 ${termCounts.T1} · T2 ${termCounts.T2}` : ''}`,
      color: INK.head, bold: true,
    });
  }
  if (summary.incomplete > 0) {
    lines.push({ text: `⚠ +${summary.incomplete} dated this day, no flight on row`, color: INK.warn, bold: false });
  }

  const fs = Math.max(14, Math.round(H * 0.021));
  const lineH = Math.round(fs * 1.4);
  const pad = Math.round(fs * 0.8);
  const gap = Math.round(pad * 1.5);

  // Split into columns when long, so the block stays shallow — and never
  // taller than the available space (minimum 4 rows per column).
  const maxRows = Math.min(8, Math.max(4, Math.floor((maxBoxH - pad * 2) / lineH)));
  const columns = [];
  for (let i = 0; i < lines.length; i += maxRows) columns.push(lines.slice(i, i + maxRows));

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
      if (l.bg) {
        ctx.fillStyle = l.bg;
        ctx.beginPath();
        ctx.roundRect(cx - Math.round(L.pad * 0.35), cy - L.fs, L.colWidths[ci] + Math.round(L.pad * 0.7), L.lineH, 4);
        ctx.fill();
      }
      ctx.font = `${l.bold ? '600 ' : ''}${L.fs}px -apple-system, "Segoe UI", Helvetica, Arial, sans-serif`;
      ctx.fillStyle = l.color;
      ctx.fillText(l.text, cx, cy);
      cy += L.lineH;
    }
    cx += L.colWidths[ci] + L.gap;
  });
  ctx.restore();
}

/** Viewport-space text items ({ str, rect }) for every piece of printed text. */
function textItemsInViewport(textContent, viewport) {
  const items = [];
  for (const it of textContent.items) {
    if (!it.str || it.str.trim() === '') continue;
    const x = it.transform[4];
    const y = it.transform[5];
    const [ax0, ay0, ax1, ay1] = viewport.convertToViewportRectangle(
      [x, y, x + (it.width || 0), y + (it.height || 0)],
    );
    items.push({
      str: it.str,
      rect: {
        x: Math.min(ax0, ax1),
        y: Math.min(ay0, ay1),
        w: Math.abs(ax1 - ax0),
        h: Math.abs(ay1 - ay0),
      },
    });
  }
  return items;
}

/**
 * Placement for "TD: <name>", centered at the very top of the page (small
 * gap from the edge). Computed before the summary box so the box avoids it.
 */
function tdPlacement(ctx, W, H, tdName) {
  const fs = Math.max(16, Math.round(H * 0.024));
  const baselineY = Math.round(H * 0.012) + fs;
  ctx.save();
  ctx.font = `600 ${fs}px -apple-system, "Segoe UI", Helvetica, Arial, sans-serif`;
  const text = `TD: ${tdName}`;
  const tw = ctx.measureText(text).width;
  ctx.restore();
  const pad = Math.round(fs * 0.45);
  return {
    text, fs, baselineY, pad,
    rect: {
      x: W / 2 - tw / 2 - pad,
      y: baselineY - fs - pad * 0.6,
      w: tw + pad * 2,
      h: fs + pad * 1.3,
    },
  };
}

function drawTd(ctx, W, td) {
  ctx.save();
  ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
  ctx.beginPath();
  ctx.roundRect(td.rect.x, td.rect.y, td.rect.w, td.rect.h, 6);
  ctx.fill();
  ctx.font = `600 ${td.fs}px -apple-system, "Segoe UI", Helvetica, Arial, sans-serif`;
  ctx.fillStyle = INK.td;
  ctx.textAlign = 'center';
  ctx.fillText(td.text, W / 2, td.baselineY);
  ctx.restore();
}

/**
 * Highlighter over the table rows whose own Date of Arrival matches the
 * selected date, coloured by pick-up band. 'multiply' blending keeps the
 * printed text crisp under the ink, exactly like a real highlighter pen.
 */
function drawRowHighlights(ctx, viewport, highlights) {
  if (highlights.length === 0) return;
  ctx.save();
  ctx.globalCompositeOperation = 'multiply';
  for (const h of highlights) {
    const b = h.rect;
    const [ax0, ay0, ax1, ay1] = viewport.convertToViewportRectangle([b.x, b.y, b.x + b.w, b.y + b.h]);
    ctx.fillStyle = h.color;
    ctx.fillRect(Math.min(ax0, ax1) - 3, Math.min(ay0, ay1) - 2, Math.abs(ax1 - ax0) + 6, Math.abs(ay1 - ay0) + 4);
  }
  ctx.restore();
}

/**
 * 2-column × 3-row handwriting grid below the "Passenger Arrival Details"
 * heading: pickup times on the left, wide blank cells on the right for
 * hand-written figures. Placed between the title and the Operating Product
 * Code line, shifted left when the summary box occupies the centre.
 */
function drawPickupGrid(ctx, W, H, textItems, boxRect) {
  const title = textItems
    .filter((t) => t.str.trim() === 'Passenger Arrival Details')
    .sort((a, b) => b.rect.w - a.rect.w)[0];
  const titleBottom = title ? title.rect.y + title.rect.h : Math.round(H * 0.14);
  const op = textItems.find((t) => t.str.trim().startsWith('Operating Product Code'));
  const opTop = op ? op.rect.y : Math.round(H * 0.27);

  const yTop = titleBottom + Math.round(H * 0.012);
  const availH = opTop - yTop - 8;
  const rowH = Math.max(26, Math.min(48, Math.floor(availH / 3)));
  const gridH = rowH * 3;
  const labelW = Math.round(W * 0.075);
  let gridW = labelW + Math.round(W * 0.17);

  // Placement: centred under the title; the summary box always wins a
  // collision. Slide left → shrink the writing column → as a last resort
  // sit (white-backed) over the letterhead. Never overlap the box.
  const minLeft = Math.round(W * 0.22); // preferred: stay clear of the letterhead
  let gx = (title ? title.rect.x + title.rect.w / 2 : W / 2) - gridW / 2;
  if (boxRect && rectIntersectsAny({ x: gx, y: yTop, w: gridW, h: gridH }, [boxRect], 8)) {
    gx = boxRect.x - gridW - 14;
    if (gx < minLeft) {
      const maxW = boxRect.x - 14 - minLeft;
      if (maxW >= labelW + Math.round(W * 0.08)) {
        gridW = maxW;
        gx = minLeft;
      } else {
        gx = Math.round(W * 0.015);
        gridW = Math.min(gridW, boxRect.x - 14 - gx);
      }
    }
  }

  const fs = Math.round(rowH * 0.42);
  ctx.save();
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(gx, yTop, gridW, gridH);
  ctx.strokeStyle = INK.td;
  ctx.lineWidth = 2;
  ctx.strokeRect(gx, yTop, gridW, gridH);
  ctx.beginPath();
  ctx.moveTo(gx + labelW, yTop);
  ctx.lineTo(gx + labelW, yTop + gridH);
  for (let r = 1; r < 3; r++) {
    ctx.moveTo(gx, yTop + rowH * r);
    ctx.lineTo(gx + gridW, yTop + rowH * r);
  }
  ctx.stroke();
  ctx.font = `600 ${fs}px -apple-system, "Segoe UI", Helvetica, Arial, sans-serif`;
  ctx.textAlign = 'left';
  ctx.fillStyle = INK.td;
  // Plain pickup-time labels — no colour swatches: the grid shows pickup
  // times while highlight colours mark arrival windows, and pairing them
  // implied a mapping that doesn't tally.
  PICKUP_BANDS.forEach((band, r) => {
    ctx.fillText(band.label, gx + Math.round(fs * 0.6), yTop + rowH * r + Math.round(rowH * 0.62));
  });
  ctx.restore();
}

/**
 * Render one page; on page 1 the summary is drawn ONTO the header area of
 * the sheet itself — like the original handwritten workflow. Candidate
 * positions are tried against the page's text coordinates to pick the
 * emptiest spot; if none is fully clear the default spot is used anyway
 * (the backing is translucent, so covered print stays faintly visible —
 * exactly like ink over the header).
 * Returns { canvas, mode: 'overlay' | null }.
 */
async function renderAnnotatedPage(page, textContent, summary, selectedDate, isFirst, tdName = null, highlights = []) {
  const viewport = page.getViewport({ scale: 2 });
  const pageCanvas = document.createElement('canvas');
  pageCanvas.width = Math.floor(viewport.width);
  pageCanvas.height = Math.floor(viewport.height);
  const pctx = pageCanvas.getContext('2d');
  await page.render({ canvasContext: pctx, viewport }).promise;
  drawRowHighlights(pctx, viewport, highlights);

  const W = pageCanvas.width;
  const H = pageCanvas.height;
  const td = tdName ? tdPlacement(pctx, W, H, tdName) : null;
  if (!isFirst) {
    // Subsequent pages still carry the TD name at the top.
    if (td) drawTd(pctx, W, td);
    return { canvas: pageCanvas, mode: null };
  }

  const textItems = textItemsInViewport(textContent, viewport);
  const textRects = textItems.map((t) => t.rect);

  // The box lives between the TD line and the table's own header row.
  const tableHeader = textItems.find((t) => t.str.trim() === 'Passenger Name');
  const tableTop = tableHeader ? tableHeader.rect.y : Math.round(H * 0.34);
  const yFloor = td ? Math.round(td.rect.y + td.rect.h + 8) : Math.round(H * 0.03);
  const L = layoutSummary(pctx, H, summary, selectedDate, tableTop - yFloor - 10);

  // Overlay spot: top-right header area, like the handwritten notes. A few
  // candidate positions are tried to find a spot clear of printed text; when
  // none is fully clear, the topmost allowed spot is used regardless — the
  // summary belongs ON the sheet (per Alan), as the pen version wrote over
  // the header. It never covers the TD line or the table's header row.
  const x0 = W - L.boxW - Math.round(W * 0.015);
  const obstacles = td ? [...textRects, td.rect] : textRects;
  let y0 = yFloor;
  for (const dy of [0, Math.round(H * 0.03), Math.round(H * 0.06)]) {
    const y = yFloor + dy;
    if (y + L.boxH > tableTop - 4) break;
    if (!rectIntersectsAny({ x: x0, y, w: L.boxW, h: L.boxH }, obstacles, Math.round(L.fs / 4))) {
      y0 = y;
      break;
    }
  }
  const boxRect = { x: x0, y: y0, w: L.boxW, h: L.boxH };
  drawSummaryBox(pctx, x0, y0, L);
  if (td) drawTd(pctx, W, td);
  drawPickupGrid(pctx, W, H, textItems, boxRect);
  return { canvas: pageCanvas, mode: 'overlay' };
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

  const CUTOFF = '13:00'; // the operation's day ends at 1pm

  const sections = [];
  let donePages = 0;
  for (let fi = 0; fi < readable.length; fi++) {
    const f = readable[fi];
    const summary = buildFileSummary(f.records, selectedDate, CUTOFF);
    const imgs = [];
    for (let p = 1; p <= f.doc.numPages; p++) {
      if (ui.cancelled?.()) return false;
      ui.status?.(`Rendering ${f.name} — page ${p} of ${f.doc.numPages}…`);
      const page = await f.doc.getPage(p);
      const textContent = await page.getTextContent();
      // Genuinely blank PDF pages are dropped from the print.
      if (!textContent.items.some((it) => it.str && it.str.trim() !== '')) {
        donePages += 1;
        ui.bar?.(donePages / totalPages);
        continue;
      }
      // Rows on this page whose own date matches (and land before the 1pm
      // cutoff) → highlighter in their pick-up band's colour.
      const highlights = (f.records || [])
        .filter((r) => r.sourcePage === p && r.arrivalDate === selectedDate
          && r.arrivalTime && r.arrivalTime < CUTOFF && r.geometry?.cellBoxes)
        .map((r) => {
          const boxes = Object.values(r.geometry.cellBoxes);
          if (boxes.length === 0) return null;
          const x0 = Math.min(...boxes.map((b) => b.x));
          const x1 = Math.max(...boxes.map((b) => b.x + b.w));
          const y0 = Math.min(...boxes.map((b) => b.y));
          const y1 = Math.max(...boxes.map((b) => b.y + b.h));
          return { rect: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, color: pickupBand(r.arrivalTime).color };
        })
        .filter(Boolean);
      const { canvas } = await renderAnnotatedPage(page, textContent, summary, selectedDate, p === 1, tdFromFileName(f.name), highlights);
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

  // Title doubles as the suggested filename when saving the print as PDF.
  const title = `Arrival sheets ${selectedDate}`;
  await printHtml(`<!DOCTYPE html><html><head><meta charset="utf-8">
  <title>${esc(title)}</title>
  <style>
    body { margin: 0; }
    /* Constrain both dimensions so a page image can never spill onto (and
       create) an extra blank sheet, whatever the paper size. */
    img { display: block; margin: 0 auto; max-width: 100%; max-height: 98vh; object-fit: contain; page-break-after: always; break-inside: avoid; }
    img:last-child { page-break-after: auto; }
    @page { size: landscape; margin: 0.4cm; }
  </style></head><body>${body}</body></html>`, title);
  return true;
}
