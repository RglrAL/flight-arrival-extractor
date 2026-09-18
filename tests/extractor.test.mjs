// Synthetic-page tests for the #1 requirement: rows are reconstructed from
// coordinates, and a passenger can never inherit cells from an adjacent row.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractRowsFromPage, extractRowsFromPages } from '../js/extractor.js';
import { toPassengerRecords } from '../js/validate.js';

// Column x-positions mirroring the real reports.
const X = { name: 5, booking: 149, flight: 257, time: 338, city: 509, date: 639 };

function headerItems(y) {
  return [
    { str: 'Passenger Name', x: X.name, y, w: 62, h: 9 },
    { str: 'Booking ID', x: X.booking, y, w: 39, h: 9 },
    { str: 'Flight Number', x: X.flight, y, w: 50, h: 9 },
    { str: 'Time of Arrival', x: X.time, y, w: 52, h: 9 },
    { str: 'Arrival City', x: X.city, y, w: 39, h: 9 },
    { str: 'Date of Arrival', x: X.date, y, w: 51, h: 9 },
  ];
}

function rowItems(y, cells) {
  const items = [];
  for (const [col, str] of Object.entries(cells)) {
    if (str) items.push({ str, x: X[col], y, w: str.length * 4, h: 9 });
  }
  return items;
}

function makePage(rows, { pageNumber = 1, total = null } = {}) {
  const items = [...headerItems(700)];
  let y = 690;
  for (const cells of rows) {
    items.push(...rowItems(y, cells));
    y -= 12;
  }
  if (total != null) {
    items.push({ str: `Total Number of Passenger : ${total}`, x: 30, y: y - 10, w: 150, h: 9 });
  }
  items.push({ str: '@ Copyright TTS 2026, 2027. All Rights Reserved', x: 6, y: 20, w: 180, h: 8 });
  items.push({ str: 'Page 1 of 1', x: 671, y: 20, w: 41, h: 8 });
  return { pageNumber, items };
}

test('reconstructs complete rows with cells kept together', () => {
  const page = makePage([
    { name: 'Mr Smith, John', booking: 'TT / A1', flight: 'AC/800', time: '08:15', city: 'Dublin', date: '13-SEP-26' },
    { name: 'Mrs Smith, Mary', booking: 'TT / A1', flight: 'AC/800', time: '08:15', city: 'Dublin', date: '13-SEP-26' },
  ]);
  const { rows } = extractRowsFromPage(page);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0].cells, {
    name: 'Mr Smith, John', booking: 'TT / A1', flight: 'AC/800',
    time: '08:15', city: 'Dublin', date: '13-SEP-26',
  });
});

test('CRITICAL: blank cells stay blank — no inheritance from adjacent rows (brief §30)', () => {
  const page = makePage([
    { name: 'Mr Above, Person', booking: 'TT / A1', flight: 'EI/124', time: '10:35', city: 'Dublin', date: '12-SEP-26' },
    { name: 'Mr Blank, Person', booking: 'TT / A2' }, // no flight/time/city/date
    { name: 'Mr Below, Person', booking: 'TT / A3', flight: 'AC/800', time: '08:15', city: 'Dublin', date: '13-SEP-26' },
  ]);
  const { rows } = extractRowsFromPage(page);
  assert.equal(rows.length, 3);
  const blank = rows[1];
  assert.equal(blank.cells.name, 'Mr Blank, Person');
  assert.equal(blank.cells.flight, '');
  assert.equal(blank.cells.time, '');
  assert.equal(blank.cells.date, '');
  // Neighbours keep their own values.
  assert.equal(rows[0].cells.date, '12-SEP-26');
  assert.equal(rows[2].cells.date, '13-SEP-26');
});

test('columns arriving in scrambled text order still land on the right rows', () => {
  // Simulates the real failure mode: the text stream delivers items
  // column-by-column, not row-by-row. Coordinates must fix it.
  const items = [...headerItems(700)];
  // names first
  items.push({ str: 'Mr First, P', x: X.name, y: 690, w: 50, h: 9 });
  items.push({ str: 'Mr Second, P', x: X.name, y: 678, w: 50, h: 9 });
  // then dates, deliberately in reverse row order
  items.push({ str: '13-SEP-26', x: X.date, y: 678, w: 39, h: 9 });
  items.push({ str: '12-SEP-26', x: X.date, y: 690, w: 39, h: 9 });
  // then flights
  items.push({ str: 'AC/800', x: X.flight, y: 690, w: 25, h: 9 });
  items.push({ str: 'AC/800', x: X.flight, y: 678, w: 25, h: 9 });
  const { rows } = extractRowsFromPage({ pageNumber: 1, items });
  assert.equal(rows[0].cells.name, 'Mr First, P');
  assert.equal(rows[0].cells.date, '12-SEP-26');
  assert.equal(rows[1].cells.name, 'Mr Second, P');
  assert.equal(rows[1].cells.date, '13-SEP-26');
});

test('items straddling a column boundary are flagged for review, not guessed', () => {
  const page = makePage([]);
  page.items.push({ str: 'Mr Wide, Person', x: X.name, y: 690, w: 60, h: 9 });
  // An item that starts in the flight band but runs deep into the time band.
  page.items.push({ str: 'AC/800    08:15', x: X.flight, y: 690, w: 120, h: 9 });
  const { rows } = extractRowsFromPage(page);
  assert.equal(rows.length, 1);
  assert.ok(rows[0].flags.includes('band-straddle'));
  const [rec] = toPassengerRecords({ rows, fileWarnings: [] });
  assert.equal(rec.reviewRequired, true);
});

test('page furniture (copyright, totals, page numbers) is not a passenger', () => {
  const page = makePage(
    [{ name: 'Mr Only, Person', booking: 'TT / A1', flight: 'EI/86', time: '08:15', city: 'Dublin', date: '20-SEP-26' }],
    { total: 1 },
  );
  const { rows, statedTotal } = extractRowsFromPage(page);
  assert.equal(rows.length, 1);
  assert.equal(statedTotal, 1);
});

test('stated-total cross-check flags a mismatch at file level', () => {
  const page = makePage(
    [{ name: 'Mr Only, Person', booking: 'TT / A1', flight: 'EI/86', time: '08:15', city: 'Dublin', date: '20-SEP-26' }],
    { total: 5 },
  );
  const { fileWarnings } = extractRowsFromPages([page], 'x.pdf');
  assert.ok(fileWarnings.includes('count-mismatch'));
});

test('a stated-total mismatch is a file-level warning; rows are not individually flagged', () => {
  const page = makePage(
    [{ name: 'Mr Only, Person', booking: 'TT / A1', flight: 'EI/86', time: '08:15', city: 'Dublin', date: '20-SEP-26' }],
    { total: 5 },
  );
  const extraction = extractRowsFromPages([page], 'x.pdf');
  assert.ok(extraction.fileWarnings.includes('count-mismatch'));
  const [rec] = toPassengerRecords(extraction);
  // The reconstructed row itself is fine — a mismatch means a row may be
  // MISSING from extraction, not that this row is wrong.
  assert.equal(rec.reviewRequired, false);
});

test('a file with no text layer is reported, never silently empty', () => {
  const { rows, fileWarnings } = extractRowsFromPages([{ pageNumber: 1, items: [] }], 'scanned.pdf');
  assert.equal(rows.length, 0);
  assert.ok(fileWarnings.includes('no-text-layer'));
});

test('wrapped long names merge into the row above — name only, no other cells', () => {
  const page = makePage([
    { name: 'Mrs Champeau Swenson, Tonie', booking: 'IV / A780478', flight: 'AA/132', time: '12:55', city: 'Dublin', date: '19-SEP-26' },
    { name: 'Lorraine' }, // wrapped second line of the name
    { name: 'Mrs Corcoran, Barbara Louise', booking: 'BV / A273234', flight: 'UA/228', time: '08:05', city: 'Dublin', date: '19-SEP-26' },
  ]);
  const { rows } = extractRowsFromPage(page);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].cells.name, 'Mrs Champeau Swenson, Tonie Lorraine');
  assert.ok(rows[0].flags.includes('wrapped-name'));
  // The continuation merged ONLY the name — flight/date untouched.
  assert.equal(rows[0].cells.flight, 'AA/132');
  assert.equal(rows[1].cells.name, 'Mrs Corcoran, Barbara Louise');
});

test('a name-only row WITH an honorific is a real (incomplete) passenger, not a continuation', () => {
  const page = makePage([
    { name: 'Mr Complete, Person', booking: 'TT / A1', flight: 'EI/86', time: '08:15', city: 'Dublin', date: '20-SEP-26' },
    { name: 'Mr Alone, Person' },
  ]);
  const { rows } = extractRowsFromPage(page);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].cells.name, 'Mr Alone, Person');
});

test('a continuation-looking row with any other cell filled is NOT merged', () => {
  const page = makePage([
    { name: 'Mr Complete, Person', booking: 'TT / A1', flight: 'EI/86', time: '08:15', city: 'Dublin', date: '20-SEP-26' },
    { name: 'Oddline', date: '21-SEP-26' }, // has a date → must stay its own flagged row
  ]);
  const { rows } = extractRowsFromPage(page);
  assert.equal(rows.length, 2);
  assert.ok(rows[1].flags.includes('unusual-name'));
  assert.equal(rows[0].cells.date, '20-SEP-26'); // untouched
});

test('rows without a name cell are flagged, never merged into a neighbour', () => {
  const page = makePage([
    { name: 'Mr Normal, Person', booking: 'TT / A1', flight: 'EI/86', time: '08:15', city: 'Dublin', date: '20-SEP-26' },
    { booking: 'TT / A9', flight: 'EI/99', time: '09:00', city: 'Dublin', date: '20-SEP-26' }, // no name
  ]);
  const { rows } = extractRowsFromPage(page);
  assert.equal(rows.length, 2);
  assert.ok(rows[1].flags.includes('no-name-cell'));
  // The stray flight did NOT attach to Mr Normal.
  assert.equal(rows[0].cells.flight, 'EI/86');
});
