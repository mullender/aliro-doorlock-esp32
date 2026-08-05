# Release build — Aliro NanoC6

How the first installable devkit release is built. Reproducible from a
clean shell given the pins below.

## Pins

| Component | Value |
|---|---|
| Target board | M5Stack NanoC6 (ESP32-C6FH4, 4 MB flash) |
| Firmware source | `esp-matter/examples/door_lock` |
| esp-matter commit | `85c76a1788c5b70b4b0811734af8616dda15e7ac` |
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

- `CONFIG_ESP_MATTER_NVS_USE_COMPACT_ATTR_STORAGE` — not present in
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

```
# from a clean shell:
. ~/Development/esp-idf/export.sh
export ESP_MATTER_SRC=/absolute/path/to/clean/esp-matter/snapshot
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

## Artefacts

```
artifacts/aliro-c6-v0.0.1-devkit/
  aliro-c6-v0.0.1-devkit-factory.bin          4 MiB, padded 0xFF
  aliro-c6-v0.0.1-devkit-factory.bin.sha256   sha256 sidecar
  manifest.txt                                per-part audit
```

`artifacts/` is `.gitignore`d. The binary and sidecar are uploaded to a
GitHub Release matching the tag; the installer's
`.github/workflows/deploy-installer.yml` picks them up from there and
serves them from Pages.

## Reproducibility notes

- The merged image is byte-stable given the same esp-matter commit,
  IDF version, and overlay. If the SHA-256 changes across two builds
  with identical inputs, inspect `manifest.txt` for the drift.
- `esp_aliro_lib` is pulled as a precompiled component (`^1.0.1`).
  Its licence permits redistribution of built firmware; confirm the
  current clause on the component registry entry before publishing
  binaries publicly.
- The connectedhomeip symlink shortcut is fine for reproducibility
  because that submodule is pinned by esp-matter's own submodule
  ref at commit `85c76a1`. A future clean-room build should verify
  the resolved submodule SHA matches the pin, either via a fresh
  `git submodule update --init --recursive` or by inspecting
  `.gitmodules`.
