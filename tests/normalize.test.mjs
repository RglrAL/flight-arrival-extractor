import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDate, parseTime, flightLooksTypical, formatDisplayDate, weekdayOf,
} from '../js/normalize.js';

test('parses the report date format 13-SEP-26', () => {
  assert.deepEqual(parseDate('13-SEP-26'), { iso: '2026-09-13', ok: true, ambiguous: false, raw: '13-SEP-26' });
  assert.equal(parseDate('20-SEP-26').iso, '2026-09-20');
  assert.equal(parseDate('1-JAN-27').iso, '2027-01-01');
  assert.equal(parseDate('13-SEP-2026').iso, '2026-09-13');
});

test('parses other recognised formats (brief §25)', () => {
  assert.equal(parseDate('2026-09-13').iso, '2026-09-13');
  assert.equal(parseDate('13/09/2026').iso, '2026-09-13');
  assert.equal(parseDate('13-09-2026').iso, '2026-09-13');
});

test('never silently corrects ambiguous numeric dates', () => {
  const d = parseDate('03/04/2026'); // 3 Apr or 4 Mar?
  assert.equal(d.ok, false);
  assert.equal(d.ambiguous, true);
});

test('rejects non-dates and impossible dates', () => {
  assert.equal(parseDate('').ok, false);
  assert.equal(parseDate('Dublin').ok, false);
  assert.equal(parseDate('32-SEP-26').ok, false);
  assert.equal(parseDate('29-FEB-27').ok, false); // 2027 not a leap year
});

test('parses and zero-pads times, rejects invalid', () => {
  assert.equal(parseTime('08:15').hhmm, '08:15');
  assert.equal(parseTime('5:10').hhmm, '05:10');
  assert.equal(parseTime('14:50').hhmm, '14:50');
  assert.equal(parseTime('25:00').ok, false);
  assert.equal(parseTime('08:60').ok, false);
  assert.equal(parseTime('').ok, false);
});

test('flight format check accepts typical codes without rejecting unusual ones', () => {
  for (const f of ['EI/124', 'AC/800', 'UA/317', 'DL/292', 'WS/46', 'AA/724', 'BA/826', 'EK/161']) {
    assert.equal(flightLooksTypical(f), true, f);
  }
  // Unusual shapes are merely "not typical" — validate.js keeps them anyway.
  assert.equal(flightLooksTypical('CHARTER FLIGHT 9'), false);
});

test('display formatting shows weekday (brief step 2)', () => {
  assert.equal(formatDisplayDate('2026-09-13'), 'Sunday 13 September 2026');
  assert.equal(formatDisplayDate('2026-09-20'), 'Sunday 20 September 2026');
  assert.equal(weekdayOf('2026-09-18'), 'Friday');
});
