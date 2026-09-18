// Per-file day summary for the annotated-sheet print (the digital version of
// handwriting "05:10 EI/122 × 7" on top of each report).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFileSummary } from '../js/sheetprint.js';

function rec(over = {}) {
  return {
    passengerName: 'Mr Smith, John',
    flightNumber: 'EI/122',
    arrivalTime: '05:10',
    arrivalCity: 'Dublin',
    arrivalDate: '2026-09-13',
    ...over,
  };
}

test('groups the file\'s passengers into time-sorted flight counts for the date', () => {
  const s = buildFileSummary([
    rec(), rec(), rec(),
    rec({ flightNumber: 'WS/46', arrivalTime: '09:20' }),
    rec({ flightNumber: 'EI/136', arrivalTime: '08:25' }),
  ], '2026-09-13');
  assert.deepEqual(s.flights.map((f) => `${f.time} ${f.flightNumber} x${f.count}`), [
    '05:10 EI/122 x3',
    '08:25 EI/136 x1',
    '09:20 WS/46 x1',
  ]);
  assert.equal(s.total, 5);
  assert.equal(s.incomplete, 0);
});

test('only the selected date counts; other dates and no-date rows are ignored', () => {
  const s = buildFileSummary([
    rec(),
    rec({ arrivalDate: '2026-09-12' }),
    rec({ arrivalDate: null, flightNumber: null, arrivalTime: null }),
  ], '2026-09-13');
  assert.equal(s.total, 1);
  assert.equal(s.flights.length, 1);
});

test('rows dated the day but missing flight/time are counted as incomplete, never guessed in', () => {
  const s = buildFileSummary([
    rec(),
    rec({ flightNumber: null, arrivalTime: null }),
  ], '2026-09-13');
  assert.equal(s.total, 1);
  assert.equal(s.incomplete, 1);
});

test('empty result for a file with nothing on the date', () => {
  const s = buildFileSummary([rec({ arrivalDate: '2026-09-12' })], '2026-09-13');
  assert.deepEqual(s, { flights: [], total: 0, incomplete: 0 });
});
