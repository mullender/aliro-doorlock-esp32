# Running Ledger

Chronological record of findings, questions, and decisions. Newest at top.
Each entry is dated. Findings that harden into decisions get promoted.

## 2026-08-05 — Autonomous grind session (completed)

Full session: repo scaffolding through Phase 5 design. See
`MORNING_REVIEW.md` for the morning-of digest. This entry is the raw
record.

### Session findings

- **`esp-web-tools` post-install patch site is small and clean.** A
  research agent traced the port lifecycle in
  `esp-web-tools@10.4.0/src/{install-button,install-dialog,connect}.ts`.
  The port is open for a short window after `FlashStateType.FINISHED`
  and before `_initialize(true)` runs Improv. The Improv flow is
  literally the model for the same shape hook. Total patch:
  three files, ~40 lines added, one branch on top of vendored
  `10.4.0`. Now committed on
  `~/Development/esp-web-tools-fork` branch
  `homekey-post-install-hook`.
- **Fork build passes.** `npm ci && script/build` produced the full
  `dist/web/` tree including per-chip loaders (including
  `esp32c6-CB4Hlm-E.js`) after the patch was applied. No TypeScript
  errors, no rollup warnings.
- **Verhoeff check-digit computation matches the Matter shared
  example.** Body `[3,4,9,7,0,1,1,2,3,3]` → check digit `2`
  computed both in the browser-side JS and cross-checked via node.
  Full manual code: `34970112332`.
- **Both known encodings of the shared example payload are
  Base38-clean.** `MT:Y.K9042C00KA0648G00` and
  `MT:-24J042C00KA0648G00` both have 19-char bodies and use only
  characters from Matter's Base38 alphabet.
- **Boot log parser handles known SDK drift.** 10 synthetic fixtures
  covering the canonical SDK 1.x output, the older `CH:` prefix,
  tight/loose colon spacing, ANSI colour escapes, out-of-order
  lines, and interleaved unrelated logs. All 10 pass via node.
- **The stock esp-matter boot log has THREE useful markers, not
  two.** In addition to `SetupQRCode: [MT:...]` and
  `Manual pairing code: [...]`, the SDK prints a helper URL of the
  form `qrcode.html?data=MT%3A...`. The parser uses this URL line
  as a fallback when the tagged line is lost in log noise.
- **npm audit reports 9 vulnerabilities in `esp-web-tools`'s
  transitive dev deps.** Six high, two moderate, one low. Not a
  runtime concern (dev-only), but flagged for the upstream PR
  review: address alongside the callback change or note that we're
  not going to gate on it.
- **HomeKey-ESP32 `deploy-installer.yml` is a good template.** The
  download-verify-manifest Python is well-shaped and reused
  wholesale (with the tag prefix, chip family, and Node build step
  swapped). No changes to HomeKey.

### Session decisions

- **Apache-2.0 for the new repo.** Matches `esp-matter`. Vendoring
  `esp-web-tools` (also Apache-2.0) needs only an attribution
  line in `installer/vendor/UPSTREAM.md`.
- **Merge each phase branch back into `main`** with `--no-ff` so
  the phase boundary stays visible in `git log --graph`. Branches
  remain as unmerged tips for per-phase review.
- **Fall back to CDN esp-web-tools if the vendored submodule is
  missing.** Prevents `installer/index.html` from breaking during
  the setup window between "push to GitHub" and
  "`scripts/setup_vendor.sh` succeeds". Console warning explains
  why the pairing panel is disabled in fallback.
- **Publish the site even if no `aliro-c6-*` release exists yet.**
  The deploy workflow writes a placeholder manifest so the first
  push produces a live (if useless) Pages URL rather than a red
  workflow. Once the first release cuts, the manifest becomes
  populated on the next workflow run.
- **`push` trigger scoped to `installer/**`.** So a UI patch or a
  submodule bump republishes without waiting on a firmware release.
  Can be narrowed later if it becomes noisy.
- **Firmware overlay: Option B (component overlay).** Not a
  downstream fork of `door_lock`. Smaller review surface, easier
  to keep in sync with `esp-matter`. Written up in
  `firmware/DESIGN.md`.
- **Regenerating factory reset for the first release.** Sticky
  passcodes are a manufacturing concern; DIY use accepts a fresh
  QR after every factory reset.

### Session open questions (rolled forward)

- Which Aliro C6 release tag prefix is canonical? Deploy workflow
  keys on `aliro-c6-*`; nothing prevents a change but a change
  would need to be reflected in `deploy-installer.yml` too.
- Does Apple Home accept test attestation on iOS 17+ builds today?
  Only evidence is the 2023 connectedhomeip issue cited in
  `docs/aliro_matter_investigation.md`. Bring-up will confirm or
  refute.
- Which Thread border router is on the test bench for Phase 1?
- Does the Unit NFC on the bench right now have the ST25R3916
  chip, or the older PN532?
- Is `CONFIG_ENABLE_CHIP_SHELL=y` in the stock
  `sdkconfig.esp32c6.aliro`? The boot parser's re-emit fallback
  depends on it.
- Exact clause of the `esp_aliro_lib` licence for redistribution.

### Session blocked

- Push to GitHub: two empty repos need to be created first.
- Attach `installer/vendor/esp-web-tools` submodule: needs the fork
  to be pushed. `scripts/setup_vendor.sh` handles the sequence.
- Phase 1 hardware execution: needs the bench + border router.
- Firmware overlay implementation: needs Phase 1 to settle version
  pins.
- Upstream PR: draft the issue and PR text after Phase 4b lands on
  real hardware (so the PR can cite live boot log fixtures).

---

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

### Notes

- User typed a single `1` mid-turn while the QR library was being fetched.
  Interpreted as a stray keystroke; grind continued. If it was
  intentional, please clarify in the morning.

---

## Aliro-investigation directory

The original `~/Development/aliro-investigation/` still exists with the
four plan docs. Duplicates now live in `docs/`. The originals can be
removed after morning review confirms the docs/ copies are correct.
