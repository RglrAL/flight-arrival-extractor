# Flight Arrival Extractor

Extracts flight-arrival schedules from **Passenger Arrival Details** PDFs
(Trafalgar / Insight Vacations / Brendan Vacations / Costsaver tour reports),
entirely in your web browser.

Upload one or more PDFs, pick an arrival date, and get a consolidated,
chronological schedule of every passenger whose **own row** in the source
document matches that date — grouped by flight, with totals and
Excel / CSV / print exports.

## Privacy

**No passenger data ever leaves your device.** The PDFs are parsed locally in
the browser tab (using Mozilla's pdf.js); nothing is uploaded to any server.
This repository contains application code only — real reports must never be
committed (the `.gitignore` enforces this).

## The core guarantee

These reports look like simple tables, but their internal PDF text stream
delivers the columns as separate blocks, and passengers with blank flight
details are simply missing from those blocks. Any parser that matches columns
by position will silently shift passengers onto the wrong flights.

This app instead reconstructs each visual row from the x/y coordinates of the
printed text. A passenger's flight, time, city and date are only ever what is
physically printed on **their own row**:

- Blank cells stay blank — a passenger can never inherit a date/flight/time
  from the row above or below, by construction.
- Filtering uses only the row's own *Date of Arrival* — never the report date,
  filename, neighbouring rows or majority date.
- Grouping keys on date + time + flight + city (the same flight number can
  appear on several dates in one report).
- The extracted row count is cross-checked against the PDF's own
  "Total Number of Passenger" line; any mismatch is flagged.
- Anything uncertain (straddling text, unparseable dates, count mismatches) is
  flagged **⚠ review required** rather than guessed.
- Possible duplicates across PDFs are flagged, never silently removed.
- Click any passenger to see their original row highlighted in the source PDF.

## V1 limitation

V1 accepts PDFs containing an extractable text layer (all current operational
reports do). Scanned/image-only PDFs are rejected with *"Could not reliably
extract this PDF"* rather than processed heuristically — fail visibly, never
guess. OCR support is a future enhancement.

## Using it

Serve the folder with any static file server (or use the hosted GitHub Pages
URL). For local use:

```sh
python3 -m http.server 8000
# then open http://localhost:8000
```

It also works offline once loaded, and can be installed as an app
("Add to Dock" / "Install app" in the browser menu).

## Development

Plain ES modules — no build step. `js/extractor.js` (row reconstruction),
`js/validate.js` (validation + review flags), `js/schedule.js`
(filter/group/sort/duplicates), `js/exports.js`, `js/preview.js`, `js/app.js`.
pdf.js and SheetJS are vendored in `vendor/`.

Tests (Node ≥ 20):

```sh
npm install
npm test
```

Unit tests cover the brief's required scenarios (date filtering, chronological
sort, same-flight-different-dates, missing data, grouping, duplicates).
Integration tests run against real sample reports when a local
`passenger travel info sheets/` folder exists (kept out of git); they skip
otherwise. Set `AIRPORT_SAMPLES=/path/to/folder` to point elsewhere.
