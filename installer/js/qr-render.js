// qr-render.js
//
// Thin wrapper around vendor/qrcode.js that:
//   - accepts an MT: string
//   - picks a reasonable error correction level (M) and auto type-number
//   - renders as an SVG (crisp at any zoom) with a white quiet zone
//
// SVG output is preferred over canvas because:
//   - phones scan it from arbitrary desktop screen resolutions
//   - the user can print it or download it without rasterizing
//   - it needs no explicit width/height in HTML
//
// The vendor library exposes a global `qrcode`. This module wraps it in an
// ES-module-friendly function. If we later switch bundling strategies, only
// this file needs to change.

/**
 * Render an MT: string as an SVG QR code.
 *
 * @param {string} mt   The raw MT: string parsed from firmware boot log.
 * @param {object} opts Optional {size: number, quietModules: number, background: string, foreground: string}
 * @returns {string}    SVG markup as a string. Caller assigns to innerHTML or
 *                      creates an object URL. Never contains scripts.
 */
export function renderMTasSVG(mt, opts = {}) {
  const size = opts.size ?? 320;                    // final SVG pixel size
  const quietModules = opts.quietModules ?? 4;      // Matter/Aztec-style QR quiet zone in modules
  const foreground = opts.foreground ?? "#000";
  const background = opts.background ?? "#fff";

  // qrcode-generator API: qrcode(typeNumber, errorCorrectionLevel).
  // typeNumber 0 = auto. errorCorrectionLevel M has been the historical
  // choice for Matter QRs (L would be smaller but scans worse on curved
  // desktop screens with glare).
  const qr = window.qrcode(0, "M");
  qr.addData(mt);
  qr.make();

  const moduleCount = qr.getModuleCount();
  const totalModules = moduleCount + 2 * quietModules;
  const moduleSize = size / totalModules;

  // Build SVG rectangles. Group filled modules for smaller output.
  let rects = "";
  for (let row = 0; row < moduleCount; row++) {
    for (let col = 0; col < moduleCount; col++) {
      if (qr.isDark(row, col)) {
        const x = (col + quietModules) * moduleSize;
        const y = (row + quietModules) * moduleSize;
        rects +=
          `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" ` +
          `width="${moduleSize.toFixed(2)}" height="${moduleSize.toFixed(2)}"/>`;
      }
    }
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" ` +
    `width="${size}" height="${size}" role="img" aria-label="Matter setup QR code">` +
    `<rect width="100%" height="100%" fill="${background}"/>` +
    `<g fill="${foreground}">${rects}</g>` +
    `</svg>`
  );
}

/**
 * Render an SVG QR and mount it into the given container element.
 * Clears the container first.
 */
export function mountQRCode(containerEl, mt, opts = {}) {
  if (!containerEl) return;
  containerEl.innerHTML = renderMTasSVG(mt, opts);
}
