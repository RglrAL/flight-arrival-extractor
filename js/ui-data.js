// UI view-model helpers. Pure functions only — the core engine
// (extractor/normalize/validate/schedule) stays untouched.

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * Which arrival dates actually occur in the extracted rows, and how many
 * passengers each has. Chronologically ascending — never by count.
 * Returns [{ date: '2026-09-20', count: 116 }, ...]
 */
export function dateHistogram(records) {
  const map = new Map();
  for (const r of records) {
    if (r.arrivalDate) map.set(r.arrivalDate, (map.get(r.arrivalDate) || 0) + 1);
  }
  return [...map.entries()]
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

/** "2026-09-20" → "Sun 20 Sep" (chip label). */
export function shortChipDate(iso) {
  const m = iso && iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return iso || '';
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return `${DAYS_SHORT[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS_SHORT[d.getUTCMonth()]}`;
}

/**
 * Short source label for schedule metadata: the report code (first
 * whitespace-separated token of the filename), full name goes in a tooltip.
 */
export function shortSourceLabel(fileName) {
  const token = String(fileName || '').trim().split(/\s+/)[0] || fileName;
  return token.replace(/\.pdf$/i, '');
}

/**
 * Count of entries the review panel will show. Scoped definition of
 * "no issues": zero review-required rows, zero file warnings, zero possible
 * duplicates, zero incomplete-on-date, zero no-date rows. Not a claim of
 * perfection — just that nothing needs human attention.
 */
export function reviewIssueCount(schedule, files) {
  let fileIssues = 0;
  for (const f of files) {
    if (f.error) fileIssues += 1;
    else if (f.extraction) fileIssues += f.extraction.fileWarnings.length;
  }
  return fileIssues +
    schedule.needsReview.length +
    schedule.duplicates.length +
    schedule.incompleteOnDate.length +
    (schedule.noDate.length > 0 ? 1 : 0);
}
