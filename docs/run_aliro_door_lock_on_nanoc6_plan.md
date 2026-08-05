# Run the Aliro Door Lock Example on M5 NanoC6 + Unit NFC

**Status:** ready for engineering execution
**Date:** 2026-08-04
**Companion documents:** `aliro_matter_analysis.md`, `aliro_matter_investigation.md`,
`post_flash_matter_thread_pairing_plan.md`

## Goal

Build the stock `esp-matter/examples/door_lock` firmware with the
`sdkconfig.esp32c6.aliro` config, flash it to an M5Stack NanoC6, wire it to an
M5Stack Unit NFC over Grove, and commission it into one Matter controller over
Thread. No firmware modifications in this plan. No changes to the flasher web
UI in this plan.

The output of this plan feeds Phase 1 of
`post_flash_matter_thread_pairing_plan.md` (hardware proof).

## Exit Criteria

An engineer can tick each item independently.

1. `idf.py build` succeeds for target `esp32c6` with `sdkconfig.esp32c6.aliro`.
2. `idf.py -p <port> flash monitor` boots the firmware and prints the two
   `CHIP:SVR` lines from `PrintOnboardingCodes()`:
   - `CHIP:SVR: SetupQRCode: [MT:...]`
   - `CHIP:SVR: Manual pairing code: [...]`
3. Boot logs show OpenThread initialization and **no** `esp_wifi_init` calls.
4. Boot logs show BLE (NimBLE) advertising for commissioning.
5. Boot logs show the ST25R3916 initialising on GPIO SDA=2, SCL=1, and an I2C
   probe finds the reader at its documented address.
6. A Matter controller with access to a working Thread border router
   commissions the device from the on-boot QR code, over BLE, and hands off
   Thread credentials.
7. After commissioning, the device is present in the controller's device list
   and the Aliro cluster (`0x0451`) attributes are readable.
8. The Aliro `SetAliroReaderConfig` command succeeds against the device with
   valid test values, and reading `AliroReaderConfig` returns those values.
9. A recovery step (erase + reflash + rejoin) works end-to-end with no manual
   steps beyond re-running `idf.py flash` and starting a new commissioning.
10. All commands, versions, and observations from this run are recorded in a
    lab notebook committed alongside this plan.

Steps 1-6 are hard requirements. Step 7-8 confirm the Aliro delegate is live.
Step 9 protects against non-recoverable flash state.

## Hardware

| Item | Part | Notes |
|---|---|---|
| MCU board | M5Stack **M5NanoC6** | ESP32-C6FH4, 4 MB flash, USB-C, Grove connector wired to GPIO 1 (SCL) and GPIO 2 (SDA) per M5 docs |
| NFC reader | M5Stack **Unit NFC** (ST25R3916 variant) | Grove-connected. Confirm the module is ST25R3916; the earlier PN532 Unit NFC is **not** the target of this example |
| Cables | USB-C data-capable cable, 4-wire Grove cable | USB-C must carry data, not just power. Grove cable ships with the Unit |
| Thread border router | Home Assistant + SkyConnect / Connect ZBT-1 / ZBT-2, **or** Apple HomePod (2nd gen / mini), **or** Google Nest Hub (2nd gen) | Confirm the router is on the same LAN as the controller and its OpenThread service is up |
| Phone or controller host | iPhone with iOS 17+ (Apple Home), Android with Google Play Services current (Google Home), **or** a laptop running Home Assistant Companion | See platform caveats in the Commissioning section |

If the Unit NFC in hand is the PN532 variant, stop and reconvene. The
`aliro_reader` NFC component targets ST25R3916 only. The rest of the plan is
still valid for a bring-up without NFC, but the Aliro delegate cannot be
exercised end-to-end.

## Host Environment

Pinned versions. Do **not** float the tags. The reference code is six weeks
old at plan-writing time and its dependencies moved during that window.

| Component | Pin | Source |
|---|---|---|
| Host OS | macOS 14+ or Ubuntu 22.04+ | Any that supports the current ESP-IDF |
| ESP-IDF | version required by the checked-out esp-matter commit; read `esp-matter/tools/ci/idf_ref.sh` or the top-level README before installing | Do not assume the latest release. esp-matter frequently pins to a specific IDF branch or release-vX.Y line |
| esp-matter | pinned commit on `main` at the time of clone | Record the commit hash in the lab notebook |
| Matter SDK | via esp-matter's `connectedhomeip` submodule; do not check out a different commit | esp-matter pins the SDK; overriding it invites incompatibility |
| `esp_aliro_lib` | `^1.0.1` as declared by esp-matter | Declared in `examples/door_lock/main/idf_component.yml`; do not pin higher without a compatibility check |
| Python | Whatever ESP-IDF's `install.sh` provisions | Do not use the system Python |

Install ESP-IDF into `~/esp/esp-idf-<version>` and source its export script
in a dedicated shell for each build session. Do not mix it into the shell
that runs Node/Homebrew tooling.

## Repositories and Layout

```
~/Development/
  esp-matter/                             cloned once, submodules initialised
    connectedhomeip/                      submodule, pinned by esp-matter
    examples/door_lock/                   the example we build
```

If the project chooses the downstream-overlay path documented in
`post_flash_matter_thread_pairing_plan.md`, later work will add a small
overlay directory inside the new `aliro-doorlock-esp32` repo that
references `esp-matter` by path. This plan does not require the overlay.
Building the stock example is enough for the hardware proof.

Clone commands:

```
cd ~/Development
git clone --recursive https://github.com/espressif/esp-matter.git
cd esp-matter
git rev-parse HEAD > /tmp/esp-matter.commit          # record for lab notebook
git submodule status --recursive > /tmp/esp-matter.submodules
```

If the clone is slow or memory-bound, allow `--depth 1` on the submodule
init, but record that the shallow clone is in place — some esp-matter tools
scan git history.

## Wiring

M5 NanoC6 Grove connector to Unit NFC Grove connector using the shipped
Grove cable. No jumper wires required.

| Signal | NanoC6 GPIO | Unit NFC pin | Source of truth |
|---|---|---|---|
| SDA | 2 | SDA | `sdkconfig.esp32c6.aliro`: `CONFIG_ST25R3916_PIN_SDA=2` |
| SCL | 1 | SCL | `sdkconfig.esp32c6.aliro`: `CONFIG_ST25R3916_PIN_SCL=1` |
| 3V3 | Grove +5V pin (level-shifted internally on the Unit) | VCC | Grove cable |
| GND | GND | GND | Grove cable |

Before power-on, verify the Grove cable is seated all the way at both ends
and that the Unit's LED (if present) is off. Power-on the NanoC6 last.

## Build

```
cd ~/Development/esp-matter
. ./export.sh                              # exports ESP-IDF + esp-matter env
cd examples/door_lock
rm -rf build sdkconfig                     # start clean
idf.py -D SDKCONFIG_DEFAULTS="sdkconfig.esp32c6.aliro" set-target esp32c6
idf.py build 2>&1 | tee /tmp/aliro-build.log
```

Notes:

- Do **not** run `idf.py menuconfig` before the first build. The
  `set-target` step reads the SDKCONFIG_DEFAULTS overlay; opening menuconfig
  before it can freeze in a stale config.
- Expect the build to pull `m5nfc` (from `espressif/esp-aliro`) and the
  precompiled `esp_aliro_lib` archive. Confirm the download in the build
  log; a firewall that blocks the Espressif component registry is a common
  failure mode.
- `esp_aliro_lib` is a binary blob under a non-Apache licence. Its
  `libesp_aliro_idf6X.a` variant must match the ESP-IDF major version in
  use, or the link step fails with unresolved symbols. If linking fails
  here, check the ESP-IDF version first.
- Record the artefact sizes at the end of the build. `door_lock.bin` must
  fit the first `0x1E0000` app slot in `partitions.csv`. A slot overrun is
  the first sign that a config change is dragging in unwanted subsystems.

## Flash and First Boot

Plug the NanoC6 in over USB-C. Confirm the port name:

- macOS: `ls /dev/tty.usbmodem* /dev/cu.usbmodem*`
- Linux: `ls /dev/ttyACM*`

Erase, flash, monitor:

```
idf.py -p <port> erase-flash
idf.py -p <port> flash monitor
```

Erase is deliberate for the first boot: the partition table only holds
factory data if the flash is clean. Later boots do not need erase.

Expected boot log markers, roughly in order:

1. `II app_main: Aliro Reader started` (or the equivalent app_main banner
   from the example).
2. `CHIP:DL: OpenThread` initialisation lines, no `esp_wifi` lines.
3. `CHIP:BLE`/`NimBLE` advertising banner.
4. `CHIP:SVR: SetupQRCode: [MT:...]`.
5. `CHIP:SVR: Manual pairing code: [...]`.
6. ST25R3916 driver banner naming SDA=2, SCL=1, followed by an I2C probe
   result at the reader's documented address.

Record the full boot log to the lab notebook. This is the source data for
the `post_flash_matter_thread_pairing_plan.md` parser.

If the boot log is missed, connect a serial monitor and run the Matter
shell command `matter onboardingcodes` to re-emit the two lines. The shell
must be enabled in the config (`CONFIG_ENABLE_CHIP_SHELL=y`); if it is not,
re-flashing prints the codes again from the fresh boot.

## Commissioning

Pick **one** controller for the first pass. Cover the others in a second
round only after the first works end-to-end.

### Home Assistant Companion (recommended for the first pass)

- Confirm the Matter integration is enabled in HA and the Thread integration
  shows an active border router.
- Open the Companion app on the phone that is on the same LAN as HA.
- Add device → Matter → scan the QR code shown on the desktop screen
  (paste the `MT:` string into a QR generator temporarily if the flasher
  UI isn't ready yet).
- The commissioning session runs over BLE. Watch the device serial log;
  expect a `CHIP:BLE: Received handshake` line followed by
  `CHIP:DMG: Received command` chatter and finally a Thread dataset
  transfer.
- After commissioning, the device appears in the HA device list. Verify
  attributes on the door-lock cluster and any Aliro cluster the
  controller exposes.

### Apple Home

- iOS 17 or later.
- Add Accessory → More options → the device appears as an uncertified
  Matter accessory (test attestation warning). Accept the warning.
- If iOS refuses the QR, fall back to the manual code.

### Google Home

- Android with current Play Services.
- Add device → Matter-enabled device. Google Home's acceptance of test
  attestation VIDs is documented as inconsistent in the reference notes;
  this pass may fail with an attestation error. Record the exact error
  text.

Cross-platform limits worth noting:

- Test attestation is not a certified device identity. Apple and Google
  both retain the right to refuse commissioning; a refusal is a platform
  policy signal, not a firmware bug.
- Aliro commands from the controller are optional in Matter 1.4-era stacks
  and depend on the controller's support. HA does not yet expose Aliro
  actions in the UI; use `matter-server` CLI or the Matter shell to
  exercise the delegate directly.

## Aliro Delegate Exercise

After successful commissioning:

1. From `matter-server` or the Matter shell, read the Aliro cluster
   attributes. `NumberOfAliroCredentialIssuerKeysSupported` must equal 8;
   `NumberOfAliroEndpointKeysSupported` must equal 8.
2. Issue `SetAliroReaderConfig` with test values: 16-byte groupIdentifier,
   32-byte signingKey, 65-byte reader verification key. The delegate
   validates all three sizes.
3. Read `AliroReaderConfig` and confirm the write took effect.
4. Issue `ClearAliroReaderConfig` and confirm the attribute returns to its
   uninitialised state.

Do not use production Aliro keys in this bring-up. The values above are for
delegate validation only.

## Known Landmines

- **Unit NFC variant mismatch.** The M5 catalogue lists two Unit NFC
  products. The Aliro example is bound to the ST25R3916 build; a PN532
  Unit NFC will compile against the wrong driver or fail I2C discovery.
- **`m5nfc` and `M5UnitUnified` moving pins.** `M5UnitUnified` was v0.1.0
  at plan time with a dependency pinned to a moving branch. Freeze the
  component versions in a top-level `idf_component.yml` override if the
  build behaviour becomes unrepeatable.
- **ESP-IDF version drift.** esp-matter's tolerated IDF window is narrow.
  A `git pull` on ESP-IDF between build sessions can silently break the
  `esp_aliro_lib` link.
- **Test attestation on Google Home.** Rejection is expected on some
  release channels. Do not treat it as a firmware fault without
  cross-checking Apple Home or Home Assistant.
- **No Thread border router on the LAN.** BLE commissioning succeeds; the
  Thread dataset hand-off fails silently from the phone's UI perspective.
  Confirm the border router *before* diagnosing firmware behaviour.
- **Full-chip erase and Aliro data.** `erase-flash` wipes any Aliro
  reader config, credential issuer keys, and endpoint keys. This is
  intentional for bring-up and unacceptable in production. Track the
  boundary between bring-up erases and production-safe upgrades.
- **`esp_aliro_lib` licence.** The archive is not Apache-2.0. Confirm the
  licence terms before redistribution of the flashed binary. Espressif's
  standard model permits inclusion in end-user firmware; check the exact
  clause on the component registry entry.

## Rollback

If a build or flash session leaves the device in an unusable state:

```
idf.py -p <port> erase-flash
idf.py -p <port> flash monitor
```

If the NanoC6 stops enumerating over USB after a bad flash, hold the
BOOT/reset button in the M5 documented sequence to force the ROM
bootloader, then re-run `flash`. Record the recovery sequence in the lab
notebook; this hardware detail is easy to forget.

## Lab Notebook

Commit a `run_notes/` directory next to this plan. Each run records:

- Date, engineer, host OS.
- ESP-IDF version and the SHA at build time.
- `esp-matter` HEAD commit and submodule status.
- Full boot log capture, redacted only if it contains genuinely
  sensitive test material.
- `idf.py size` output.
- The controller used and the exact commissioning outcome.
- Any deviations from this plan and why.

The lab notebook is the input to the `post_flash_matter_thread_pairing_plan.md`
parser design; the boot-log samples become its test fixtures.

## Open Questions to Resolve Before Production

- Does Apple Home consistently accept test attestation from this build, and
  if not, which VID/PID pair (test-DAC or CSA-issued) unblocks it?
- Which specific Thread border router will the first-release test matrix
  target? The reference stack has three viable options; picking one
  simplifies the support surface.
- Is the plan's downstream overlay path preferred, or does the project
  fork `esp-matter/examples/door_lock` outright to hold local changes?
- What is the minimum Aliro credential-set the delegate must persist across
  reboots for a real-world unlock, and which esp-matter storage backend
  covers it today?

## Primary Evidence

- Aliro reference example (source of every claim in the Build section):
  [esp-matter/examples/door_lock](https://github.com/espressif/esp-matter/tree/main/examples/door_lock)
- Aliro config for ESP32-C6:
  [`sdkconfig.esp32c6.aliro`](https://github.com/espressif/esp-matter/blob/main/examples/door_lock/sdkconfig.esp32c6.aliro)
- Aliro delegate implementation:
  [`aliro_door_lock_delegate.cpp`](https://github.com/espressif/esp-matter/blob/main/examples/door_lock/main/lock/aliro_door_lock_delegate.cpp)
- Matter onboarding-code print at boot:
  [`OnboardingCodesUtil.cpp`](https://github.com/project-chip/connectedhomeip/blob/master/src/app/server/OnboardingCodesUtil.cpp)
- M5 NanoC6 pinout: M5Stack product docs.
- M5 Unit NFC (ST25R3916): M5Stack product docs.
- Espressif Aliro SDK announcement:
  [Espressif Aliro Solution blog](https://developer.espressif.com/blog/2026/07/espressif-aliro-solution/)
- Home Assistant Matter integration:
  [Matter](https://www.home-assistant.io/integrations/matter/) and
  [Thread](https://www.home-assistant.io/integrations/thread/)
- Companion documents in this directory:
  `aliro_matter_analysis.md`, `aliro_matter_investigation.md`,
  `post_flash_matter_thread_pairing_plan.md`
