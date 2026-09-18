// Row-aware extraction of Passenger Arrival Details tables.
//
// The #1 rule (brief §6, §30): a passenger's flight/time/city/date are ONLY
// what physically sits on that passenger's visual row, determined by x/y
// coordinates. Cells are never inferred from adjacent rows, array positions,
// or majority values. Blank cells stay blank by construction.
//
// Input is a plain "positioned items" model so the same code runs in the
// browser (pdf.js) and in Node tests.

const COLUMNS = ['name', 'booking', 'flight', 'time', 'city', 'date'];

const HEADER_LABELS = [
  { col: 'name', label: 'Passenger Name' },
  { col: 'booking', label: 'Booking ID' },
  { col: 'flight', label: 'Flight Number' },
  { col: 'time', label: 'Time of Arrival' },
  { col: 'city', label: 'Arrival City' },
  { col: 'date', label: 'Date of Arrival' },
];

// Lines below the header that are page furniture, not passenger rows.
const NON_DATA_PATTERNS = [
  /^@?\s*Copyright/i,
  /All Rights Reserved/i,
  /For Internal Use Only/i,
  /^Page \d+ of \d+$/i,
  /^Total Number of Passenger/i,
  /^Operating Product Code/i,
  /^Passenger Arrival Details/i,
  /^Date:\s/i,
];

const TITLE_RE = /^(Mr|Mrs|Ms|Miss|Mstr|Master|Dr|Prof|Rev|Sir|Lady|Mx|Fr|Sr)\b/i;

const Y_TOLERANCE = 3; // items within this vertical distance are the same row
const BAND_SLACK = 4;  // a cell may start slightly left of its header label

/**
 * Adapt a pdf.js TextContent object into the plain page model:
 * { pageNumber, items: [{ str, x, y, w, h }] }.
 * pdf.js y-origin is bottom-left; y decreases down the page.
 */
export function pageFromPdfjsTextContent(textContent, pageNumber) {
  const items = [];
  for (const it of textContent.items) {
    if (!it.str || it.str.trim() === '') continue;
    items.push({
      str: it.str,
      x: it.transform[4],
      y: it.transform[5],
      w: it.width || 0,
      h: it.height || 0,
    });
  }
  return { pageNumber, items };
}

/** Cluster items into visual lines by y proximity. Returns lines top-first. */
function clusterLines(items) {
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];
  let current = null;
  for (const it of sorted) {
    if (current && Math.abs(current.y - it.y) <= Y_TOLERANCE) {
      current.items.push(it);
    } else {
      current = { y: it.y, items: [it] };
      lines.push(current);
    }
  }
  for (const line of lines) line.items.sort((a, b) => a.x - b.x);
  return lines;
}

function lineText(line) {
  return line.items.map((it) => it.str).join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * Find the table header line and derive column x start positions from the
 * actual label positions on the page (never hard-coded).
 * Returns { headerY, columnStarts: {name, booking, ...} } or null.
 */
function findHeader(lines) {
  for (const line of lines) {
    const text = lineText(line);
    if (!HEADER_LABELS.every(({ label }) => text.includes(label))) continue;

    const columnStarts = {};
    for (const { col, label } of HEADER_LABELS) {
      // Prefer an item that starts with the label text.
      let x = null;
      for (const it of line.items) {
        if (it.str.trim().startsWith(label)) { x = it.x; break; }
      }
      if (x == null) {
        // Label may sit inside a longer item; estimate x from character offset.
        for (const it of line.items) {
          const idx = it.str.indexOf(label);
          if (idx >= 0) {
            x = it.x + (it.w * idx) / it.str.length;
            break;
          }
        }
      }
      if (x == null) { columnStarts[col] = null; break; }
      columnStarts[col] = x;
    }
    if (COLUMNS.every((c) => typeof columnStarts[c] === 'number')) {
      // Sanity: columns must appear left-to-right in the expected order.
      const xs = COLUMNS.map((c) => columnStarts[c]);
      if (xs.every((v, i) => i === 0 || v > xs[i - 1])) {
        return { headerY: line.y, columnStarts };
      }
    }
  }
  return null;
}

/** Which column does an item starting at x belong to? */
function columnAt(x, columnStarts) {
  let col = null;
  for (const c of COLUMNS) {
    if (x >= columnStarts[c] - BAND_SLACK) col = c;
  }
  return col; // null => left of the name column
}

/**
 * Extract passenger rows from one page.
 * Returns { rows, statedTotal, hadHeader, hadText }.
 * Each row: {
 *   cells: { name, booking, flight, time, city, date }  (raw strings, '' when blank)
 *   page, y,
 *   cellBoxes: { name: {x,y,w,h}, ... }                  (pdf-space, for preview highlight)
 *   flags: [ 'band-straddle', 'no-name-cell', 'unusual-name', ... ]
 * }
 */
export function extractRowsFromPage(page) {
  const result = { rows: [], statedTotal: null, hadHeader: false, hadText: page.items.length > 0 };
  if (!result.hadText) return result;

  const lines = clusterLines(page.items);

  // The PDF's own passenger total (used only as a cross-check, never as data).
  for (const line of lines) {
    const m = lineText(line).match(/Total Number of Passenger\s*:?\s*(\d+)/i);
    if (m) { result.statedTotal = parseInt(m[1], 10); break; }
  }

  const header = findHeader(lines);
  if (!header) return result;
  result.hadHeader = true;
  const { headerY, columnStarts } = header;

  for (const line of lines) {
    if (line.y >= headerY - Y_TOLERANCE) continue; // header and everything above
    const text = lineText(line);
    if (text === '') continue;
    if (NON_DATA_PATTERNS.some((re) => re.test(text))) continue;

    const cellItems = { name: [], booking: [], flight: [], time: [], city: [], date: [] };
    const flags = [];

    for (const it of line.items) {
      const col = columnAt(it.x, columnStarts);
      if (col == null) { flags.push('item-left-of-table'); continue; }
      // An item whose text extends well into the next column suggests the
      // layout differs from what the header implies — needs human review.
      const colIdx = COLUMNS.indexOf(col);
      const next = COLUMNS[colIdx + 1];
      if (next && it.x + it.w > columnStarts[next] + BAND_SLACK * 2) {
        flags.push('band-straddle');
      }
      cellItems[col].push(it);
    }

    const cells = {};
    const cellBoxes = {};
    for (const col of COLUMNS) {
      const its = cellItems[col];
      cells[col] = its.map((it) => it.str).join(' ').replace(/\s+/g, ' ').trim();
      if (its.length > 0) {
        const x0 = Math.min(...its.map((it) => it.x));
        const x1 = Math.max(...its.map((it) => it.x + it.w));
        const y0 = Math.min(...its.map((it) => it.y));
        const h = Math.max(...its.map((it) => it.h), 8);
        cellBoxes[col] = { x: x0, y: y0, w: x1 - x0, h };
      }
    }

    if (cells.name === '') {
      // Fragments with no name cell are never merged into a neighbouring row.
      flags.push('no-name-cell');
    } else if (!TITLE_RE.test(cells.name)) {
      flags.push('unusual-name');
    }

    // Long passenger names wrap onto a second line in these reports
    // (e.g. "Mrs Champeau Swenson, Tonie" / "Lorraine"). A line counts as a
    // name continuation ONLY when it is name-band text alone — no honorific,
    // every other cell empty — directly below a normal passenger row. Only the
    // name is merged; flight/date/time cells are untouched, and the stated-
    // total cross-check would still expose a wrong merge.
    const prev = result.rows[result.rows.length - 1];
    const isContinuation =
      cells.name !== '' &&
      !TITLE_RE.test(cells.name) &&
      COLUMNS.every((c) => c === 'name' || cells[c] === '') &&
      prev !== undefined &&
      prev.cells.name !== '' &&
      TITLE_RE.test(prev.cells.name);

    if (isContinuation) {
      prev.cells.name = `${prev.cells.name} ${cells.name}`;
      if (prev.cellBoxes.name && cellBoxes.name) {
        const a = prev.cellBoxes.name;
        const b = cellBoxes.name;
        const x0 = Math.min(a.x, b.x);
        const x1 = Math.max(a.x + a.w, b.x + b.w);
        const y0 = Math.min(a.y, b.y);
        const y1 = Math.max(a.y + a.h, b.y + b.h);
        prev.cellBoxes.name = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
      }
      if (!prev.flags.includes('wrapped-name')) prev.flags.push('wrapped-name');
      continue;
    }

    result.rows.push({ cells, page: page.pageNumber, y: line.y, cellBoxes, flags });
  }
  return result;
}

/**
 * Extract all passenger rows from a document's pages.
 * pages: [{ pageNumber, items }] — from pageFromPdfjsTextContent().
 * Returns {
 *   rows, statedTotal,
 *   fileWarnings: [ 'no-text-layer', 'no-header-found', 'count-mismatch' ],
 * }
 */
export function extractRowsFromPages(pages, sourceFile) {
  const rows = [];
  let statedTotal = null;
  let anyText = false;
  let anyHeader = false;

  for (const page of pages) {
    const r = extractRowsFromPage(page);
    anyText = anyText || r.hadText;
    anyHeader = anyHeader || r.hadHeader;
    if (r.statedTotal != null) statedTotal = r.statedTotal;
    for (const row of r.rows) {
      rows.push({ ...row, sourceFile, sourceRow: rows.length + 1 });
    }
  }

  const fileWarnings = [];
  if (!anyText) fileWarnings.push('no-text-layer');
  else if (!anyHeader) fileWarnings.push('no-header-found');
  const namedRows = rows.filter((r) => r.cells.name !== '').length;
  if (statedTotal != null && namedRows !== statedTotal) fileWarnings.push('count-mismatch');

  return { rows, statedTotal, fileWarnings };
}
