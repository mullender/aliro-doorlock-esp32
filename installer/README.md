# installer/

The browser flasher for `aliro-doorlock-esp32`.

Deployed to GitHub Pages by `.github/workflows/deploy-installer.yml` (see
that file after Phase 4c lands).

## Layout

```
installer/
  index.html          the flasher page (Phase 3+)
  js/
    matter-payload.js validators for MT: strings and manual pairing codes
    qr-render.js      SVG QR renderer wrapping vendor/qrcode.js
    boot-parser.js    (Phase 4b) parses CHIP:SVR: lines from serial
  vendor/
    qrcode.js         MIT-licensed QR generator (kazuhikoarase 2.0.4)
    esp-web-tools/    (Phase 4a) git submodule → mullender/esp-web-tools
    UPSTREAM.md       (Phase 4) tracks the upstream esp-web-tools PR
  tests/
    index.html        open in a browser to run every check
    test-vectors.js   known Matter setup payloads (positive + negative)
```

## Running the tests locally

Open `installer/tests/index.html` directly in a browser. Nothing to build,
no server needed. Each vector reports PASS/FAIL and a QR preview is
rendered from the positive vectors.

## Vendored dependencies

- **`vendor/qrcode.js`** — [`qrcode-generator`](https://github.com/kazuhikoarase/qrcode-generator)
  v2.0.4, MIT licensed. Same version used by `mullender/HomeKey-ESP32`.
  Zero runtime dependencies. Checked in directly (not fetched at build)
  so the installer runs from Pages with no CDN dependency.
- **`vendor/esp-web-tools/`** — added in Phase 4a as a git submodule
  pointing to `mullender/esp-web-tools` on branch
  `homekey-post-install-hook`.

## What the installer does NOT do

- Full Matter payload TLV decode. The Matter SDK on the device already
  produced a valid pair; the flasher trusts it. Sanity checks only.
- Bluetooth. Matter commissioning runs from the phone.
- Persistence of setup data. Values live in memory for the duration of
  the page session; nothing is sent to any remote service.
