// Turns raw extracted rows into validated PassengerArrival records
// (brief §17, §18, §24) with confidence scores and review flags.
// The system prefers asking for review over making an assumption.

import { parseDate, parseTime, flightLooksTypical } from './normalize.js';

/**
 * rawRow: output of extractor (cells, page, y, cellBoxes, flags, sourceFile, sourceRow)
 * Returns a PassengerArrival record.
 *
 * Note: file-level warnings (e.g. a stated-total mismatch) are a document
 * integrity concern surfaced by the UI — they do not mark individual rows as
 * suspect, because a count mismatch means a row may be MISSING, not that the
 * reconstructed rows are wrong.
 */
export function toPassengerRecord(rawRow) {
  const { cells } = rawRow;
  const date = parseDate(cells.date);
  const time = parseTime(cells.time);

  const flags = [...rawRow.flags];
  let confidence = 100;

  if (flags.includes('band-straddle')) confidence -= 40;
  if (flags.includes('no-name-cell')) confidence -= 50;
  if (flags.includes('unusual-name')) confidence -= 10;
  if (flags.includes('item-left-of-table')) confidence -= 20;

  // A cell that contains text but cannot be parsed is worse than a blank cell:
  // it means we may be misreading the document.
  if (cells.date !== '' && !date.ok) {
    flags.push(date.ambiguous ? 'ambiguous-date' : 'unparseable-date');
    confidence -= 30;
  }
  if (cells.time !== '' && !time.ok) {
    flags.push('unparseable-time');
    confidence -= 30;
  }
  if (cells.flight !== '' && !flightLooksTypical(cells.flight)) {
    // Unusual formats are kept (brief §17), just noted.
    flags.push('unusual-flight-format');
    confidence -= 10;
  }

  confidence = Math.max(0, Math.min(100, confidence));

  const missing = [];
  if (cells.name === '') missing.push('name');
  if (cells.flight === '') missing.push('flight');
  if (!time.ok) missing.push('time');
  if (!date.ok) missing.push('date');
  if (cells.booking === '') missing.push('booking');
  if (cells.city === '') missing.push('city');

  // Review is required for structural doubts — not for genuinely blank rows,
  // which are a normal feature of these reports (passenger with no flight info).
  const structuralDoubt = flags.some((f) => [
    'band-straddle', 'no-name-cell', 'item-left-of-table',
    'ambiguous-date', 'unparseable-date', 'unparseable-time',
  ].includes(f));

  return {
    id: `${rawRow.sourceFile}#p${rawRow.page}r${rawRow.sourceRow}`,
    passengerName: cells.name,
    bookingId: cells.booking || null,
    flightNumber: cells.flight || null,   // preserved verbatim, e.g. "EI/124"
    arrivalTime: time.ok ? time.hhmm : null,
    arrivalCity: cells.city || null,      // from the row only, never assumed
    arrivalDate: date.ok ? date.iso : null,
    raw: { ...cells },
    sourceFile: rawRow.sourceFile,
    sourcePage: rawRow.page,
    sourceRow: rawRow.sourceRow,
    geometry: { y: rawRow.y, cellBoxes: rawRow.cellBoxes },
    extractionConfidence: confidence,
    flags,
    missing,
    reviewRequired: structuralDoubt,
  };
}

/** Convenience: validate a whole extracted file. */
export function toPassengerRecords(extraction) {
  return extraction.rows.map((r) => toPassengerRecord(r));
}
