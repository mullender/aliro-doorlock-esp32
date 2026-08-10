# firmware/

Aliro firmware overlay for ESP32 boards.

## Today (Phase 1 matrix)

The build produces variant-specific images from a single source tree.
`variants.json` is the single source of truth for the variant list,
per-variant sdkconfig overlays, patches, pin maps, and release artifact
names. Phase 1 ships three variants:

| Variant id           | Chip     | Transport | Board                |
|----------------------|----------|-----------|----------------------|
| `nanoc6-thread`      | ESP32-C6 | Thread    | M5Stack NanoC6       |
| `nanoc6-wifi`        | ESP32-C6 | Wi-Fi     | M5Stack NanoC6       |
| `atoms3-lite-wifi`   | ESP32-S3 | Wi-Fi     | M5Stack AtomS3 Lite  |

The build applies the same audited patches for every variant. It picks
per-variant sdkconfig overlays from `overlay/sdkconfig.release.<variant>.*`
and per-board pin maps from `board_config/<board>.h`. The pin map is
copied into `main/aliro_board_config.h` before patch application. Each
variant produces its own factory and app assets under one matrix release
tag `aliro-vX.Y.Z-devkit`.

- `overlay/sdkconfig.release.nanoc6-thread` contains the NanoC6 Thread deltas.
- `overlay/sdkconfig.release.nanoc6-wifi` contains the NanoC6 Wi-Fi deltas.
- `overlay/sdkconfig.release.atoms3-lite-wifi` contains the AtomS3 Lite Wi-Fi deltas.
- `base/sdkconfig.esp32s3.aliro` is the shared Aliro base for the S3 chip
  (the pinned esp-matter checkout has no `sdkconfig.esp32s3.aliro`).
- `board_config/nanoc6.h` and `board_config/atoms3_lite.h` describe the
  NFC unit and on-board WS2812 pins per board.
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
  RGB colors and durations. It also emits the variant and transport
  identifiers as additive fields on every `ALIRO/1 STATUS` line, using
  compile-time defines that the build script sets per variant.
- `patches/0007-toggle-lock-on-aliro-tap.patch` unlocks a locked lock after
  a valid tap. When auto-lock is off, it also locks an unlocked lock.
- `patches/0008-generalize-board-pins.patch` replaces the hard-coded
  NanoC6 GPIO 19/20 constants with macros from `main/aliro_board_config.h`
  and wraps the power-pin setup and teardown in `#if ALIRO_BOARD_HAS_RGB_POWER`.
  Boards with no power-enable pin (AtomS3 Lite) skip those calls at compile
  time. The macros default to the NanoC6 wiring so a source-only build
  without the board header still compiles.
- `RELEASE.md` contains the source pins, overlay symbols, build notes,
  and artifact contract.
- `../scripts/build_release.sh` builds from a clean esp-matter snapshot
  for one variant at a time. It compiles and runs the settings parser
  test before it starts the firmware build. The `--source-check` flag
  runs the patch + validation pipeline without invoking `idf.py` so
  every variant can be validated without a hardware or IDF setup.
- `../scripts/prepare_release.sh` still writes the legacy `aliro-c6-*`
  factory and update assets for the `nanoc6-thread` variant. Phase 1B
  extends it to cover every variant.

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
