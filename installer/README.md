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
    install-controller.js fixes erase policy and handles install results
    setup-flow.js     controls pairing, update, error, and cancel UI state
  vendor/
    qrcode.js         MIT-licensed QR generator (kazuhikoarase 2.0.4)
    esp-web-tools/    (Phase 4a) git submodule → mullender/esp-web-tools
    UPSTREAM.md       (Phase 4) tracks the upstream esp-web-tools PR
  tests/
    index.html        open in a browser to run every check
    test-vectors.js   known Matter setup payloads (positive + negative)
```

## Running the tests locally

Serve the repository root on localhost, then open
`installer/tests/index.html` in Chrome or Edge. Each check reports PASS or
FAIL. The page also shows a QR preview for each positive vector.

For example:

```sh
python3 -m http.server 8765
```

Then open `http://localhost:8765/installer/tests/`.

## Vendored dependencies

- **`vendor/qrcode.js`** — [`qrcode-generator`](https://github.com/kazuhikoarase/qrcode-generator)
  v2.0.4, MIT licensed. Same version used by `mullender/HomeKey-ESP32`.
  Zero runtime dependencies. Checked in directly (not fetched at build)
  so the installer runs from Pages with no CDN dependency.
- **`vendor/esp-web-tools/`** — added in Phase 4a as a git submodule
  pointing to `mullender/esp-web-tools` on branch
  `homekey-post-install-hook`. The deployed page loads only this pinned,
  same-origin build. It has no CDN fallback.

## Install modes

The page offers two separate ESP Web Tools buttons:

- **Update firmware — keep setup** uses `manifest-update.json`. Its button
  declares `erase-first="false"` in HTML. Use it only for a device that was
  previously installed from this repository with the approved
  `esp32c6-door-lock-4mb-v1` partition layout. The update keeps Matter
  fabrics, Thread credentials, and Aliro reader configuration.
- **Factory install — erase everything** uses `manifest.json`. Its button
  declares `erase-first="true"` in HTML. Use it for a first install, recovery,
  or any device that does not use the approved layout.

The pinned ESP Web Tools fork enforces each declared erase policy. An
app-only manifest cannot erase the device. Before a preserving update writes
data, the fork reads and hashes the connected device's partition table. The
hash must match the approved layout. During each install, esptool-js checks
each write block and its acknowledgement. The installer then resets the
device. For a factory install, the captured boot log and QR code confirm the
complete install flow.

## What the installer does NOT do

- Optional Matter vendor TLV fields. The validator decodes the fixed setup
  fields and checks that the QR and manual code have the same discriminator
  and passcode.
- Bluetooth. Matter commissioning runs from the phone.
- Persistence of setup data. Values live in memory for the duration of
  the page session; nothing is sent to any remote service.

## Current serial recovery limit

Release `aliro-c6-v0.0.3-devkit` does not enable the CHIP shell. The
installer can reset the device once to capture a new boot log, but it cannot
use `matter onboardingcodes` to reprint missed codes. The parser supports
that command for a later firmware release. The current installer does not
send the command.
