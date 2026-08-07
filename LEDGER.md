# Running Ledger

Chronological record of findings, questions, and decisions. Newest at top.
Each entry is dated. Findings that harden into decisions get promoted.

## 2026-08-07: esp-web-tools upstream PR opened

- Upstream PR
  [esphome/esp-web-tools#733](https://github.com/esphome/esp-web-tools/pull/733),
  **Add an awaited post-flash callback**, is open.
- The PR adds the serial handoff that this installer needs after a successful
  flash and before Improv starts. It includes contract documentation and tests.

## 2026-08-07: NanoC6 hardware result and S3 Lite assessment

### Verified NanoC6 findings

- The public browser installer can factory-install
  `aliro-c6-v0.0.4-devkit` on the NanoC6. Its native USB log supplies the
  Matter QR payload and manual pairing code.
- Apple Home commissions the device as a Matter-over-Thread door lock with
  the development build's test attestation.
- Apple Home configures the Aliro reader and provisions an Apple Home Key.
  The iPhone selects the Home Key automatically at the Unit NFC reader. The
  reader completes a valid Aliro transaction.
- The NanoC6 boot log lists two stored Matter fabrics. Their vendor IDs are
  `0x1349` for Apple Home and `0x1384` for Apple Keychain. This result does not
  verify that Apple Home and Google Home can provision Aliro keys at the same
  time.
- The installer's settings panel reads and writes the `ALIRO/1` settings on
  the NanoC6.
- Release 0.0.4 is tap-to-unlock. A valid tap calls the Matter unlock action.
  With auto-relock enabled, the Matter timer locks the device after the set
  delay. A valid tap while the lock is already unlocked does not lock it.
  Tap-to-toggle is not a verified release behavior.

### Verified persistence design; hardware check pending

- The firmware source stores settings in NVS. The keep-setup manifests write
  only the OTA app partitions, and the installer rejects erase requests for
  this path. These files preserve NVS by design.
- A keep-setup update on the paired NanoC6 has not been verified on hardware.
  Retention of the two fabrics, Thread credentials, Aliro data, settings, and
  the existing Home Key after that update is not yet verified.

### Verified inputs for an S3 Lite assessment

- The AtomS3 Lite and Unit NFC are a verified hardware pair. The Unit NFC
  uses SDA GPIO 2 and SCL GPIO 1. The AtomS3 Lite uses RGB GPIO 35.
- The separate HomeKey-ESP32 work verified browser installation, Wi-Fi
  setup, Home Key taps, and the RGB LED on this hardware.
- The pinned `esp-matter` door-lock project has an ESP32-S3 target. Its
  `m5nfc` dependency and the precompiled Aliro library include ESP32-S3.
- ESP32-S3 has no IEEE 802.15.4 radio. An Aliro S3 build variant must use
  Matter over Wi-Fi, with BLE for Matter commissioning.
- This repository has not built or tested an AtomS3 Lite Aliro image.

### Proposal, not a decision or verified result

- For a later release, apply a valid tap as follows. Always unlock a locked
  lock. If auto-lock is off, lock an unlocked lock. If auto-lock is on and the
  lock is already unlocked, do not change the state and do not restart the
  auto-lock timer. An active timer can lock it later. Release 0.0.4 does not
  implement this rule.
- Run a test build for a separate `aliro-s3-*` development variant. Keep the
  verified NanoC6 Thread variant unchanged.
- Give the S3 variant its own board overlay, release tags, artifacts,
  manifests, partition-layout check, installer choice, and Wi-Fi setup text.
- Reuse portable Aliro patches, but change the board-specific RGB and target
  settings. Do not reuse the HomeKey-ESP32 Improv flow. Matter commissioning
  must supply the Wi-Fi credentials.
- Do not publish the variant until the build, factory install, Apple Home
  Matter-over-Wi-Fi commissioning, Home Key tap, preserving update, and LED
  behavior pass on AtomS3 Lite hardware.

## 2026-08-05: NanoC6 serial-output investigation

### Approved findings

- The `aliro-c6-v0.0.1-devkit` build uses UART0 as its primary
  console. USB Serial/JTAG is only the secondary output channel.
- ESP-IDF documents that the secondary USB channel supports output
  only. Console input and REPL commands require USB Serial/JTAG as
  the primary console.
- `CONFIG_ENABLE_CHIP_SHELL` is disabled in the built firmware. The
  installer's `matter onboardingcodes` fallback command cannot run.
- The published ELF has no `PrintOnboardingCodes` symbol and no
  `SetupQRCode` or `Manual pairing code` strings. Contrary to an
  older ledger entry below, the pinned `esp-matter` door-lock example
  does not print the Matter onboarding codes.
- Neither the ESP Web Tools reset action nor the NanoC6 physical reset
  produced visible USB logs. This confirms that the fault is not only
  in the web reset action.
- HomeKey-ESP32 uses `CONFIG_ESP_CONSOLE_USB_SERIAL_JTAG=y`, which is
  the correct console mode for a board connected through native USB.

The user approved these facts after the physical-reset test.

### Decision

- Publish a new prerelease. Do not replace the known-bad v0.0.1
  asset.
- Make USB Serial/JTAG the primary console.
- Apply a small, audited source patch during the pinned build so the
  door-lock example calls `PrintOnboardingCodes()` after Matter starts.
- Replace the invalid shell-command fallback with a hardware reset
  request. The reset gives the parser a second chance to read the
  boot-time pairing lines.

## 2026-08-05: First release build prep (on `feat/first-release`)

Prepares the first installable release: `aliro-c6-v0.0.1-devkit`.

### Findings

- **Shared esp-matter tree is dirty and git-lfs missing.** Snapshotted
  the target commit (`85c76a1`) via `git archive | tar -x` into a
  temp directory instead of a fresh clone or worktree. The archive
  writes an empty `connectedhomeip/connectedhomeip/` placeholder;
  we replaced it with a symlink into the shared checkout's populated
  submodule so we don't have to re-clone the 14 GB tree. Shared tree
  untouched.
- **ESP-IDF v5.5.4 confirmed** from
  `components/esp_common/include/esp_idf_version.h` (MAJOR=5,
  MINOR=5, PATCH=4). Skipped the `idf.py --version` call after a
  hang.
- **`CONFIG_ESP_MATTER_NVS_USE_COMPACT_ATTR_STORAGE` is unknown to
  esp-matter `85c76a1`.** `idf.py` drops it as an unrecognised
  symbol at set-target time. Removed from the overlay. Documented
  in `firmware/RELEASE.md` so a future esp-matter bump can revisit.
- **esp-matter `export.sh` reads `ESP_MATTER_PATH` without a
  default.** With `set -u` (nounset) in the build script, the
  source of that file trips on unbound-variable. `build_release.sh`
  now sets `ESP_MATTER_PATH=$ESP_MATTER_SRC` before sourcing.
- **Existing merged binaries in the shared esp-matter checkout** came
  from earlier ad-hoc builds against a dirty tree. They were not used.

### Decisions

- **Feature branch:** `feat/first-release`, off `origin/main`.
- **Release overlay contents:** exactly five verified BSP symbols:
  `BSP_BUTTONS_NUM=1`, `BSP_BUTTON_1_TYPE_GPIO=y`,
  `BSP_BUTTON_1_GPIO=9`, `BSP_BUTTON_1_LEVEL=0`, `BSP_LEDS_NUM=0`.
  Nothing else. The base `sdkconfig.esp32c6.aliro` supplies every
  other setting.
- **Git ignores artifacts.** The binary and its SHA-256 live at
  `artifacts/aliro-c6-v0.0.1-devkit/` locally and are uploaded to
  the GitHub Release; not tracked.
- **Snapshot approach** (`git archive` + connectedhomeip symlink)
  documented in `firmware/RELEASE.md` as the reproducible path.

### Result

- The clean build completed. The app image is 1,606,208 bytes. The
  merged factory image is 4,194,304 bytes.
- Factory SHA-256:
  `675247acf8660a8a0cab68dcb15634075a35f9ffa40842d9b3054f8a392d7fcf`.
- The app image checksum and validation hash are valid.
- The generated config enables Thread and Aliro over NFC. It disables
  the Wi-Fi station. The factory image has no portal or Wi-Fi
  credential markers.
- GitHub prerelease `aliro-c6-v0.0.1-devkit` now contains the factory
  binary, SHA-256 file, and part manifest.
- The `github-pages` environment now allows tags that match
  `aliro-c6-*`. Workflow run `31031424301` passed after this rule was
  added.
- The live installer selects ESP32-C6 and offset `0`. The public 4 MB
  binary matches the release SHA-256.

---

## 2026-08-05 — GitHub push (completed)

Both local repos are now on GitHub. The submodule reference resolves.

### Findings

- **Fork was pre-populated.** `mullender/esp-web-tools` was created as
  a GitHub fork of `esphome/esp-web-tools`, not an empty repo. Its
  `main` already tracked upstream HEAD (SHA `4b1ef27`, 544 commits
  past the `10.4.0` tag). Local `main` was reset to `origin/main` to
  avoid overwriting upstream progress.
- **Feature branch rebased onto real tag `10.4.0`.** Original branch
  parented the callback commit on a fresh orphan "vendor 10.4.0"
  commit whose tree matched the tag but not its history. Verified
  tree equality (`b796448c...` both sides), then rebased with
  `git rebase --onto refs/tags/10.4.0 91547f2 homekey-post-install-hook`.
  Callback commit's SHA changed (`3953774` → `cc9ac93`) but its diff
  and message are identical. Branch now sits directly on `10.4.0`,
  clean history for an upstream PR.
- **Tag `10.4.0` was NOT pushed to the fork.** GitHub forks don't
  inherit tags by default; pushing one selectively creates
  asymmetry. The branch references the tag SHA and `git fetch
  upstream --tags` reveals it — that is enough.
- **Aliro remote was empty.** All eight branches pushed cleanly
  (`main` + 7 phase branches).
- **Submodule attached and pinned** to `cc9ac93` via
  `scripts/setup_vendor.sh`. Bootstrap ran `npm ci` + `script/build`
  successfully; `dist/` is gitignored inside the submodule so only
  the SHA reference is committed.

### Decisions

- **Fork's `main` mirrors upstream `main`, unchanged.** The feature
  work lives entirely on `homekey-post-install-hook`.
- **Tag not pushed to fork.** Cleaner absence than partial parity.
  If we later want the fork's UI to compare branch↔tag, push at
  that point.

### Remaining blockers

- **The push to `main` may have triggered the deploy workflow.**
  `gh` CLI is sandboxed here, so I could not check run status.
  Look at
  <https://github.com/mullender/aliro-doorlock-esp32/actions>
  in the morning. Expected result: the workflow runs, publishes an
  empty-manifest site (no `aliro-c6-*` releases yet), and the Pages
  URL renders `installer/index.html` with the ESP Web Tools "no
  builds" state. If the workflow fails, `installer/vendor/UPSTREAM.md`
  and `MORNING_REVIEW.md`'s "Known landmines" section list the
  likely causes.
- **GitHub Pages must be enabled in the repo settings.** The
  workflow deploys to Pages but Pages itself is not on by default
  for a new repo. Settings → Pages → Source: "GitHub Actions".
- **Upstream esp-web-tools issue/PR text** still needs drafting.
  A clean branch on `10.4.0` makes this straightforward now.

---

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
