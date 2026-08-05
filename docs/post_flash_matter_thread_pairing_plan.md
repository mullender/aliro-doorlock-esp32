# Post-Flash Matter-over-Thread Pairing Plan

**Status:** feasible; ready for a hardware proof of concept  
**Date:** 2026-08-04

## Decision

The web flasher can show a Matter pairing QR code after it flashes an ESP32-C6.
The phone must still do the Matter commissioning in Apple Home, Google Home, or
the Home Assistant Companion app.

This flow does not need Wi-Fi on the ESP32-C6. The browser uses USB to flash the
device. The phone uses Bluetooth Low Energy to start Matter commissioning. The
phone then gives the device the Thread operational dataset. The QR code does not
contain the Thread dataset.

The stock esp-matter firmware already prints the `MT:` payload and the manual
pairing code to the serial console at boot through `PrintOnboardingCodes()` in
the Matter SDK. The browser can hold the Web Serial port after the flash
completes, read those log lines, and render the QR locally. No custom
firmware-to-browser wire protocol is needed for the initial flow.

## Repositories

Five repositories are involved. Two receive code changes; two are read-only
references; one is a new fork of a third-party tool.

| Repo | Owner | Purpose | Changes for this plan |
|---|---|---|---|
| `mullender/aliro-doorlock-esp32` (new) | this project | Aliro firmware overlay for ESP32-C6 boards, its own Chrome-browser flasher in `installer/`, and its own GitHub Pages deployment | All Aliro work: flasher UI, QR renderer, serial log parser, ESP Web Tools completion hook integration, C6 install choice, and (Phase 5) firmware overlay for unique credentials |
| `mullender/esp-web-tools` (new fork) | this project | Fork of `esphome/esp-web-tools` pinned to `10.4.0` with an added post-install callback. Consumed by the Aliro flasher only | Add the awaited post-install callback and exclusive serial handoff on branch `homekey-post-install-hook` (rename welcome). Open an upstream PR from this fork |
| `mullender/HomeKey-ESP32` | this project | HomeKit firmware for the ESP32-S3 build and its own flasher on the `gh-pages` branch | **Unchanged by this plan.** If the upstream ESP Web Tools PR lands, the HomeKey flasher may later pin to that release; it does not vendor the fork today |
| `espressif/esp-matter` | Espressif | Reference Aliro implementation in `examples/door_lock`; targets NanoC6 + Unit NFC on the same pins as this project | Read only. The Aliro firmware overlay builds against this repo (either as a submodule or a pinned checkout) but does not modify it |
| `project-chip/connectedhomeip` | Matter SDK (pulled in as an esp-matter submodule) | Contains `PrintOnboardingCodes()` and the setup payload encoder | None. Read only, for reference |

The Aliro firmware binary is built out of `esp-matter/examples/door_lock` with
the `sdkconfig.esp32c6.aliro` config. The build artifact and its manifest live
under the new `aliro-doorlock-esp32` repo's release pipeline and Pages
deployment. It does **not** share the HomeKey repo's release channel.

Rationale for the split: the HomeKit S3 firmware and the Aliro C6 firmware
share no code, no framework (HomeSpan vs esp-matter), no ESP-IDF pin, no NFC
driver, no chip family, and no post-flash pairing flow. The only cross-cutting
concern is the ESP Web Tools fork, and the upstream PR removes even that if it
lands.

## Main Constraints

1. ESP Web Tools 10.4.0 has no public post-install event. It also keeps ownership
   of the serial port while its dialog is open.
2. The current Aliro development build uses the shared Matter example values:
   passcode `20202021`, discriminator `3840`, QR payload
   `MT:Y.K9042C00KA0648G00`, and manual code `34970112332`.
3. The shared example values are suitable only for development. Nearby devices
   with the same discriminator are hard to identify. A shared passcode also
   removes per-device proof of possession.
4. QR rendering needs the `MT:` payload string. The stock esp-matter firmware
   already emits it on the serial console at boot; the browser can parse it
   there and does not need the passcode and discriminator as separate fields.
5. A production Matter device normally stores a SPAKE2+ verifier, not the setup
   passcode. The verifier is one-way data. The firmware must print the `MT:`
   payload while the plaintext passcode is still available (that is, on the
   same boot that generated it), or a provisioning service must supply it.
6. Apple Home, Google Home, and Home Assistant can scan the standard Matter QR.
   They do not offer one common browser deep link for commissioning. No
   `matter://` URL scheme exists.
7. Matter-over-Thread normally needs a Thread border router. The phone needs
   Bluetooth and access to the correct Thread credentials.
8. The browser cannot reliably confirm that the native app completed adoption.
   The final success state must remain in the native app.
9. The stock `MT:` log line ships in `chip::DeviceLayer` and depends on Matter
   SDK version. The parser must tolerate the older `CH:` prefix, an alternate
   log tag, and boot lines interleaved with other output.

## Recommended Flow

```text
GitHub Pages flasher
  -> ESP Web Tools flashes the NanoC6 over USB
  -> flasher keeps the Web Serial port and reads the boot log
  -> firmware boots and prints "SetupQRCode: [MT:...]" and "Manual pairing code: [...]"
  -> browser extracts the MT: payload and manual code from the log
  -> browser renders the QR locally
  -> user scans it in a native phone app
  -> phone commissions over BLE and supplies Thread credentials
  -> device joins the Thread network
```

The NanoC6 does not run Wi-Fi in this flow. Aliro does not change the base Matter
commissioning transport.

## Firmware Serial Contract

The MVP relies on the stock esp-matter boot log. `Server::Init()` calls
`PrintOnboardingCodes()`, which emits these lines through the `CHIP:SVR`
logging tag:

```
CHIP:SVR: SetupQRCode: [MT:-24J042C00KA0648G00]
CHIP:SVR: Copy/paste the below URL in a browser to see the QR Code:
CHIP:SVR: https://project-chip.github.io/connectedhomeip/qrcode.html?data=MT%3A-24J042C00KA0648G00
CHIP:SVR: Manual pairing code: [34970112332]
```

The browser parser must:

- Match the `MT:` payload from the `SetupQRCode: [MT:...]` line, case
  sensitive, with a Base38 character-set check.
- Match the eleven-digit manual code from `Manual pairing code: [...]`.
- Tolerate the older `CH:` prefix and alternate SDK log tags.
- Ignore the hosted `qrcode.html` URL. The QR must render locally.
- Confirm both codes decode to the same discriminator before it shows the
  pairing panel.

The parser must **not** send the log, the `MT:` string, or the manual code to
any remote service, URL, analytics event, or public release catalogue.

If the boot log is missed (slow serial attach, USB re-enumeration), the
flasher issues the Matter shell command `matter onboardingcodes` on the same
serial port to re-emit both lines. The shell must be enabled in the Aliro
`sdkconfig` overlay for this fallback to work.

For Phase 5, the firmware generates a unique setup passcode on first boot,
derives the SPAKE2+ verifier, and stores both. `PrintOnboardingCodes()` then
emits the per-device values through the same log lines. The wire contract
does not change; only the values do.

## Flasher Integration

All changes in this section land in `aliro-doorlock-esp32` under `installer/`.
The HomeKey-ESP32 flasher is not touched.

### Development proof of concept

Prove the pairing flow with the shared example values before any log-tail work.

1. Add a separate Aliro/NanoC6 install choice and manifest.
2. Use `chipFamily: "ESP32-C6"`.
3. Set `new_install_improv_wait_time` to `0`. Improv configures Wi-Fi and is not
   part of the Thread commissioning flow. The existing manifest field
   `improv: true` has no effect in ESP Web Tools 10.4.0.
4. Pin ESP Web Tools to an exact version. Do not load the moving `@10` tag.
5. Add a local QR renderer. Include the QR quiet zone and use enough pixels for
   a phone to scan the desktop screen.
6. Display the fixed development `MT:` payload and manual code next to the QR.
7. Use an explicit **Continue to pairing** action until the log-tail path lands.

This phase verifies the QR renderer and the pairing UX before the serial reader
exists.

### Integrated post-flash flow

Vendor a pinned ESP Web Tools `10.4.0` under `installer/vendor/` in
`aliro-doorlock-esp32`, and patch in an awaited post-install callback that
fires while the library still owns the serial port. Open an upstream issue
and PR in parallel, framed as a generic serial-callback hook rather than a
Matter feature. If the upstream hook merges, drop the vendored copy in
`aliro-doorlock-esp32` and adopt the CDN build (at an exact pinned version).
The HomeKey-ESP32 flasher does not vendor the fork.

Add these behaviors:

1. Complete the flash and reopen the serial port.
2. Run the awaited log-tail before ESP Web Tools starts Improv or another
   serial reader.
3. Parse the boot log for the `MT:` payload and the manual code, then release
   all serial stream locks.
4. Emit `install-complete` with the parsed payload and manual code.
5. Emit separate flash, parse, cancel, and timeout failures.
6. Reveal the pairing panel only after the client renders and verifies the QR.
7. Keep the HomeKey ESP32-S3 Improv flow unchanged.
8. Pin and self-host the forked JavaScript so that a new upstream minor release
   cannot change the installer without review.

Do not inspect private shadow DOM, scrape dialog text, or treat the internal
`closed` event as success. That event has no result and also fires after cancel.

### Serial log tail

The tail must be the only serial reader while it runs. It must retry while the
new firmware starts and the USB device re-enumerates.

Read lines until it matches the two `CHIP:SVR` lines described in **Firmware
Serial Contract**, or until a bounded timeout expires. On timeout, issue the
`matter onboardingcodes` shell command on the same serial port to re-emit both
lines. Return an error if the retry also fails.

The parser reads and discards; it never writes to flash. The firmware keeps
authority over the SPAKE2+ verifier and the stored passcode.

## Phone User Experience

After the flash succeeds, show these instructions:

1. Keep the NanoC6 powered and keep the phone close to it.
2. Turn on Bluetooth on the phone.
3. Confirm that the home has a compatible Thread border router.
4. Open Apple Home, Google Home, or the Home Assistant Companion app.
5. Choose **Add Matter device** or **Add accessory**.
6. Scan the QR code on the computer screen. Use the manual code if scanning is
   not possible.
7. Finish the process in the phone app.

Add a selector for Apple Home, Google Home, and Home Assistant. Show exact steps
for the selected app. Do not add unsupported commissioning deep links.

Also show these limits:

- Home Assistant commissioning must start in its Companion app, not its web UI.
- The phone must have access to the Thread network that it will give the device.
- Development attestation data can cause a warning or a platform-specific setup
  requirement.
- Matter adoption and Aliro wallet-key issuance are separate operations. Do not
  claim that a wallet key exists until that platform behavior is verified.

## Production Credential Plan

Changes in this section land in the Aliro firmware build (a downstream fork of
`esp-matter/examples/door_lock`, or an equivalent overlay in this project).
The flasher parser is unchanged; only the printed values change.

Complete this phase before the flasher is presented as a secure public
provisioning tool.

1. Generate a unique valid setup passcode and full discriminator on first boot
   or in a controlled provisioning step.
2. Derive and store the SPAKE2+ verifier and salt that match the passcode.
3. Emit the values through the existing `PrintOnboardingCodes()` log lines on
   the same boot that generated them.
4. Keep the plaintext passcode readable until `PrintOnboardingCodes()` runs at
   least once after generation, then discard it.
5. Define recovery for power loss, a closed tab, and a missed log tail. Provide
   a `matter onboardingcodes` re-emit that works while the SPAKE2+ verifier is
   present (the setup payload does not require the plaintext passcode after
   the discriminator, salt, and verifier iterations are known, because the
   passcode itself is only referenced during commissioning by the phone).
6. Decide whether a factory reset restores the same setup data or creates new
   data.
7. Do not run a full-chip erase on a pre-provisioned device unless the flow can
   restore its commissioning and attestation data.

For a personal prototype with one device, keep the shared example mode clearly
marked as development. Do not describe it as the final credential design.

## Work Plan

Each phase names the repo that owns its changes.

### Phase 1: Hardware proof (esp-matter build + `aliro-doorlock-esp32`)

- Build `esp-matter/examples/door_lock` with `sdkconfig.esp32c6.aliro`.
- Flash the NanoC6 with the built image (any means — `idf.py flash` is fine).
- Display `MT:Y.K9042C00KA0648G00` and `34970112332` on a local test page.
- Commission through one phone ecosystem over Thread.
- Confirm that the device uses BLE during commissioning and does not enable
  Wi-Fi.
- Confirm that the boot log contains `CHIP:SVR: SetupQRCode: [MT:...]` and
  `CHIP:SVR: Manual pairing code: [...]`.
- Record whether Aliro setup completes or causes Matter commissioning to roll
  back.

Exit condition: one NanoC6 joins a Thread fabric from a QR shown in a desktop
browser, and the expected serial lines are recorded.

### Phase 2: Local QR renderer (aliro-doorlock-esp32 `installer/`)

- Add a JS QR renderer that accepts a raw `MT:` string.
- Add a separate Aliro manifest and install choice so the S3 Wi-Fi
  instructions do not appear for the C6 build.
- Add a Base38 sanity check on the `MT:` string.
- Add encode/decode round-trip tests against the shared example payload.
- Show both the QR and the manual code on the pairing panel.

Exit condition: the page renders a scan-ready QR from
`MT:Y.K9042C00KA0648G00` without a remote service, and a phone commissions
from that on-screen QR.

### Phase 3: Pairing interface polish (aliro-doorlock-esp32 `installer/`)

- Add copy, download, and print actions for the QR and manual code.
- Add platform-specific instructions (Apple Home, Google Home, Home Assistant
  Companion).
- Add retry, cancel, and factory-reset help.
- Keep onboarding data out of telemetry and URLs.

Exit condition: the page displays a scan-ready QR and complete platform
instructions without a remote service.

### Phase 4: Serial log tail (aliro-doorlock-esp32 `installer/` + vendored ESP Web Tools)

Repository layout inside `aliro-doorlock-esp32`:

```
installer/
  index.html                 references vendor/dist/install-button.js
  vendor/
    esp-web-tools/           git submodule -> mullender/esp-web-tools
                             pinned to branch homekey-post-install-hook
    UPSTREAM.md              records the upstream issue/PR URL and state
.github/workflows/
  deploy-installer.yml       new workflow for this repo's own Pages site
```

Steps:

- Fork `esphome/esp-web-tools` to `mullender/esp-web-tools`. Branch from
  the `10.4.0` tag into `homekey-post-install-hook` (rename welcome).
- In `aliro-doorlock-esp32`, add the submodule:
  `git submodule add https://github.com/mullender/esp-web-tools.git installer/vendor/esp-web-tools`.
- Author `installer/index.html` from scratch for the Aliro C6 flow. Do not
  copy the HomeKey S3 installer wholesale; the post-flash flow is
  completely different (QR + Thread instructions vs Improv Wi-Fi form).
- Reference the vendored build with a local script tag:
  `./vendor/dist/install-button.js`. Do not load the moving `@10` tag from
  unpkg.
- Apply the callback patch on the fork's branch: an awaited post-install
  callback and exclusive serial handoff. Commit the patch on the fork, then
  bump the submodule SHA in this repo.
- Author `.github/workflows/deploy-installer.yml` for `aliro-doorlock-esp32`:
  - Enable submodule checkout: `submodules: recursive` on
    `actions/checkout@v4`.
  - Add `actions/setup-node@v4` with `node-version: "20"` and npm caching
    keyed on `installer/vendor/esp-web-tools/package-lock.json`.
  - Run `npm ci && npm run build` in `installer/vendor/esp-web-tools`.
  - Copy `installer/vendor/esp-web-tools/dist/web/` to `_site/vendor/dist/`.
  - Reuse the download-verify-manifest pattern from the HomeKey-ESP32
    workflow, but scoped to this repo's Aliro C6 release tag prefix (for
    example `aliro-c6-*`). Do not reach across to HomeKey release tags.
  - Trigger on `release: published`, `workflow_dispatch`, and `push` scoped
    to `installer/**`.
- Open an upstream issue on `esphome/esp-web-tools`. Follow it with a PR
  framed as a generic serial-callback hook, not a Matter feature. Link the
  fork's branch as the reference implementation. Record the upstream
  issue/PR URL and state in `installer/vendor/UPSTREAM.md`.
- Add the line-oriented parser for `CHIP:SVR: SetupQRCode: [MT:...]` and
  `Manual pairing code: [...]`.
- Add the `matter onboardingcodes` re-emit fallback when the boot log is
  missed.
- Add the public `install-complete`, cancel, timeout, and parse-failure
  results.
- Connect only the Aliro success result to the pairing panel.

Transition back to upstream (post-Phase 4):

- If the upstream PR merges into a released version (for example `10.5.0`):
  remove the submodule and the Node build step from `aliro-doorlock-esp32`,
  replace the local script reference with a single `<script>` tag pointing
  at unpkg with the exact pinned version. Do not re-adopt the moving `@10`
  tag. Consider back-porting the same pinned version into HomeKey-ESP32's
  flasher at the same time.
- If declined: keep the vendored fork in `aliro-doorlock-esp32`. Review
  upstream releases quarterly and rebase the callback patch as needed.
  Update `installer/vendor/UPSTREAM.md`.

Exit condition: a failed, canceled, or missed-log result never shows pairing
data or a false success state; and a normal flash automatically opens the
pairing panel with the parsed QR.

### Phase 5: Unique device credentials (Aliro firmware build)

- In the Aliro firmware overlay, generate a unique passcode, discriminator,
  verifier, and salt on first boot.
- Confirm that `PrintOnboardingCodes()` emits the per-device values through
  the same log lines Phase 4 already parses.
- Add secure removal, reset, and recovery rules.
- Test two devices at the same time.

Exit condition: two nearby devices have different valid payloads, each QR
commissions only its matching device, and the flasher needs no code change
between Phase 4 and Phase 5.

## Test Matrix

Test these cases before release:

- Chrome and Edge on macOS, Windows, and Linux.
- NanoC6 flash, reset, USB re-enumeration, cancel, retry, and power loss.
- Apple Home, Google Home, and Home Assistant Companion app.
- Valid Thread border router, missing border router, and wrong Thread network.
- QR scan and manual-code entry.
- New device, already commissioned device, and factory-reset device.
- Two uncommissioned devices powered at the same time.
- Aliro initialization success and failure.
- Full-chip erase with development data and partition-preserving update with
  production data.

## Acceptance Criteria

- The C6 flow never asks for a Wi-Fi SSID or password.
- The page shows the QR only after the flash succeeds and the parser reads a
  valid `MT:` payload and manual code from the serial log.
- The displayed payload matches the flashed commissioning data.
- The browser renders the QR locally from the parsed `MT:` string.
- The QR starts Matter commissioning in each supported phone app.
- The phone supplies Thread credentials over the normal Matter flow.
- The page always provides the manual pairing code.
- The page sends no onboarding payload to a third party.
- The page does not claim that adoption succeeded before the phone app confirms
  it.
- Production mode uses unique per-device credentials.

## Open Decisions

- Is the first release only a personal development build, or must it support
  unique credentials at launch?
- Which Thread border routers and phone ecosystems are required for the first
  supported test matrix?
- Confirmed direction on ESP Web Tools: vendor a pinned fork of `10.4.0`
  under `installer/vendor/` in `aliro-doorlock-esp32` only, and open an
  upstream issue plus PR in parallel. Frame the ask generically ("await
  this callback before the library releases the serial port") rather than
  as a Matter feature — the library's audience is Improv-centric and a
  Matter-specific PR is unlikely to land. Switch back to the CDN build if
  the upstream hook merges. The HomeKey-ESP32 flasher does not vendor the
  fork today. Open sub-question: what licence and attribution changes does
  vendoring `esp-web-tools` require in `aliro-doorlock-esp32`?
- Confirmed direction on repo split: create a new `aliro-doorlock-esp32`
  repo. It owns the Aliro firmware overlay (Phase 5), its own flasher,
  its own GitHub Pages deployment, and the vendored ESP Web Tools fork.
  The HomeKey-ESP32 repo is unchanged by this plan.
- Will the Aliro firmware overlay live as a downstream fork of
  `esp-matter/examples/door_lock`, or as an overlay directory inside
  `aliro-doorlock-esp32` that builds against a pinned esp-matter checkout?
- Will the device generate the production passcode on first boot, or will a
  provisioning service supply it?
- What reset action reopens the commissioning window without destroying the
  factory identity?

## Primary Evidence

- ESP-Matter commissioning examples and default payload:
  [developing.rst](https://github.com/espressif/esp-matter/blob/main/docs/en/developing.rst)
- ESP-Matter production and manufacturing data:
  [production.rst](https://github.com/espressif/esp-matter/blob/main/docs/en/production.rst)
- Matter onboarding payload generation and boot-time print:
  [OnboardingCodesUtil.cpp](https://github.com/project-chip/connectedhomeip/blob/master/src/app/server/OnboardingCodesUtil.cpp)
  (path may vary by SDK version; also see `src/setup_payload/`)
- Aliro reference example (door_lock on ESP32-C6 with Unit NFC):
  [esp-matter/examples/door_lock](https://github.com/espressif/esp-matter/tree/main/examples/door_lock)
- ESP Web Tools 10.4.0 install button and port lifecycle:
  [install-button.ts](https://github.com/esphome/esp-web-tools/blob/10.4.0/src/install-button.ts),
  [install-dialog.ts](https://github.com/esphome/esp-web-tools/blob/10.4.0/src/install-dialog.ts), and
  [connect.ts](https://github.com/esphome/esp-web-tools/blob/10.4.0/src/connect.ts)
- Google Matter pairing:
  [Pair a Matter-enabled device](https://developers.home.google.com/matter/integration/pair)
- Apple Matter setup:
  [Pair and manage Matter accessories](https://support.apple.com/en-us/102135)
- Home Assistant Matter and Thread setup:
  [Matter](https://www.home-assistant.io/integrations/matter/) and
  [Thread](https://www.home-assistant.io/integrations/thread/)
- Web Serial retained permissions:
  [Serial.getPorts()](https://developer.mozilla.org/en-US/docs/Web/API/Serial/getPorts)
