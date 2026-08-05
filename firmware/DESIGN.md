# Firmware Overlay Design

**Status:** design only. Do not implement without Phase 1 hardware
proof passing first.

Phase 5 of the post-flash pairing plan: give each flashed device
unique setup credentials rather than the shared esp-matter example
values (`passcode=20202021`, `discriminator=3840`). No change is
required in the flasher — the boot log format is unchanged; only the
values printed change.

## Goals

1. Every device flashed from this project produces a distinct valid
   Matter setup passcode and 12-bit discriminator.
2. The SPAKE2+ verifier and salt on the device match those values.
3. `PrintOnboardingCodes()` prints the per-device MT: string and
   manual pairing code on every boot, so the flasher's serial-tail
   works verbatim without any protocol changes.
4. First flash and later factory-reset behaviour are both deliberate
   (not accidental drift).

## Non-goals

- CSA-issued device attestation (DAC / PAI / CD). Test attestation is
  fine for the first release. Certification is a separate track.
- Provisioning-service integration. First release: the device
  self-generates on first boot.
- Any change to the flasher's boot-log parser.

## Two viable structures

### Option A: downstream fork of `esp-matter/examples/door_lock`

- Own the tree under `firmware/door_lock/`.
- Diverge as needed for credential generation.
- Easy to hold local changes; hard to keep in sync with esp-matter
  releases.

### Option B: overlay directory that patches into a pinned esp-matter checkout

- Own only the delta: a small ESP-IDF component that hooks into
  `Server::Init()` before it reads factory data.
- Build script points `SDKCONFIG_DEFAULTS` at the pinned example plus
  the overlay component's Kconfig.
- Trades slightly more build glue for a much smaller diff to review.

**Recommended: Option B** for a personal project. A single component
with two files — a generator and a Kconfig — is easier to review than
a fork of a large example.

## Generation approach

On first boot, if NVS namespace `aliro_setup` has no stored passcode:

1. Generate a passcode by rejection-sampling
   `esp_random_bytes()` until the 27-bit result is one of the valid
   Matter passcodes (i.e., not one of the eleven forbidden values:
   00000000, 11111111, 22222222, ..., 99999999, 12345678, 87654321
   per Matter spec 5.1.1.6).
2. Generate a 12-bit discriminator: `esp_random_bytes()` masked to
   `0x0FFF`. Values 0 and 4095 are permitted per the spec.
3. Derive the SPAKE2+ verifier and salt from the passcode using the
   Matter SDK's `Spake2pVerifier::Generate` helper (source:
   `connectedhomeip/src/crypto/CHIPCryptoPAL.cpp`). Use the default
   iteration count and salt length from the ESP-Matter factory-data
   flow.
4. Persist `passcode`, `discriminator`, `verifier`, `salt`, and the
   iteration count to NVS under `aliro_setup`.
5. Wipe the plaintext passcode from RAM once the persisted values
   have been read back and confirmed to encode the same discriminator.

On every subsequent boot: read the stored values and hand them to
the same code path `Server::Init()` already uses for factory data.
`PrintOnboardingCodes()` produces the per-device MT: string
automatically.

## Reset behaviour

Two candidate policies. Pick one before Phase 5 lands.

- **Sticky:** factory reset restores the *same* setup data. NVS keys
  survive `nvs_flash_erase()` because the aliro_setup namespace lives
  in a partition marked `preserve-across-erase`. Nicer for the user
  (the QR sticker on the case stays valid forever) but complicates
  the partition table.
- **Regenerating:** factory reset creates *new* setup data on next
  boot. Standard NVS behaviour. Cleaner mental model; user must
  print a new QR after every factory reset.

Recommend **regenerating** for the first release. Sticky is a
manufacturing concern; personal DIY use accepts the QR-on-a-sticky-
note workflow.

## Serial contract stability

The flasher parser (`installer/js/boot-parser.js`) reads:

```
CHIP:SVR: SetupQRCode: [MT:...]
CHIP:SVR: Manual pairing code: [...]
```

These lines come from `PrintOnboardingCodes()` in the Matter SDK,
which reads from `ConfigurationMgr()`. The overlay only writes to NVS
before `Server::Init()` runs; it never touches the log format. Phase
4b tests continue to pass without change.

## What to add to `firmware/`

When Phase 5 begins:

```
firmware/
  aliro_setup/                  the overlay component
    CMakeLists.txt              ESP-IDF component registration
    Kconfig                     one option: AUTO_GENERATE_ON_FIRST_BOOT
    include/aliro_setup.h       C header declaring aliro_setup_init()
    aliro_setup.c               generation + NVS I/O
  README.md                     already exists (stub)
  DESIGN.md                     this file
  build_overlay.sh              wrapper that invokes esp-matter's build
                                with SDKCONFIG_DEFAULTS pointing at
                                the pinned aliro config plus our overlay
```

The stock esp-matter `door_lock/main/app_main.cpp` calls
`esp_matter::start()`. The overlay hooks in before that call via
`ESP_EVENT_PRE_INIT_HANDLERS` or an equivalent early-init hook. Do
not modify `app_main.cpp` directly — the overlay component runs
before the app and needs no example-code edits.

## Verification

Once implemented, extend the bring-up plan's exit criteria:

- Two nearby devices, flashed one after the other, produce different
  MT: strings.
- The flasher parses each device's per-boot log correctly.
- Each phone commissions only the matching device (the QRs are not
  interchangeable).

Extend the lab-notes template with a "unique-vs-shared" row that
records whether the boot log matches or differs from the shared
example.

## Open questions

- Which ESP-IDF and esp-matter versions will Phase 5 pin against?
  Whatever Phase 1 hardware proof settles on.
- Does the `esp_aliro_lib` licence permit redistribution of the
  built binary under an Apache-2.0 project? Confirm the exact clause
  on the component registry entry before publishing binaries.
- Where do the DAC / PAI / CD come from in the interim? Continue
  using the Matter test attestation shipped with esp-matter until
  CSA certification is ready.
