// Source PDF preview (brief §20): render the page a record came from.
// The row highlight is NOT drawn on the canvas — the caller positions a CSS
// overlay from the returned rect, so source rendering and UI highlighting
// stay cleanly separated (and the highlight can fade in after the page).

/**
 * Render `record`'s source page into `canvas`.
 * Returns { rect: { x, y, w, h } | null, scrollY } — rect in CSS pixels
 * relative to the canvas, covering the record's row.
 */
export async function renderRecordPreview(doc, record, canvas, maxWidth = 900) {
  const page = await doc.getPage(record.sourcePage);
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(2.5, maxWidth / base.width);
  const viewport = page.getViewport({ scale });

  const ratio = globalThis.devicePixelRatio || 1;
  canvas.width = Math.floor(viewport.width * ratio);
  canvas.height = Math.floor(viewport.height * ratio);
  canvas.style.width = `${Math.floor(viewport.width)}px`;
  canvas.style.height = `${Math.floor(viewport.height)}px`;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);

  await page.render({ canvasContext: ctx, viewport, transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : null }).promise;

  // Union of the row's cell boxes (pdf-space, bottom-left origin).
  const boxes = Object.values(record.geometry?.cellBoxes ?? {});
  if (boxes.length === 0) return { rect: null, scrollY: 0 };
  const x0 = Math.min(...boxes.map((b) => b.x));
  const x1 = Math.max(...boxes.map((b) => b.x + b.w));
  const y0 = Math.min(...boxes.map((b) => b.y));
  const y1 = Math.max(...boxes.map((b) => b.y + b.h));

  // convertToViewportRectangle handles the y-axis flip.
  const [vx0, vy0, vx1, vy1] = viewport.convertToViewportRectangle([x0, y0, x1, y1]);
  const pad = 3;
  const rect = {
    x: Math.min(vx0, vx1) - pad,
    y: Math.min(vy0, vy1) - pad,
    w: Math.abs(vx1 - vx0) + pad * 2,
    h: Math.abs(vy1 - vy0) + pad * 2,
  };
  return { rect, scrollY: rect.y / viewport.height };
}
