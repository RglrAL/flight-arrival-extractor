import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dateHistogram, shortChipDate, shortSourceLabel, reviewIssueCount } from '../js/ui-data.js';

test('dateHistogram counts per date, sorted chronologically — never by count', () => {
  const recs = [
    { arrivalDate: '2026-09-20' }, { arrivalDate: '2026-09-20' }, { arrivalDate: '2026-09-20' },
    { arrivalDate: '2026-09-18' },
    { arrivalDate: '2026-09-19' }, { arrivalDate: '2026-09-19' },
    { arrivalDate: null },
  ];
  assert.deepEqual(dateHistogram(recs), [
    { date: '2026-09-18', count: 1 },
    { date: '2026-09-19', count: 2 },
    { date: '2026-09-20', count: 3 },
  ]);
});

test('shortChipDate formats compactly', () => {
  assert.equal(shortChipDate('2026-09-20'), 'Sun 20 Sep');
  assert.equal(shortChipDate('2026-01-01'), 'Thu 1 Jan');
});

test('shortSourceLabel takes the report code from the filename', () => {
  assert.equal(shortSourceLabel('TBBRSD26 20I26a TD James Creegan .pdf'), 'TBBRSD26');
  assert.equal(shortSourceLabel('single.pdf'), 'single');
});

test('reviewIssueCount matches the review panel scope', () => {
  const schedule = { needsReview: [1], duplicates: [[1, 2]], incompleteOnDate: [1, 2], noDate: [1] };
  const files = [
    { extraction: { fileWarnings: ['count-mismatch'] } },
    { extraction: { fileWarnings: [] } },
    { error: 'broken' },
  ];
  // 1 review + 1 dup group + 2 incomplete + 1 no-date summary + 1 warning + 1 error
  assert.equal(reviewIssueCount(schedule, files), 7);
  assert.equal(
    reviewIssueCount({ needsReview: [], duplicates: [], incompleteOnDate: [], noDate: [] }, [{ extraction: { fileWarnings: [] } }]),
    0,
  );
});
