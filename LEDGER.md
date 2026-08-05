# Running Ledger

Chronological record of findings, questions, and decisions. Newest at top.
Each entry is dated. Findings that harden into decisions get promoted.

## 2026-08-04 — Autonomous grind session (started)

### Findings

- `mullender/HomeKey-ESP32` already loads ESP Web Tools from unpkg with the
  moving `@10` tag (`installer/index.html` on branch
  `feat/pages-installer-workflow`). Vendoring in *this* repo does not
  disturb that.
- `mullender/HomeKey-ESP32` uses submodules extensively (nine under
  `components/`). Same idiom will fit here for the esp-web-tools fork.
- `.github/workflows/deploy-installer.yml` in HomeKey-ESP32 already
  downloads factory binaries from GitHub Release assets by tag
  (`improv-serial-*`) and serves them same-origin from Pages. This
  pattern is a good template for our own workflow keyed on
  `aliro-c6-*` (or equivalent) tag prefix.
- Stock `esp-matter/examples/door_lock` firmware prints
  `CHIP:SVR: SetupQRCode: [MT:...]` and `CHIP:SVR: Manual pairing code:
  [...]` at boot via `PrintOnboardingCodes()` inside `Server::Init()`.
  This eliminates the need for a custom firmware↔browser wire protocol.
- No `matter://` URL scheme exists anywhere; no browser-to-phone handoff
  possible. The QR must render on the desktop screen and be scanned.
- The M5 NanoC6 Grove pins map to `SDA=2, SCL=1`, matching the
  `sdkconfig.esp32c6.aliro` config exactly. No wiring changes needed for
  the reference build.

### Decisions

- **Repo split.** Aliro work lives in this new repo; HomeKey-ESP32 stays
  unchanged. Rationale: zero shared code, different frameworks,
  different chip families, different provisioning flows.
- **Per-firmware flasher.** Each firmware has its own `installer/`, its
  own Pages deployment, its own manifest. Only the ESP Web Tools fork is
  shared across (and only after upstream declines the PR).
- **Vendor only in this repo.** `mullender/esp-web-tools` fork is
  submoduled into `installer/vendor/esp-web-tools` here; HomeKey-ESP32
  is untouched. If upstream accepts the PR, both flashers can pin the
  new version at that time.
- **Repo name.** `aliro-doorlock-esp32` — protocol + Matter cluster +
  chip family. Enables future support for other ESP32 variants that have
  Thread or Wi-Fi radios and other NFC readers.
- **Firmware serial contract.** Use the stock `PrintOnboardingCodes()`
  output. The browser parser tails the boot log; no framed wire protocol.
- **Vendor+upstream in parallel** for ESP Web Tools. Fork now, open
  issue+PR in parallel, framed as a generic serial-callback hook (not
  Matter-specific).

### Open questions

- Which specific Aliro C6 release tag prefix should the Pages workflow
  key on? (`aliro-c6-*`, `aliro-c6-nfc-*`, `door_lock-c6-*`?)
- Does Apple Home accept test attestation on iOS 17+ builds today?
  Only evidence is a 2023 connectedhomeip issue.
- Which Thread border router is on the test bench for the first
  bring-up?
- Does the Unit NFC on the desk right now have the ST25R3916 chip, or
  the older PN532? The Aliro example is bound to ST25R3916.
- Repo licence terms for `esp_aliro_lib`: check the exact clause on the
  component registry entry before publishing built binaries.
- Should `firmware/` hold a downstream fork of `esp-matter/examples/door_lock`,
  or an overlay directory that references esp-matter by path?

### Blocked

- Phase 1 hardware proof: needs the NanoC6 + Unit NFC on a bench and a
  Thread border router on the LAN.
- Phase 5 firmware overlay: needs Phase 1 to be validated first; can
  design but not implement.
- Push to GitHub: needs the user to create the empty repos
  (`mullender/aliro-doorlock-esp32`, `mullender/esp-web-tools`).
