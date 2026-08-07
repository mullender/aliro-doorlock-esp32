# firmware/

Aliro firmware overlay for ESP32 boards.

## Today (pre-Phase-5)

The MVP builds `esp-matter/examples/door_lock` against a pinned
esp-matter commit and ESP-IDF version, with a small NanoC6 release
overlay (`overlay/sdkconfig.release.nanoc6`) layered on top of the
stock `sdkconfig.esp32c6.aliro`.

- `overlay/sdkconfig.release.nanoc6` contains the board changes.
- `patches/0001-print-onboarding-codes.patch` makes the pinned example
  print its Matter pairing codes after startup.
- `patches/0002-advertise-aliro-credentials-only.patch` advertises
  Aliro and user credentials without PIN or over-the-air PIN support.
- `patches/0003-add-nanoc6-rgb-feedback.patch` controls the NanoC6
  RGB LED from the verified Aliro transaction result.
- `patches/0004-wire-aliro-ecp-and-generic-tags.patch` supplies the
  reader group identifier to ECP and handles selected non-ISO-DEP tags.
- `patches/0005-add-m5nfc-aliro-ecp.patch` adds ECP and activation
  results to the pinned managed `m5nfc` component.
- `patches/0006-add-aliro-settings.patch` adds the versioned serial
  settings protocol, NVS storage, auto-relock control, and configurable
  RGB colors and durations.
- `RELEASE.md` contains the source pins, overlay symbols, build notes,
  and artifact contract.
- `../scripts/build_release.sh` builds from a clean esp-matter snapshot.
  It also compiles and runs the settings parser test before it starts the
  firmware build.
- `../scripts/prepare_release.sh` creates a 4 MB factory binary and an
  app-only preserving-update binary, with SHA-256 files for both. It
  stages and cross-checks the complete set before it publishes it.

See also `../docs/run_aliro_door_lock_on_nanoc6_plan.md` for the
manual bring-up flow.

## Phase 5 (unique device credentials)

See `DESIGN.md` for the full design. Summary:

- Overlay component (`aliro_setup/`) that hooks into `Server::Init()`
  before it reads factory data. Generates a valid Matter passcode and
  12-bit discriminator on first boot, derives the SPAKE2+ verifier
  and salt, persists everything to NVS.
- Every subsequent boot reads the stored values and lets the Matter
  SDK's `PrintOnboardingCodes()` emit the per-device MT: string
  and manual pairing code through the same log lines the flasher
  parser already reads.
- No change to the flasher parser or the serial contract.
- Reset policy: regenerating (new values after factory reset).

Do not begin implementation until Phase 1 hardware proof has
established the pin, chip, IDF version, and esp-matter commit that
Phase 5 must target.
