# Aliro NanoC6 release build

This document explains how to build the current devkit release from
the pinned sources below.

## Pins

| Component | Value |
|---|---|
| Target board | M5Stack NanoC6 (ESP32-C6FH4, 4 MB flash) |
| Firmware source | `esp-matter/examples/door_lock` |
| esp-matter commit | `85c76a1788c5b70b4b0811734af8616dda15e7ac` |
| connectedhomeip commit | `efefc94fee39d8d1fbbc3c27b9d7fc9025095887` |
| ESP-IDF version | `5.5.4` (tag `v5.5.4`) |
| Release tag | `aliro-c6-v0.0.3-devkit` |
| Merged image size | 4 MiB (4 194 304 bytes), padded with `0xFF` |

The build never modifies the shared `~/Development/esp-matter` checkout.
It uses a clean source snapshot created from a `git archive` of the
pinned commit, with `connectedhomeip/connectedhomeip` provided as a
symlink into the shared checkout (which already has the correct
submodule pins and mirrored blobs).

## Release overlay

`firmware/overlay/sdkconfig.release.nanoc6` holds only the NanoC6
deltas from the stock `sdkconfig.esp32c6.aliro`. Six settings, all
verified against esp-matter `85c76a1`:

- `CONFIG_BSP_BUTTONS_NUM=1`
- `CONFIG_BSP_BUTTON_1_TYPE_GPIO=y`
- `CONFIG_BSP_BUTTON_1_GPIO=9` (NanoC6 user button, shared with ROM BOOT)
- `CONFIG_BSP_BUTTON_1_LEVEL=0` (active-low)
- `CONFIG_BSP_LEDS_NUM=0` (the BSP LED driver stays off; the audited
  Aliro patch controls the on-board RGB LED directly)
- `CONFIG_ESP_CONSOLE_USB_SERIAL_JTAG=y` (native USB is the primary
  console)

The stock `sdkconfig.esp32c6.aliro` supplies every other setting:
Thread MTD, BLE peripheral, Wi-Fi station off, mbedTLS trimming,
Aliro-over-NFC on, and the 4 MB partition layout.

The build script applies the audited patches in `firmware/patches/`
in file-name order:

1. `0001-print-onboarding-codes.patch` prints the Matter QR payload
   and manual pairing code after Matter starts.
2. `0002-advertise-aliro-credentials-only.patch` removes the PIN and
   over-the-air PIN features. It keeps the User and Aliro Provisioning
   features. It also corrects the pinned legacy feature check so that
   the User feature accepts Aliro as its credential feature.
3. `0003-add-nanoc6-rgb-feedback.patch` uses the NanoC6 WS2812 on
   data GPIO 20 and power-enable GPIO 19. It shows green after a full
   Aliro transaction, red after a failed transaction, and blue when a
   selected tag is not Aliro. A dedicated task owns all RGB strip I/O.
   Callers send nonblocking updates through a one-item queue.
4. `0004-wire-aliro-ecp-and-generic-tags.patch` gives `m5nfc` the
   first eight bytes of the current Matter GroupIdentifier. It also
   shows blue when NFC-A selects a tag that does not support ISO-DEP.
5. `0005-add-m5nfc-aliro-ecp.patch` changes the pinned managed
   `m5nfc` component. It sends the Aliro ECP frame before NFC-A
   activation and reports the activation type to the door lock.

The expected Door Lock FeatureMap is `0x2100` (`USR | ALIRO`). The
build script checks the source feature calls and the pinned feature-bit
values before it starts `idf.py`. It also checks the RGB worker, Aliro
FCI, and reader-lock source contracts. It removes all patches in reverse
order when it exits.

The source assigns blue in two cases: a selected non-ISO-DEP NFC-A tag,
or an ISO-DEP tag that rejects the Aliro AID select. A successful Aliro
select response must contain status `9000`, an outer `6F` template with
the exact data length, and an immediate `84 09` child with the exact
expedited AID.

The 16 ECP bytes before CRC-A are `6A 02 CB 02 06 20 42 20`, followed
by `GroupIdentifier[0..7]` in the same byte order. `NFCLayerA` sends
these bytes through the ST25R3916 transmit-with-CRC path, which appends
CRC-A. The lock updates this identifier when Matter sets or restores
the reader configuration. It clears the identifier when Matter clears
the reader configuration.

### Symbols we intentionally do NOT set

- `CONFIG_ESP_MATTER_NVS_USE_COMPACT_ATTR_STORAGE` is not present in
  esp-matter `85c76a1`; `idf.py` treats it as unknown and drops it.
  Trimmed from the overlay. If a later esp-matter release adds it,
  re-evaluate.
- Any Wi-Fi station credential, softAP fallback, or debug portal.
- Any Improv Wi-Fi handler (Matter over Thread uses BLE commissioning).

## Build

Requires `IDF_PATH` exported (source `esp-idf/export.sh` in the shell
first). The build script also sets `ESP_MATTER_PATH` before sourcing
`esp-matter/export.sh`, because that script reads it without a default
value and the script runs with `set -u` (nounset).

If `ESP_MATTER_SRC` is a git archive, set `ESP_MATTER_REVISION` to the
pinned esp-matter commit. The script checks this value and checks the
connectedhomeip checkout before it starts the build.

```
# from a clean shell:
. ~/Development/esp-idf/export.sh
export ESP_MATTER_SRC=/absolute/path/to/clean/esp-matter/snapshot
export ESP_MATTER_REVISION=85c76a1788c5b70b4b0811734af8616dda15e7ac
scripts/build_release.sh                       # build only
scripts/prepare_release.sh <build-dir> [<tag>] # merge + sha256
```

`build_release.sh`:

1. Applies source patches 0001 through 0004 to the clean source tree.
2. Checks that the Door Lock FeatureMap is `0x2100` (`USR | ALIRO`).
3. Copies the overlay into `$ESP_MATTER_SRC/examples/door_lock/`.
4. Runs `idf.py set-target esp32c6` with
   `SDKCONFIG_DEFAULTS="sdkconfig.esp32c6.aliro;sdkconfig.release.nanoc6"`.
5. Applies patch 0005 after `idf.py` fetches the managed components.
6. Checks the ECP frame, GroupIdentifier mapping, NFC activation order,
   RGB pins, and result mapping.
7. Runs `idf.py build`.
8. Prints `idf.py size` for the audit.
9. Removes the temporary overlay and all patches in reverse order
   on exit.

`prepare_release.sh`:

1. Reads the part list from `build/flasher_args.json`.
2. Invokes `esptool.py merge_bin --flash_size 4MB --fill-flash-size 4MB`.
3. Verifies the merged image is exactly 4 194 304 bytes.
4. Writes the merged image, its SHA-256 sidecar, and a per-part
   `manifest.txt` under `artifacts/<tag>/`.

## Artifacts

```
artifacts/aliro-c6-v0.0.3-devkit/
  aliro-c6-v0.0.3-devkit-factory.bin          4 MiB, padded 0xFF
  aliro-c6-v0.0.3-devkit-factory.bin.sha256   sha256 sidecar
  manifest.txt                                per-part audit
```

Git ignores `artifacts/`. The binary and sidecar are uploaded to a
GitHub Release matching the tag; the installer's
`.github/workflows/deploy-installer.yml` picks them up from there and
serves them from Pages.

### Verified build for `aliro-c6-v0.0.3-devkit`

The clean build and packaging passed on 2026-08-05.

- `door_lock.bin`: `0x1871c0` bytes (1,601,984 bytes)
- Total image size report: 1,601,862 bytes
- Smallest app partition: `0x1e0000` bytes, with `0x58e40` bytes
  free (19%)
- Factory image: 4,194,304 bytes
- Factory SHA-256:
  `7cb3b8940970150d6d171ee2e57b650bf7b87721a8ee92ca56291444256a999b`
- Door Lock FeatureMap: `0x2100` (`USR | ALIRO`)
- PIN, COTA, and PIN-only attributes: absent
- Aliro reader attributes and the user and credential commands: present
- Audited ECP frame and pre-activation order: present
- Patch cleanup restored the pinned source files.

This image has not been verified on the NanoC6 hardware. After the user
flashes it, verify automatic Home Key selection through ECP and the
green, red, and blue tap colors.

### Previous verified build: `aliro-c6-v0.0.2-devkit`

The build completed on 2026-08-05 with esptool.py 4.12.0.

Installer: <https://mullender.github.io/aliro-doorlock-esp32/>

- App image: 1,596,064 bytes
- Factory image: 4,194,304 bytes
- Factory SHA-256:
  `8c2556071ffe1935e99d0a3373d45d7693c94616fe0f19f98c0de5681e21aa10`
- App image checksum and validation hash: valid
- Native USB Serial/JTAG: primary console
- `PrintOnboardingCodes()` and its two pairing-code log strings:
  present in the ELF
- Thread: enabled
- Aliro over NFC: enabled
- Wi-Fi station: disabled
- Portal and Wi-Fi credential markers: not found
- Pages manifest: ESP32-C6, factory image at offset `0`
- Public binary SHA-256: matches the release artifact

The last two public checks apply after the release workflow publishes
the image.

Version 0.0.2 advertises PIN and over-the-air PIN support. Apple Home
can therefore try to provision personal access codes. Version 0.0.3
removes those capabilities because the NanoC6 lock has no keypad.

### Known issue in `aliro-c6-v0.0.1-devkit`

Version 0.0.1 used UART0 as its primary console and did not call
`PrintOnboardingCodes()`. It cannot provide the boot logs or pairing
codes that the browser installer needs. Keep it as a historical
prerelease. Do not use it for NanoC6 hardware validation.

## Reproducibility notes

- The source pins reduce build drift. Build timestamps can still change
  the binary. The SHA-256 value on the GitHub Release is the authority
  for the published image.
- The build resolves `esp_aliro_lib` version `1.1.0`. Its Apache-2.0
  license permits redistribution of the built firmware.
- The build resolves the managed `m5nfc` component at commit
  `0d00697342a8a13a13e0fb53f76e370c88845891`. Patch 0005 targets this
  exact source.
- The connectedhomeip symlink shortcut is fine for reproducibility
  because that submodule is pinned by esp-matter's own submodule
  ref at commit `85c76a1`. A future clean-room build should verify
  the resolved submodule SHA matches the pin, either via a fresh
  `git submodule update --init --recursive` or by inspecting
  `.gitmodules`.
