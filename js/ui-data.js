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
 * Tour Director name — present only in the report's filename, e.g.
 * "TBBRSD26 20I26a TD James Creegan .pdf" → "James Creegan".
 * Filenames from these operators contain odd unicode spaces; \s covers them.
 * Returns null when no TD token is found (nothing is guessed).
 */
export function tdFromFileName(fileName) {
  const normalized = String(fileName || '').replace(/\s+/g, ' ').trim();
  const m = normalized.match(/\bTD\s+(.+?)\s*(?:\.pdf)?\s*$/i);
  return m ? m[1].trim() : null;
}

/**
 * Pick-up bands for the printed outputs — arrivals before 08:00 go on the
 * 8:30am pickup, before 10:30 the 11am, before 13:00 the 1pm. Colours are
 * multiply-friendly highlighter pastels. Arrivals at/after 13:00 are outside
 * the operation's day (no band).
 */
export const PICKUP_BANDS = [
  { before: '08:00', label: '8:30am', color: '#ffc4d0' }, // pink
  { before: '10:30', label: '11am', color: '#ffe75e' },   // yellow
  { before: '13:00', label: '1pm', color: '#b7ecb0' },    // green
];

export function pickupBand(hhmm) {
  if (!hhmm) return null;
  for (const band of PICKUP_BANDS) {
    if (hhmm < band.before) return band;
  }
  return null;
}

/**
 * Dublin Airport terminal by operating-airline prefix. EDITABLE — Alan
 * should correct any assignment that doesn't match current daa practice.
 * An airline in neither set gets NO terminal shown (never guessed) —
 * codeshare flight numbers (e.g. SQ/2170 operated by another carrier)
 * intentionally fall through unless the marketing prefix is listed.
 */
/* BA and AF moved to T2 per Alan (ground truth at the airport, Sep 2026). */
const DUBLIN_T2 = new Set(['EI', 'AA', 'DL', 'UA', 'EK', 'EY', 'BA', 'AF']);
const DUBLIN_T1 = new Set(['FR', 'KL', 'LH', 'AC', 'WS', 'TS', 'QR', 'IB', 'TK', 'LX', 'SN', 'SK', 'TP', 'AZ', 'LO', 'OS']);

/**
 * "EI/122" + "Dublin" → "T1" | "T2" | null.
 * Only applies to Dublin arrivals; unknown airlines return null.
 */
export function terminalFor(flightNumber, arrivalCity) {
  if (!flightNumber) return null;
  if ((arrivalCity || '').trim().toLowerCase() !== 'dublin') return null;
  const prefix = String(flightNumber).split('/')[0].trim().toUpperCase();
  if (DUBLIN_T2.has(prefix)) return 'T2';
  if (DUBLIN_T1.has(prefix)) return 'T1';
  return null;
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
