// Integration tests against the real sample reports (kept OUT of git for
// privacy). They run when the local samples folder exists and skip otherwise.
// Set AIRPORT_SAMPLES to override the folder location.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pageFromPdfjsTextContent, extractRowsFromPages } from '../js/extractor.js';
import { toPassengerRecords } from '../js/validate.js';
import { buildSchedule } from '../js/schedule.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SAMPLES = process.env.AIRPORT_SAMPLES || join(ROOT, 'passenger travel info sheets');
const available = existsSync(SAMPLES);

// Row counts stated by each PDF itself ("Total Number of Passenger : N"),
// independently verified during analysis. Keyed by filename prefix.
const EXPECTED_COUNTS = {
  BIBRAC26: 8, BIBRED26: 31, CKIRWO26: 48, IBB90626: 39, IBB90726: 28,
  TBBRSD26: 48, TBIREX26: 48, TBIRIH26: 51, TBIRMZ26: 47,
};

async function extractFile(path, name) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(readFileSync(path));
  const doc = await getDocument({ data, useSystemFonts: true }).promise;
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    pages.push(pageFromPdfjsTextContent(await page.getTextContent(), p));
  }
  await doc.destroy();
  return extractRowsFromPages(pages, name);
}

async function extractAll() {
  const files = readdirSync(SAMPLES).filter((f) => f.toLowerCase().endsWith('.pdf'));
  const results = new Map();
  for (const f of files) {
    results.set(f, await extractFile(join(SAMPLES, f), f));
  }
  return results;
}

test('real PDFs: extracted row count matches each PDF\'s own stated total', { skip: !available }, async () => {
  const results = await extractAll();
  assert.equal(results.size, 9, 'expected the 9 sample PDFs');
  for (const [name, ex] of results) {
    const prefix = Object.keys(EXPECTED_COUNTS).find((p) => name.startsWith(p));
    assert.ok(prefix, `unknown sample file ${name}`);
    assert.equal(ex.statedTotal, EXPECTED_COUNTS[prefix], `${name}: stated total`);
    assert.equal(ex.rows.length, EXPECTED_COUNTS[prefix], `${name}: extracted rows`);
    assert.deepEqual(ex.fileWarnings, [], `${name}: no file warnings expected`);
  }
});

test('real PDFs: known row keeps all its own cells (Bester → EK/161 12:20 18-SEP)', { skip: !available }, async () => {
  const results = await extractAll();
  const name = [...results.keys()].find((f) => f.startsWith('TBBRSD26'));
  const records = toPassengerRecords(results.get(name));
  const bester = records.find((r) => r.passengerName.includes('Bester'));
  assert.ok(bester);
  assert.equal(bester.flightNumber, 'EK/161');
  assert.equal(bester.arrivalTime, '12:20');
  assert.equal(bester.arrivalCity, 'Dublin');
  assert.equal(bester.arrivalDate, '2026-09-18');
  assert.equal(bester.bookingId, 'TTJBGS / A110385');
  assert.equal(bester.reviewRequired, false);
});

test('real PDFs: blank-cell passengers stay blank — no inheritance (Altomaro rows)', { skip: !available }, async () => {
  const results = await extractAll();
  const name = [...results.keys()].find((f) => f.startsWith('TBBRSD26'));
  const records = toPassengerRecords(results.get(name));
  const altomaros = records.filter((r) => r.passengerName.includes('Altomaro'));
  assert.equal(altomaros.length, 2);
  for (const r of altomaros) {
    assert.equal(r.flightNumber, null);
    assert.equal(r.arrivalTime, null);
    assert.equal(r.arrivalDate, null);
    assert.ok(r.bookingId.includes('A272951')); // its own cells are kept
  }
  // Their neighbours in the document kept different dates — proof rows didn't bleed.
  const abbott = records.find((r) => r.passengerName.includes('Abbott, Anthony'));
  assert.equal(abbott.arrivalDate, '2026-09-19');
});

test('real PDFs: wrapped long names are joined correctly', { skip: !available }, async () => {
  const results = await extractAll();
  const name = [...results.keys()].find((f) => f.startsWith('BIBRED26'));
  const records = toPassengerRecords(results.get(name));
  const rec = records.find((r) => r.passengerName.includes('Champeau'));
  assert.ok(rec);
  assert.equal(rec.passengerName, 'Mrs Champeau Swenson, Tonie Lorraine');
  assert.equal(rec.flightNumber, 'AA/132'); // own cells intact after merge
});

test('real PDFs: same flight number on different dates never merges (EI/136)', { skip: !available }, async () => {
  const results = await extractAll();
  const name = [...results.keys()].find((f) => f.startsWith('TBBRSD26'));
  const records = toPassengerRecords(results.get(name));
  const sun = buildSchedule(records, '2026-09-20');
  const sat = buildSchedule(records, '2026-09-19');
  const sunEI136 = sun.groups.find((g) => g.flightNumber === 'EI/136');
  const satEI136 = sat.groups.find((g) => g.flightNumber === 'EI/136');
  assert.ok(sunEI136 && satEI136);
  // 19-SEP: the two Abbotts. 20-SEP: the two Valentes. Never mixed.
  assert.deepEqual(satEI136.passengers.map((p) => p.passengerName.split(',')[0]),
    ['Mr Abbott', 'Mrs Abbott']);
  assert.deepEqual(sunEI136.passengers.map((p) => p.passengerName.split(',')[0]),
    ['Mr Valente', 'Mrs Valente']);
});

test('real PDFs: consolidated Sunday 20-SEP schedule across all 9 files', { skip: !available }, async () => {
  const results = await extractAll();
  const allRecords = [];
  for (const ex of results.values()) allRecords.push(...toPassengerRecords(ex));
  assert.equal(allRecords.length, 348); // sum of the 9 stated totals

  const s = buildSchedule(allRecords, '2026-09-20');
  // Chronological order.
  const times = s.groups.map((g) => g.time);
  assert.deepEqual(times, [...times].sort());
  // Every scheduled passenger's own row says 20-SEP.
  for (const p of s.scheduled) assert.equal(p.arrivalDate, '2026-09-20');
  // Accounting: every record lands in exactly one bucket.
  assert.equal(
    s.scheduled.length + s.incompleteOnDate.length + s.noDate.length + s.otherDates.length,
    348,
  );
});
