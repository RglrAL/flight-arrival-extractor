// Excel / CSV / printable exports (brief §21).
// Excel uses the vendored SheetJS global (window.XLSX).

import { formatDisplayDate } from './normalize.js';
import { terminalFor, pickupBand } from './ui-data.js';

/** Flat passenger-level rows in schedule (group) order — brief §21 columns. */
function flatRows(schedule) {
  const rows = [];
  for (const g of schedule.groups) {
    for (const p of g.passengers) {
      rows.push({
        Date: p.arrivalDate,
        Time: p.arrivalTime,
        Flight: p.flightNumber,
        Terminal: terminalFor(p.flightNumber, p.arrivalCity) || '',
        Passenger: p.passengerName,
        'Booking ID': p.bookingId || '',
        'Arrival City': p.arrivalCity || '',
        'Source PDF': p.sourceFile,
      });
    }
  }
  return rows;
}

function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function buildCsv(schedule) {
  const rows = flatRows(schedule);
  const headers = ['Date', 'Time', 'Flight', 'Terminal', 'Passenger', 'Booking ID', 'Arrival City', 'Source PDF'];
  const lines = [headers.join(',')];
  for (const r of rows) lines.push(headers.map((h) => csvEscape(r[h])).join(','));
  return lines.join('\r\n');
}

function download(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

export function exportCsv(schedule) {
  const blob = new Blob([buildCsv(schedule)], { type: 'text/csv' });
  download(blob, `arrivals-${schedule.selectedDate}.csv`);
}

export function exportExcel(schedule) {
  const XLSX = globalThis.XLSX;
  const wb = XLSX.utils.book_new();

  // Sheet 1 — flat passenger list.
  const ws1 = XLSX.utils.json_to_sheet(flatRows(schedule));
  ws1['!cols'] = [{ wch: 11 }, { wch: 6 }, { wch: 9 }, { wch: 8 }, { wch: 34 }, { wch: 18 }, { wch: 12 }, { wch: 38 }];
  XLSX.utils.book_append_sheet(wb, ws1, 'Passengers');

  // Sheet 2 — presentation-friendly grouped schedule.
  const grouped = schedule.groups.map((g) => ({
    Time: g.time,
    Flight: g.flightNumber,
    Terminal: terminalFor(g.flightNumber, g.arrivalCity) || '',
    City: g.arrivalCity || '',
    Passengers: g.passengers.map((p) => p.passengerName).join('; '),
    Count: g.passengers.length,
  }));
  grouped.push({});
  grouped.push({ Time: 'Total flights', Flight: schedule.totals.flights, City: '', Passengers: 'Total passengers', Count: schedule.totals.passengers });
  const ws2 = XLSX.utils.json_to_sheet(grouped);
  ws2['!cols'] = [{ wch: 13 }, { wch: 10 }, { wch: 12 }, { wch: 90 }, { wch: 6 }];
  XLSX.utils.book_append_sheet(wb, ws2, 'Schedule');

  // Sheet 3 — rows needing attention, if any.
  const attention = [
    ...schedule.incompleteOnDate.map((p) => ({ ...rowFor(p), Issue: `Incomplete data (missing ${p.missing.filter((m) => ['flight', 'time'].includes(m)).join(', ')})` })),
    ...schedule.noDate.map((p) => ({ ...rowFor(p), Issue: 'No arrival date on row' })),
    ...schedule.needsReview.map((p) => ({ ...rowFor(p), Issue: `Review required (${p.flags.join(', ')})` })),
  ];
  if (attention.length > 0) {
    const ws3 = XLSX.utils.json_to_sheet(attention);
    ws3['!cols'] = [{ wch: 34 }, { wch: 18 }, { wch: 9 }, { wch: 6 }, { wch: 11 }, { wch: 38 }, { wch: 40 }];
    XLSX.utils.book_append_sheet(wb, ws3, 'Needs Review');
  }

  XLSX.writeFile(wb, `arrivals-${schedule.selectedDate}.xlsx`);
}

function rowFor(p) {
  return {
    Passenger: p.passengerName,
    'Booking ID': p.bookingId || '',
    Flight: p.flightNumber || '',
    Time: p.arrivalTime || '',
    Date: p.arrivalDate || (p.raw ? p.raw.date : '') || '',
    'Source PDF': p.sourceFile,
  };
}

/**
 * Print an HTML document via a hidden same-page iframe. No popup window —
 * immune to popup blockers (the reason sheet printing failed in real
 * Safari) — and the print dialog only opens after every image has decoded,
 * so nothing prints blank.
 */
export async function printHtml(html, title = null) {
  const iframe = document.createElement('iframe');
  iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:2px;height:2px;border:0;visibility:hidden;';
  document.body.appendChild(iframe);
  // Some browsers name the saved PDF after the top page's title, not the
  // iframe's — set it temporarily so the filename carries the date.
  const previousTitle = document.title;
  if (title) document.title = title;
  try {
    await new Promise((resolve) => {
      iframe.onload = resolve;
      iframe.srcdoc = html;
    });
    const doc = iframe.contentDocument;
    await Promise.all([...doc.images].map((img) =>
      img.decode().catch(() => new Promise((r) => {
        if (img.complete) r();
        else { img.onload = r; img.onerror = r; }
      }))));
    iframe.contentWindow.focus();
    iframe.contentWindow.print();
  } finally {
    // Keep the frame alive while the (modal) print dialog is open.
    setTimeout(() => {
      iframe.remove();
      if (title) document.title = previousTitle;
    }, 60_000);
  }
}

/** Open a clean printable schedule; the browser's print dialog does PDF. */
export function openPrintView(schedule) {
  const display = formatDisplayDate(schedule.selectedDate);
  const cities = [...new Set(schedule.groups.map((g) => g.arrivalCity).filter(Boolean))];
  const cityLine = cities.length === 1 ? `${cities[0].toUpperCase()} ARRIVALS` : 'ARRIVALS';

  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const groupsHtml = schedule.groups.map((g) => {
    const term = terminalFor(g.flightNumber, g.arrivalCity);
    const termHtml = term
      ? ` — <span style="color:${term === 'T1' ? '#047857' : '#1d4ed8'}">${term}</span>`
      : '';
    const band = pickupBand(g.time);
    const timeHtml = band
      ? `<span style="background:${band.color};padding:0 6px;border-radius:4px">${esc(g.time)}</span>`
      : esc(g.time);
    return `
    <section class="flight">
      <h2>${timeHtml} — ${esc(g.flightNumber)}${termHtml}${cities.length !== 1 && g.arrivalCity ? ` (${esc(g.arrivalCity)})` : ''}</h2>
      <ul>${g.passengers.map((p) => `<li>${esc(p.passengerName)}</li>`).join('')}</ul>
    </section>`;
  }).join('');

  const incompleteHtml = schedule.incompleteOnDate.length === 0 ? '' : `
    <section class="flight incomplete">
      <h2>⚠ Incomplete rows dated ${esc(display)} (no flight/time on their row)</h2>
      <ul>${schedule.incompleteOnDate.map((p) => `<li>${esc(p.passengerName)}</li>`).join('')}</ul>
    </section>`;

  const title = `Arrival schedule ${schedule.selectedDate}`;
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
  <style>
    body { font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; margin: 2rem auto; max-width: 44rem; color: #111; }
    h1 { font-size: 1.4rem; margin: 0; letter-spacing: 0.04em; }
    .date { font-size: 1.1rem; margin: 0.2rem 0 1.4rem; }
    .flight { margin-bottom: 1rem; break-inside: avoid; }
    .flight h2 { font-size: 1.05rem; margin: 0 0 0.2rem; border-bottom: 1px solid #999; padding-bottom: 2px; }
    .flight ul { margin: 0.2rem 0 0; padding-left: 1.4rem; }
    .flight li { line-height: 1.45; }
    .totals { margin-top: 1.6rem; border-top: 2px solid #111; padding-top: 0.5rem; font-weight: 600; }
    .incomplete h2 { color: #8a5a00; }
    @media print { body { margin: 0.5rem; } }
  </style></head><body>
  <h1>${esc(cityLine)}</h1>
  <p class="date">${esc(display)}</p>
  ${groupsHtml}
  ${incompleteHtml}
  <p class="totals">Total flights: ${schedule.totals.flights}<br>Total passengers: ${schedule.totals.passengers}</p>
  </body></html>`;

  printHtml(html, title);
}
