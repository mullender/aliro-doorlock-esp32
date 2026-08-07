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
    serial-monitor.js owns the live Web Serial monitor and port cleanup
    setup-flow.js     controls pairing, update, error, and cancel UI state
  vendor/
    qrcode.js         MIT-licensed QR generator (kazuhikoarase 2.0.4)
    esp-web-tools/    (Phase 4a) git submodule → mullender/esp-web-tools
    UPSTREAM.md       (Phase 4) tracks the upstream esp-web-tools PR
  tests/
    index.html        open in a browser to run every check
    serial-monitor-tests.js tests monitor lifecycle and live code parsing
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

Run the non-browser integration tests with:

```sh
node --test installer/tests/node-tests.mjs
```

## Live serial monitor

The installer has a local Web Serial monitor. If the site has permission for
exactly one serial port, the monitor connects to it automatically. Otherwise,
select **Connect device**, then select the device USB port. The monitor opens
the port at 115200 baud, starts its reader, and restarts the lock once. The
restart lets the page capture the boot status, pairing codes, and all Matter
fabrics. The page does not upload or persist the log. The page never opens the
port picker automatically.

The monitor has these controls:

- **Connect device** asks for serial-port permission, starts one reader, and
  restarts the lock once.
- **Reset device** sends the ESP reset signal and keeps the reader active.
- **Copy logs** copies all current console text to the clipboard.
- **Clear** removes the displayed log. It does not change the device.
- **Disconnect** stops the reader, releases its lock, and closes the port.

The monitor reads `SetupQRCode` and manual pairing-code lines. When both codes
are valid and match, it uses the normal setup flow to show the QR panel. The
same validation applies to post-install codes and live monitor codes.

Only one reader can own a serial stream. If another reader owns the stream,
close it and then select **Disconnect**. You can then connect again. A device
disconnect also stops the monitor and enables a new connection.

The flasher and monitor cannot own the port at the same time. If the monitor
is active, the first click on an install button stops the reader and closes
the port. The page then asks you to click the install button again. The second
click keeps the browser permission gesture that Web Serial requires and opens
the installer port picker.

Web Serial needs Chrome or Edge on desktop and a secure page. Use HTTPS or
localhost. If access is denied, allow serial access for the site and select
**Connect device** again.

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

## Serial recovery limit

Release `aliro-c6-v0.0.3-devkit` does not enable the CHIP shell. The
post-install parser can reset the device once to capture a new boot log, but
it cannot
use `matter onboardingcodes` to reprint missed codes. The parser supports
that command for a later firmware release. The current installer does not
send the command. The live monitor can also reset the device and read the new
boot log.
