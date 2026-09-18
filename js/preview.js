// Source PDF preview (brief §20): render the page a record came from and
// highlight the original row, so extraction can be verified by eye.

/**
 * Render `record`'s source page into `canvas`, highlighting the row.
 * `doc` is the pdf.js document the record was extracted from.
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

  // Highlight the union of the row's cell boxes (pdf-space, bottom-left origin).
  const boxes = Object.values(record.geometry?.cellBoxes ?? {});
  if (boxes.length === 0) return;
  const x0 = Math.min(...boxes.map((b) => b.x));
  const x1 = Math.max(...boxes.map((b) => b.x + b.w));
  const y0 = Math.min(...boxes.map((b) => b.y));
  const y1 = Math.max(...boxes.map((b) => b.y + b.h));

  // convertToViewportRectangle handles the y-axis flip.
  const [vx0, vy0, vx1, vy1] = viewport.convertToViewportRectangle([x0, y0, x1, y1]);
  const pad = 3;
  const rx = Math.min(vx0, vx1) - pad;
  const ry = Math.min(vy0, vy1) - pad;
  const rw = Math.abs(vx1 - vx0) + pad * 2;
  const rh = Math.abs(vy1 - vy0) + pad * 2;

  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.fillStyle = 'rgba(255, 200, 0, 0.30)';
  ctx.fillRect(rx, ry, rw, rh);
  ctx.strokeStyle = 'rgba(220, 120, 0, 0.95)';
  ctx.lineWidth = 2;
  ctx.strokeRect(rx, ry, rw, rh);

  return { scrollY: ry / (canvas.height / ratio) };
}
