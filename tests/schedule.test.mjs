// The brief's Tests 1–6 (§29) plus duplicate handling (§16) and totals (§14).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSchedule } from '../js/schedule.js';

let nextId = 0;
function rec(over = {}) {
  nextId += 1;
  return {
    id: `t#${nextId}`,
    passengerName: 'Mr Smith, John',
    bookingId: 'TT / A1',
    flightNumber: 'AC/800',
    arrivalTime: '08:15',
    arrivalCity: 'Dublin',
    arrivalDate: '2026-09-13',
    extractionConfidence: 100,
    flags: [],
    missing: [],
    reviewRequired: false,
    ...over,
  };
}

test('Test 1 — date filtering: 12-SEP row excluded when 13-SEP selected', () => {
  const s = buildSchedule([
    rec({ arrivalDate: '2026-09-12' }),
    rec({ passengerName: 'Mrs Smith, Mary', arrivalDate: '2026-09-13' }),
  ], '2026-09-13');
  assert.equal(s.totals.passengers, 1);
  assert.equal(s.scheduled[0].passengerName, 'Mrs Smith, Mary');
  assert.equal(s.otherDates.length, 1);
});

test('Test 2 — chronological ordering by time, not flight number', () => {
  const times = ['09:35', '07:20', '10:45', '05:10', '08:15'];
  const s = buildSchedule(
    times.map((t, i) => rec({ arrivalTime: t, flightNumber: `ZZ/${9 - i}`, passengerName: `Mr P${i}, X` })),
    '2026-09-13',
  );
  assert.deepEqual(s.groups.map((g) => g.time), ['05:10', '07:20', '08:15', '09:35', '10:45']);
});

test('Test 3 — same flight+time on different dates: only the selected date appears', () => {
  const s = buildSchedule([
    rec({ flightNumber: 'WS/46', arrivalTime: '09:20', arrivalDate: '2026-09-12' }),
    rec({ flightNumber: 'WS/46', arrivalTime: '09:20', arrivalDate: '2026-09-13', passengerName: 'Ms Right, Day' }),
  ], '2026-09-13');
  assert.equal(s.totals.flights, 1);
  assert.equal(s.groups[0].passengers.length, 1);
  assert.equal(s.groups[0].passengers[0].passengerName, 'Ms Right, Day');
});

test('Test 4 — missing date: excluded, flagged, never assumed', () => {
  const s = buildSchedule([
    rec({ arrivalDate: null, missing: ['date'] }),
    rec({ passengerName: 'Mrs Has, Date' }),
  ], '2026-09-13');
  assert.equal(s.totals.passengers, 1);
  assert.equal(s.noDate.length, 1);
  assert.equal(s.noDate[0].passengerName, 'Mr Smith, John');
});

test('Test 5 — missing flight with matching date: kept, flagged incomplete, not assigned a flight', () => {
  const s = buildSchedule([
    rec({ flightNumber: null, arrivalTime: null, missing: ['flight', 'time'] }),
    rec({ passengerName: 'Mrs Complete, Row' }),
  ], '2026-09-13');
  assert.equal(s.incompleteOnDate.length, 1);
  assert.equal(s.totals.incompleteOnDate, 1);
  // Not silently merged into the AC/800 group:
  assert.equal(s.groups.length, 1);
  assert.equal(s.groups[0].passengers.length, 1);
});

test('Test 6 — grouping by flight+time, passengers in source order (brief §12)', () => {
  const s = buildSchedule([
    rec({ passengerName: 'Mr Smith, John' }),
    rec({ passengerName: 'Mrs Smith, Mary' }),
    rec({ passengerName: 'Mr Bloggs, Joe', flightNumber: 'EI/124', arrivalTime: '10:35', bookingId: 'X / 9' }),
  ], '2026-09-13');
  assert.equal(s.groups.length, 2);
  assert.deepEqual(s.groups[0].passengers.map((p) => p.passengerName), ['Mr Smith, John', 'Mrs Smith, Mary']);
  assert.equal(s.groups[1].flightNumber, 'EI/124');
});

test('grouping keys include city and date, not just flight number (brief §11)', () => {
  const s = buildSchedule([
    rec({ arrivalCity: 'Dublin' }),
    rec({ arrivalCity: 'Shannon', passengerName: 'Ms Other, City' }),
  ], '2026-09-13');
  assert.equal(s.groups.length, 2);
});

test('duplicates across PDFs are flagged, never silently removed (brief §16)', () => {
  const a = rec({ sourceFile: 'a.pdf' });
  const b = rec({ sourceFile: 'b.pdf' });
  const s = buildSchedule([a, b], '2026-09-13');
  assert.equal(s.totals.passengers, 2); // both kept
  assert.equal(s.duplicates.length, 1);
  assert.deepEqual(s.duplicates[0].map((r) => r.id).sort(), [a.id, b.id].sort());
  assert.ok(s.duplicateIds.has(a.id) && s.duplicateIds.has(b.id));
});

test('similar but genuinely different passengers are NOT duplicate-flagged', () => {
  const s = buildSchedule([
    rec(),
    rec({ bookingId: 'TT / B2' }), // same name+flight, different booking
  ], '2026-09-13');
  assert.equal(s.duplicates.length, 0);
});

test('totals come from included rows, not the PDF total (brief §14)', () => {
  const records = [
    rec(), rec({ passengerName: 'A' }), rec({ passengerName: 'B', arrivalDate: '2026-09-12' }),
  ];
  const s = buildSchedule(records, '2026-09-13');
  assert.equal(s.totals.passengers, 2);
  assert.equal(s.totals.flights, 1);
});
