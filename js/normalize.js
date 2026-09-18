// Normalisation of dates, times and flight numbers.
// Dates are stored internally as ISO (2026-09-13); source display formats vary.
// Ambiguous dates are never silently "corrected" (brief §25).

const MONTHS = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
};

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function pad2(n) {
  return String(n).padStart(2, '0');
}

function isRealDate(y, m, d) {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/**
 * Parse a date cell into ISO form.
 * Returns { iso, ok, ambiguous, raw }.
 * - ok=false when the text is not a recognisable date.
 * - ambiguous=true when the numeric form could be read two ways (e.g. 03/04/2026);
 *   such dates are NOT included in results without review.
 * Recognised: 13-SEP-26, 13-SEP-2026, 13 SEP 26, 2026-09-13, 13/09/2026, 13-09-2026.
 */
export function parseDate(raw) {
  const none = { iso: null, ok: false, ambiguous: false, raw };
  if (raw == null) return none;
  const s = String(raw).trim();
  if (s === '') return none;

  // 13-SEP-26 / 13-SEP-2026 / 13 SEP 26
  let m = s.match(/^(\d{1,2})[-\s]([A-Za-z]{3})[-\s](\d{2}|\d{4})$/);
  if (m) {
    const month = MONTHS[m[2].toUpperCase()];
    if (!month) return none;
    const day = parseInt(m[1], 10);
    let year = parseInt(m[3], 10);
    if (year < 100) year += 2000;
    if (!isRealDate(year, month, day)) return none;
    return { iso: `${year}-${pad2(month)}-${pad2(day)}`, ok: true, ambiguous: false, raw };
  }

  // ISO 2026-09-13
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    const [year, month, day] = [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
    if (!isRealDate(year, month, day)) return none;
    return { iso: `${year}-${pad2(month)}-${pad2(day)}`, ok: true, ambiguous: false, raw };
  }

  // 13/09/2026 or 13-09-2026 (day first). Ambiguous when both parts could be a month.
  m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})$/);
  if (m) {
    const a = parseInt(m[1], 10);
    const b = parseInt(m[2], 10);
    let year = parseInt(m[3], 10);
    if (year < 100) year += 2000;
    const ambiguous = a <= 12 && b <= 12 && a !== b;
    if (!isRealDate(year, b, a)) return none;
    return {
      iso: `${year}-${pad2(b)}-${pad2(a)}`,
      ok: !ambiguous,
      ambiguous,
      raw,
    };
  }

  return none;
}

/**
 * Parse a time cell. Returns { hhmm, ok, raw }. Stored/displayed as 24h HH:MM.
 */
export function parseTime(raw) {
  const none = { hhmm: null, ok: false, raw };
  if (raw == null) return none;
  const s = String(raw).trim();
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return none;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (h > 23 || min > 59) return none;
  return { hhmm: `${pad2(h)}:${pad2(min)}`, ok: true, raw };
}

/**
 * Flight numbers are preserved verbatim (EI/124 stays EI/124 — brief §26).
 * This only reports whether the shape looks like a typical airline/flight code,
 * for confidence scoring. Unusual formats are NOT rejected (brief §17).
 */
export function flightLooksTypical(raw) {
  if (!raw) return false;
  return /^[A-Z0-9]{2,3}\/\d{1,4}[A-Z]?$/i.test(String(raw).trim());
}

/** "2026-09-13" -> "Sunday 13 September 2026" */
export function formatDisplayDate(iso) {
  const m = iso && iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return iso || '';
  const dt = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return `${WEEKDAYS[dt.getUTCDay()]} ${dt.getUTCDate()} ${MONTH_NAMES[dt.getUTCMonth()]} ${dt.getUTCFullYear()}`;
}

/** "2026-09-13" -> "Sunday" */
export function weekdayOf(iso) {
  const m = iso && iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return '';
  return WEEKDAYS[new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay()];
}
