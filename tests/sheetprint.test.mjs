// Per-file day summary for the annotated-sheet print (the digital version of
// handwriting "05:10 EI/122 × 7" on top of each report).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFileSummary, rectIntersectsAny } from '../js/sheetprint.js';

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

// The overlay-vs-band decision: the summary is only drawn over the page when
// the target area is verified empty of printed text.
test('collision check: overlapping text is detected, clear space is not', () => {
  const spot = { x: 100, y: 10, w: 200, h: 80 };
  const clearRects = [
    { x: 10, y: 10, w: 50, h: 12 },    // left of spot
    { x: 100, y: 200, w: 200, h: 12 }, // below spot
  ];
  assert.equal(rectIntersectsAny(spot, clearRects), false);
  assert.equal(rectIntersectsAny(spot, [...clearRects, { x: 250, y: 60, w: 40, h: 12 }]), true);
  // Margin catches near-misses.
  assert.equal(rectIntersectsAny(spot, [{ x: 302, y: 20, w: 40, h: 12 }]), false);
  assert.equal(rectIntersectsAny(spot, [{ x: 302, y: 20, w: 40, h: 12 }], 5), true);
});
