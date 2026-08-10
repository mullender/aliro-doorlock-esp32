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
    device-protocol.js parses Aliro status and builds GET and SET requests
    device-settings.js controls the settings and firmware version UI
    install-controller.js wires the post-flash callback, captures ALIRO STATUS,
                          and installs the update-dialog erase guard
    update-dialog-guard.js patches the ESP Web Tools install dialog's open
                          shadow root so Update always keeps setup
    serial-monitor.js owns the live Web Serial monitor and port cleanup
    setup-flow.js     controls pairing, update, error, and cancel UI state
  vendor/
    qrcode.js         MIT-licensed QR generator (kazuhikoarase 2.0.4)
    esp-web-tools/    (Phase 4a) git submodule → mullender/esp-web-tools
    UPSTREAM.md       (Phase 4) tracks the upstream esp-web-tools PR
  tests/
    index.html        open in a browser to run every check
    device-settings-tests.js tests the settings UI in a browser
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
- **`vendor/esp-web-tools/`** — git submodule pointing to
  `mullender/esp-web-tools` on branch `feat/awaited-post-flash-callback`.
  The branch carries only PR 733 (an awaited `onPostFlash` callback) on
  top of upstream `esphome/esp-web-tools` main. The deployed page loads
  only this pinned, same-origin build. It has no CDN fallback.

## Install modes

The page offers two separate ESP Web Tools buttons:

- **Update firmware — keep setup** uses `manifest-update.json`. Its
  manifest sets `new_install_prompt_erase: true`, so ESP Web Tools shows
  the ASK_ERASE step. The installer patches only that dialog's open
  shadow root (see `installer/js/update-dialog-guard.js`) to hide the
  erase checkbox and force the keep-setup path. Update therefore always
  keeps Matter fabrics, Thread credentials, and Aliro reader
  configuration. Use Update only for a device that was previously
  installed from this repository with the approved
  `esp32c6-door-lock-4mb-v1` partition layout.
- **Factory install — erase everything** uses `manifest.json`. Its
  manifest sets `new_install_prompt_erase: false`, so ESP Web Tools
  auto-erases the entire flash. The Factory dialog is not patched. Use
  Factory install for a first install, recovery, or any device that
  does not use the approved layout.

After a successful flash, PR 733's `onPostFlash` callback receives the
open serial port. The Factory path reads the boot log for the Matter
setup codes, then sends one `ALIRO/1 GET` and reads a single timed
`ALIRO/1 STATUS` line. On timeout the reader releases its lock without
canceling the stream, so ESP Web Tools' own Improv init (or a later
monitor connection) can attach a fresh reader. Settings captured this
way populate the panel **read-only**: Apply stays disabled and submit
is refused until the serial monitor at the top of the page emits
`serial-connected` — the browser page never edits over a port it does
not own. Click **Connect device** to reclaim the port and edit
settings. The Update path marks setup preserved. When the callback
does not fire (for example, a deployed build without PR 733), the
serial monitor re-parses both codes and settings from the live boot
log — the same UI path, and settings are immediately writable because
the monitor owns the port.

## Device settings protocol

The live monitor reads lines that start with `ALIRO/1`. It sends
`ALIRO/1 GET` after a connection and sends one partial `ALIRO/1 SET` line when
the user applies changed settings. The settings panel stays hidden until the
monitor receives a complete, valid `ALIRO/1 STATUS` line for protocol 1.
Auto-lock accepts 0 through 3,600 seconds. Zero disables auto-lock. Each LED
duration accepts 0 through 10,000 milliseconds. If auto-lock is on and the lock
is locked, a valid tap unlocks it. If the lock is already unlocked, the tap
restarts the timer. If auto-lock is off, a valid tap unlocks a locked lock or
locks an unlocked lock.

The page gets the latest release version from `manifest-update.json`. It
normalizes the release tag before it compares the version with the installed
devkit version. The normal update action stays available when the version is
older or cannot be compared.

## What the installer does NOT do

- Optional Matter vendor TLV fields. The validator decodes the fixed setup
  fields and checks that the QR and manual code have the same discriminator
  and passcode.
- Bluetooth. Matter commissioning runs from the phone.
- Persistence of setup data. Values live in memory for the duration of
  the page session; nothing is sent to any remote service.

## Serial recovery limit

Release `aliro-c6-v0.0.5-devkit` does not enable the CHIP shell. The
post-install parser can reset the device once to capture a new boot log, but
it cannot
use `matter onboardingcodes` to reprint missed codes. The parser supports
that command for a later firmware release. The current installer does not
send the command. The live monitor can also reset the device and read the new
boot log.
