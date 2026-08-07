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
| Release tag | `aliro-c6-v0.0.4-devkit` |
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

The build script applies the audited patches in `firmware/patches/`.
It applies source patches before dependency resolution and the managed
component patch after dependency resolution:

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
6. `0006-add-aliro-settings.patch` adds persistent serial settings. It
   controls auto-relock time and the three RGB result colors and
   durations. It also sets the project version flow for this release.
7. `0007-toggle-lock-on-aliro-tap.patch` reads the Matter `LockState`
   after each valid Aliro tap. It unlocks a locked lock. It locks an
   unlocked lock only when auto-lock is off.

The expected Door Lock FeatureMap is `0x2100` (`USR | ALIRO`). The
build script checks the source feature calls and the pinned feature-bit
values before it starts `idf.py`. It also checks the RGB worker, Aliro
FCI, reader-lock, and settings source contracts. It compiles and runs the
host parser test before it starts `idf.py`. It removes all patches in
reverse order when it exits.

The tap source uses the generated Matter `LockState::Get` accessor and the
existing `BoltLockMgr().Lock` and `BoltLockMgr().Unlock` methods. It reads the
runtime auto-lock value from `DoorLockServer::GetAutoRelockTime()`. This is the
same Matter attribute source that the relock timer uses. `AliroSettingsGet()`
supplies the stored value when the app creates the attribute. When auto-lock is
on, a tap restarts the Matter timer for an unlocked lock. This also starts a
timer if auto-lock was enabled while the lock was already unlocked.

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

## Serial settings protocol

Version 0.0.4 adds the `ALIRO/1` line protocol on the native USB serial
console. Commands use printable ASCII and end with CR or LF.

```
ALIRO/1 GET
ALIRO/1 SET auto_relock_seconds=5
ALIRO/1 SET success_rgb=00FF00 success_ms=1000
```

`SET` accepts one or more keys. Keys that are not in a command keep their
current values. A command cannot contain the same key two times.

| Key | Format and range | Default |
|---|---|---|
| `auto_relock_seconds` | Decimal, 0 to 3600 | 5 |
| `success_rgb` | Six hexadecimal digits, `RRGGBB` | `00FF00` |
| `failure_rgb` | Six hexadecimal digits, `RRGGBB` | `FF0000` |
| `other_rgb` | Six hexadecimal digits, `RRGGBB` | `0000FF` |
| `success_ms` | Decimal, 0 to 10000 | 1000 |
| `failure_ms` | Decimal, 0 to 10000 | 1000 |
| `other_ms` | Decimal, 0 to 10000 | 1000 |

The firmware emits one status line when serial input starts, after `GET`,
and after a successful `SET`:

```
ALIRO/1 STATUS firmware=0.0.4-devkit protocol=1 auto_relock_seconds=5 success_rgb=00FF00 failure_rgb=FF0000 other_rgb=0000FF success_ms=1000 failure_ms=1000 other_ms=1000
```

The firmware returns `ALIRO/1 ERROR code=<code>` for a rejected command.
The protocol defines `bad_request`, `unknown_key`, `invalid_value`,
`line_too_long`, `storage`, and `matter`. A rejected command does not
change the active settings. Successful settings persist in the
`aliro_settings` NVS namespace and survive a preserving update.

The status version comes from the ESP-IDF app descriptor. The release
script removes `aliro-c6-v` from `TAG` and passes the result to CMake as
`CLI_PROJECT_VER`. It passes the semantic patch number as
`CLI_PROJECT_VER_NUMBER`. Thus the release tag, app descriptor, and
serial status use one version value.

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
scripts/build_release.sh --source-check        # source and parser checks only
scripts/prepare_release.sh <build-dir> [<tag>] # package + sha256
```

`build_release.sh`:

1. Applies source patches 0001 through 0004, then 0006 and 0007, to the
   clean source tree.
2. Checks that the Door Lock FeatureMap is `0x2100` (`USR | ALIRO`).
3. Checks the settings and tap-toggle source contracts, then compiles and
   runs the host parser test.
4. Copies the overlay into `$ESP_MATTER_SRC/examples/door_lock/`.
5. Runs `idf.py set-target esp32c6` with the version from `TAG` and
   `SDKCONFIG_DEFAULTS="sdkconfig.esp32c6.aliro;sdkconfig.release.nanoc6"`.
6. Applies patch 0005 after `idf.py` fetches the managed components.
7. Checks the ECP frame, GroupIdentifier mapping, NFC activation order,
   RGB pins, and result mapping.
8. Runs `idf.py build` with the same version values.
9. Prints `idf.py size` for the audit.
10. Removes the temporary overlay and all patches in reverse order
   on exit.

`prepare_release.sh`:

1. Verifies that `project_description.json` has the version from the
   release tag.
2. Reads the part list from `build/flasher_args.json`.
3. Verifies that the partition-table SHA-256 is
   `22770c7ddd300880cdd3e3344c174122c207fa4fe6a523ef83e6fc4e892c2421`.
4. Copies `build/door_lock.bin` byte-for-byte to the app-only release
   asset and rejects an app larger than the `0x1e0000`-byte OTA slot.
5. Invokes `esptool.py merge_bin --flash_size 4MB --fill-flash-size 4MB`.
6. Verifies that the merged image is exactly 4 194 304 bytes.
7. Verifies that the factory partition-table slice has the approved
   SHA-256 and that its app slice is identical to the app asset.
8. Writes both images, their SHA-256 sidecars, and a per-part
   `manifest.txt` to a staging directory.
9. Replaces `artifacts/<tag>/` only after all checks pass. A failed
   package run keeps the prior complete artifact set.

## Artifacts

```
artifacts/aliro-c6-v0.0.4-devkit/
  aliro-c6-v0.0.4-devkit-factory.bin          4 MiB, padded 0xFF
  aliro-c6-v0.0.4-devkit-factory.bin.sha256   sha256 sidecar
  aliro-c6-v0.0.4-devkit-app.bin              app-only update image
  aliro-c6-v0.0.4-devkit-app.bin.sha256       sha256 sidecar
  manifest.txt                                per-part audit
```

Git ignores `artifacts/`. Both binaries and sidecars are uploaded to a
GitHub Release matching the tag; the installer's
`.github/workflows/deploy-installer.yml` picks them up from there and
serves them from Pages.

The Pages site publishes two manifests:

- `manifest.json` is the destructive factory install. It writes the
  4 MiB factory image at offset `0` and erases stored data.
- `manifest-update.json` is the preserving update. It writes only the
  app image at `0x20000` and `0x200000`. It does not write NVS,
  `nvs_keys`, `otadata`, secure-certificate data, factory data, PHY
  data, or coredump data.

Before a preserving update writes data, the installer reads `0xc00`
bytes at `0xc000` from the connected device. It rejects the update if
that partition-table SHA-256 does not match the approved layout. It
also rejects every erase request for an app-only manifest. After each
write, it reads the written range back and compares every byte before
it reports success.

The preserving layout ID is `esp32c6-door-lock-4mb-v1`. Its partition
table SHA-256 is
`22770c7ddd300880cdd3e3344c174122c207fa4fe6a523ef83e6fc4e892c2421`.
The update writes both OTA slots because the browser manifest does not
know which slot `otadata` selects.

### Verified build: `aliro-c6-v0.0.4-devkit`

The clean build and packaging passed on 2026-08-07. A NanoC6 hardware
test is still required.

- `door_lock.bin`: 1,607,584 bytes
- Smallest app partition: `0x1e0000` bytes, with 358,496 bytes free
  (18%)
- App-only SHA-256:
  `15cc3dd5e3244287d062b2ba2771d06b25257cfa4e3007a6062ac8a2a6d20dee`
- Factory image: 4,194,304 bytes
- Factory SHA-256:
  `93df8a20e7e8de93a01e6c0e409304f67f2654d862fcff12494387f36a992995`

### Previous verified build: `aliro-c6-v0.0.3-devkit`

The clean build and packaging passed on 2026-08-05.

- `door_lock.bin`: `0x1871c0` bytes (1,601,984 bytes)
- App-only SHA-256:
  `ef81cf3615821b37a9207cfcb90c311e9588466f53df03dc0bfca020beba74f2`
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
