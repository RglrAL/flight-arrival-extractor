// Date filtering, flight grouping, sorting, duplicate detection, totals.
//
// Filtering uses ONLY the row's own arrivalDate (brief §7). Rows without an
// established date are excluded and flagged — never assumed onto a date.
// Grouping keys on date+time+flight+city (brief §11), never flight alone.
// Duplicates are flagged for review, never silently removed (brief §16).

/** Composite key for duplicate detection (brief §16). */
function duplicateKey(rec) {
  return [
    (rec.passengerName || '').toLowerCase().replace(/\s+/g, ' ').trim(),
    (rec.bookingId || '').toLowerCase().replace(/\s+/g, ''),
    (rec.flightNumber || '').toLowerCase().replace(/\s+/g, ''),
    rec.arrivalDate || '',
    rec.arrivalTime || '',
  ].join('|');
}

/**
 * Build the schedule for a selected ISO date from validated records.
 *
 * Returns {
 *   selectedDate,
 *   groups: [{ date, time, flightNumber, arrivalCity, passengers: [record] }] — time-sorted
 *   scheduled           — records placed in groups
 *   incompleteOnDate    — date matches but flight/time missing: shown separately, never guessed into a flight
 *   noDate              — no established arrival date: excluded + flagged (brief §9)
 *   otherDates          — records whose row date is a different day (excluded)
 *   needsReview         — records with reviewRequired (whatever their date)
 *   duplicates          — [[recordA, recordB, ...], ...] groups sharing the composite key
 *   totals: { flights, passengers, incompleteOnDate }
 * }
 */
export function buildSchedule(records, selectedDate) {
  const scheduled = [];
  const incompleteOnDate = [];
  const noDate = [];
  const otherDates = [];

  for (const rec of records) {
    if (rec.arrivalDate == null) {
      noDate.push(rec);
    } else if (rec.arrivalDate !== selectedDate) {
      otherDates.push(rec);
    } else if (rec.flightNumber == null || rec.arrivalTime == null) {
      incompleteOnDate.push(rec);
    } else {
      scheduled.push(rec);
    }
  }

  // Duplicate detection across everything on the selected date.
  const byKey = new Map();
  for (const rec of [...scheduled, ...incompleteOnDate]) {
    const key = duplicateKey(rec);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(rec);
  }
  const duplicates = [...byKey.values()].filter((g) => g.length > 1);
  const duplicateIds = new Set(duplicates.flat().map((r) => r.id));

  // Group by date|time|flight|city, preserving source passenger order within
  // a group (brief §12) and insertion order between equal times.
  const groupMap = new Map();
  for (const rec of scheduled) {
    const key = `${rec.arrivalDate}|${rec.arrivalTime}|${rec.flightNumber}|${rec.arrivalCity ?? ''}`;
    if (!groupMap.has(key)) {
      groupMap.set(key, {
        date: rec.arrivalDate,
        time: rec.arrivalTime,
        flightNumber: rec.flightNumber,
        arrivalCity: rec.arrivalCity,
        passengers: [],
      });
    }
    groupMap.get(key).passengers.push(rec);
  }

  // Chronological sort — by time of day, never alphabetically (brief §10).
  // HH:MM zero-padded strings sort correctly lexicographically; flight number
  // is only a tiebreaker for identical times.
  const groups = [...groupMap.values()].sort(
    (a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : a.flightNumber.localeCompare(b.flightNumber)),
  );

  const needsReview = records.filter((r) => r.reviewRequired);

  return {
    selectedDate,
    groups,
    scheduled,
    incompleteOnDate,
    noDate,
    otherDates,
    needsReview,
    duplicates,
    duplicateIds,
    // Totals are computed from the included rows, never from the PDF's own
    // overall passenger count (brief §14).
    totals: {
      flights: groups.length,
      passengers: scheduled.length,
      incompleteOnDate: incompleteOnDate.length,
    },
  };
}
