# Aliro NanoC6 release build

This document explains how to build the first installable devkit
release from the pinned sources below.

## Pins

| Component | Value |
|---|---|
| Target board | M5Stack NanoC6 (ESP32-C6FH4, 4 MB flash) |
| Firmware source | `esp-matter/examples/door_lock` |
| esp-matter commit | `85c76a1788c5b70b4b0811734af8616dda15e7ac` |
| connectedhomeip commit | `efefc94fee39d8d1fbbc3c27b9d7fc9025095887` |
| ESP-IDF version | `5.5.4` (tag `v5.5.4`) |
| Release tag | `aliro-c6-v0.0.1-devkit` |
| Merged image size | 4 MiB (4 194 304 bytes), padded with `0xFF` |

The build never modifies the shared `~/Development/esp-matter` checkout.
It uses a clean source snapshot created from a `git archive` of the
pinned commit, with `connectedhomeip/connectedhomeip` provided as a
symlink into the shared checkout (which already has the correct
submodule pins and mirrored blobs).

## Release overlay

`firmware/overlay/sdkconfig.release.nanoc6` holds only the NanoC6
deltas from the stock `sdkconfig.esp32c6.aliro`. Five settings, all
verified against esp-matter `85c76a1`:

- `CONFIG_BSP_BUTTONS_NUM=1`
- `CONFIG_BSP_BUTTON_1_TYPE_GPIO=y`
- `CONFIG_BSP_BUTTON_1_GPIO=9` (NanoC6 user button, shared with ROM BOOT)
- `CONFIG_BSP_BUTTON_1_LEVEL=0` (active-low)
- `CONFIG_BSP_LEDS_NUM=0` (no on-board RGB LED code)

The stock `sdkconfig.esp32c6.aliro` supplies every other setting:
Thread MTD, BLE peripheral, Wi-Fi station off, mbedTLS trimming,
Aliro-over-NFC on, and the 4 MB partition layout.

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

1. Copies the overlay into `$ESP_MATTER_SRC/examples/door_lock/`.
2. Runs `idf.py set-target esp32c6` with
   `SDKCONFIG_DEFAULTS="sdkconfig.esp32c6.aliro;sdkconfig.release.nanoc6"`.
3. Runs `idf.py build`.
4. Prints `idf.py size` for the audit.
5. Removes the temporary overlay copy on exit.

`prepare_release.sh`:

1. Reads the part list from `build/flasher_args.json`.
2. Invokes `esptool.py merge_bin --flash_size 4MB --fill-flash-size 4MB`.
3. Verifies the merged image is exactly 4 194 304 bytes.
4. Writes the merged image, its SHA-256 sidecar, and a per-part
   `manifest.txt` under `artifacts/<tag>/`.

## Artifacts

```
artifacts/aliro-c6-v0.0.1-devkit/
  aliro-c6-v0.0.1-devkit-factory.bin          4 MiB, padded 0xFF
  aliro-c6-v0.0.1-devkit-factory.bin.sha256   sha256 sidecar
  manifest.txt                                per-part audit
```

Git ignores `artifacts/`. The binary and sidecar are uploaded to a
GitHub Release matching the tag; the installer's
`.github/workflows/deploy-installer.yml` picks them up from there and
serves them from Pages.

### Verified build for `aliro-c6-v0.0.1-devkit`

The build completed on 2026-08-05 with esptool.py 4.12.0.

Installer: <https://mullender.github.io/aliro-doorlock-esp32/>

- App image: 1,606,208 bytes
- Factory image: 4,194,304 bytes
- Factory SHA-256:
  `675247acf8660a8a0cab68dcb15634075a35f9ffa40842d9b3054f8a392d7fcf`
- App image checksum and validation hash: valid
- Thread: enabled
- Aliro over NFC: enabled
- Wi-Fi station: disabled
- Portal and Wi-Fi credential markers: not found
- Pages manifest: ESP32-C6, factory image at offset `0`
- Public binary SHA-256: matches the release artifact

## Reproducibility notes

- The source pins reduce build drift. Build timestamps can still change
  the binary. The SHA-256 value on the GitHub Release is the authority
  for the published image.
- The build resolves `esp_aliro_lib` version `1.1.0`. Its Apache-2.0
  license permits redistribution of the built firmware.
- The connectedhomeip symlink shortcut is fine for reproducibility
  because that submodule is pinned by esp-matter's own submodule
  ref at commit `85c76a1`. A future clean-room build should verify
  the resolved submodule SHA matches the pin, either via a fresh
  `git submodule update --init --recursive` or by inspecting
  `.gitmodules`.
