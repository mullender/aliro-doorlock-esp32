#!/usr/bin/env bash
# Produce factory and app-only release binaries and their SHA-256
# sidecars from an idf.py build tree.
#
# Usage:
#   scripts/prepare_release.sh <BUILD_DIR> [<TAG>]
#
# Arguments:
#   BUILD_DIR   absolute path to an idf.py build/ directory that
#               contains flasher_args.json (produced by `idf.py build`)
#   TAG         release tag; default aliro-c6-v0.0.4-devkit
#
# Outputs (relative to the repo root):
#   artifacts/<TAG>/<TAG>-factory.bin
#   artifacts/<TAG>/<TAG>-factory.bin.sha256
#   artifacts/<TAG>/<TAG>-app.bin
#   artifacts/<TAG>/<TAG>-app.bin.sha256
#   artifacts/<TAG>/manifest.txt   (part offsets and hashes for audit)
#
# The merged binary is produced with `esptool.py merge_bin` using the
# part list from flasher_args.json. `flash_size 4MB` ensures the final
# image is exactly 4 MiB (padding with 0xFF between parts).

set -euo pipefail

BUILD_DIR="${1:?usage: prepare_release.sh <BUILD_DIR> [<TAG>]}"
TAG="${2:-aliro-c6-v0.0.4-devkit}"

if [[ ! "$TAG" =~ ^aliro-c6-v[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9._-]+)?$ ]]; then
  echo "error: invalid Aliro release tag: $TAG" >&2
  exit 2
fi
FIRMWARE_VERSION="${TAG#aliro-c6-v}"
if [[ "${#FIRMWARE_VERSION}" -gt 31 ]]; then
  echo "error: firmware version exceeds the 31-character app descriptor limit: $FIRMWARE_VERSION" >&2
  exit 2
fi

if [[ ! -f "$BUILD_DIR/flasher_args.json" ]]; then
  echo "error: $BUILD_DIR/flasher_args.json not found. Was 'idf.py build' run?" >&2
  exit 2
fi
if [[ ! -f "$BUILD_DIR/project_description.json" ]]; then
  echo "error: $BUILD_DIR/project_description.json not found. Was 'idf.py build' run?" >&2
  exit 2
fi

BUILD_VERSION="$(python3 - "$BUILD_DIR/project_description.json" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as source:
    description = json.load(source)
print(description.get("project_version", ""))
PY
)"
if [[ "$BUILD_VERSION" != "$FIRMWARE_VERSION" ]]; then
  echo "error: build version is '$BUILD_VERSION', but tag requires '$FIRMWARE_VERSION'" >&2
  exit 3
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ARTIFACTS_DIR="$REPO_ROOT/artifacts"
OUT_DIR="$REPO_ROOT/artifacts/$TAG"
mkdir -p "$ARTIFACTS_DIR"
STAGE_DIR=$(mktemp -d "$ARTIFACTS_DIR/.${TAG}.stage.XXXXXX")
BACKUP_DIR=""

cleanup() {
  if [[ -n "${STAGE_DIR:-}" && -d "$STAGE_DIR" &&
        "$(dirname "$STAGE_DIR")" == "$ARTIFACTS_DIR" ]]; then
    rm -R -- "$STAGE_DIR"
  fi
  if [[ -n "${BACKUP_DIR:-}" && -d "$BACKUP_DIR" &&
        ! -e "$OUT_DIR" && "$(dirname "$BACKUP_DIR")" == "$ARTIFACTS_DIR" ]]; then
    mv "$BACKUP_DIR" "$OUT_DIR"
  fi
}
trap cleanup EXIT

OUT_BIN="$STAGE_DIR/${TAG}-factory.bin"
OUT_SHA="$OUT_BIN.sha256"
OUT_APP="$STAGE_DIR/${TAG}-app.bin"
OUT_APP_SHA="$OUT_APP.sha256"
OUT_MANIFEST="$STAGE_DIR/manifest.txt"
APP_SOURCE="$BUILD_DIR/door_lock.bin"
PARTITION_SOURCE="$BUILD_DIR/partition_table/partition-table.bin"
MAX_APP_SIZE=$((0x1E0000))
EXPECTED_PARTITION_SHA="22770c7ddd300880cdd3e3344c174122c207fa4fe6a523ef83e6fc4e892c2421"

if [[ ! -f "$APP_SOURCE" ]]; then
  echo "error: app image not found: $APP_SOURCE" >&2
  exit 2
fi
if [[ ! -f "$PARTITION_SOURCE" ]]; then
  echo "error: partition table not found: $PARTITION_SOURCE" >&2
  exit 2
fi

PARTITION_SHA=$(shasum -a 256 "$PARTITION_SOURCE" | awk '{print $1}')
if [[ "$PARTITION_SHA" != "$EXPECTED_PARTITION_SHA" ]]; then
  echo "error: partition table is not the approved preserving-update layout" >&2
  echo "       expected $EXPECTED_PARTITION_SHA" >&2
  echo "       found    $PARTITION_SHA" >&2
  exit 3
fi

APP_SIZE=$(stat -f%z "$APP_SOURCE" 2>/dev/null || stat -c%s "$APP_SOURCE")
if [[ "$APP_SIZE" -eq 0 || "$APP_SIZE" -gt "$MAX_APP_SIZE" ]]; then
  printf 'error: app image is %d bytes; OTA slot limit is %d bytes (0x1E0000)\n' \
    "$APP_SIZE" "$MAX_APP_SIZE" >&2
  exit 3
fi

# Keep the app asset byte-for-byte identical to the image produced by
# ESP-IDF. This file is written to both OTA slots by the preserving
# Web Serial update flow.
cp "$APP_SOURCE" "$OUT_APP"
if ! cmp -s "$APP_SOURCE" "$OUT_APP"; then
  echo "error: copied app asset differs from $APP_SOURCE" >&2
  exit 3
fi
APP_SHA=$(shasum -a 256 "$OUT_APP" | awk '{print $1}')
echo "${APP_SHA}  $(basename "$OUT_APP")" > "$OUT_APP_SHA"

# esptool.py can either come from the ESP-IDF's exported venv or from
# the system. We prefer the exported one for version parity.
ESPTOOL=()
if command -v esptool.py >/dev/null 2>&1; then
  ESPTOOL=("$(command -v esptool.py)")
elif [[ -n "${IDF_PATH:-}" && -f "$IDF_PATH/components/esptool_py/esptool/esptool.py" ]]; then
  ESPTOOL=(python3 "$IDF_PATH/components/esptool_py/esptool/esptool.py")
else
  echo "error: esptool.py not on PATH and IDF_PATH not set" >&2
  exit 2
fi

# Extract the part list. flasher_args.json has entries like:
#   "flash_files": { "0x0": "bootloader/bootloader.bin", ... }
# Convert them to esptool merge_bin positional pairs.
PARTS=$(python3 - "$BUILD_DIR/flasher_args.json" <<'PY'
import json, sys
data = json.load(open(sys.argv[1]))
pairs = [(off, path) for off, path in data.get("flash_files", {}).items()]
pairs.sort(key=lambda p: int(p[0], 16))
for off, path in pairs:
    print(f"{off} {path}")
PY
)
if [[ -z "$PARTS" ]]; then
  echo "error: flasher_args.json has no flash files" >&2
  exit 2
fi

echo "=== parts to merge ==="
echo "$PARTS"

# Build the argv list.
MERGE_ARGS=()
while read -r OFF FILE; do
  if [[ ! -f "$BUILD_DIR/$FILE" ]]; then
    echo "error: flash part not found: $BUILD_DIR/$FILE" >&2
    exit 2
  fi
  MERGE_ARGS+=("$OFF" "$BUILD_DIR/$FILE")
done <<< "$PARTS"

CHIP="$(python3 - "$BUILD_DIR/flasher_args.json" <<'PY'
import json, sys
with open(sys.argv[1]) as source:
    data = json.load(source)
print(data.get("extra_esptool_args", {}).get("chip", "esp32c6"))
PY
)"
if [[ "$CHIP" != "esp32c6" ]]; then
  echo "error: release image is for $CHIP, expected esp32c6" >&2
  exit 2
fi

echo "=== merge_bin --> $OUT_BIN ==="
"${ESPTOOL[@]}" --chip "$CHIP" merge_bin \
  --flash_mode dio \
  --flash_freq 80m \
  --flash_size 4MB \
  --fill-flash-size 4MB \
  -o "$OUT_BIN" \
  "${MERGE_ARGS[@]}"

SIZE=$(stat -f%z "$OUT_BIN" 2>/dev/null || stat -c%s "$OUT_BIN")
if [[ "$SIZE" -ne 4194304 ]]; then
  echo "error: merged binary is $SIZE bytes, expected 4194304 (4 MiB)" >&2
  exit 3
fi

SHA=$(shasum -a 256 "$OUT_BIN" | awk '{print $1}')
echo "${SHA}  $(basename "$OUT_BIN")" > "$OUT_SHA"

FACTORY_PARTITION_SHA=$(dd if="$OUT_BIN" bs=1 skip=$((0xC000)) count=$((0xC00)) 2>/dev/null | shasum -a 256 | awk '{print $1}')
if [[ "$FACTORY_PARTITION_SHA" != "$EXPECTED_PARTITION_SHA" ]]; then
  echo "error: merged factory partition table does not match the approved layout" >&2
  exit 3
fi
FACTORY_APP_SHA=$(dd if="$OUT_BIN" bs=1 skip=$((0x20000)) count="$APP_SIZE" 2>/dev/null | shasum -a 256 | awk '{print $1}')
if [[ "$FACTORY_APP_SHA" != "$APP_SHA" ]]; then
  echo "error: app asset does not match the merged factory image at offset 0x20000" >&2
  exit 3
fi

{
  echo "# ${TAG} factory image manifest"
  echo "chip:  $CHIP"
  echo "size:  ${SIZE} bytes"
  echo "sha256: ${SHA}"
  echo
  echo "# parts (offset, source file, size, sha256)"
  while read -r OFF FILE; do
    FULL="$BUILD_DIR/$FILE"
    PSIZE=$(stat -f%z "$FULL" 2>/dev/null || stat -c%s "$FULL")
    PSHA=$(shasum -a 256 "$FULL" | awk '{print $1}')
    echo "${OFF} ${FILE} ${PSIZE} ${PSHA}"
  done <<< "$PARTS"
  echo
  echo "# release assets (name, size, sha256)"
  echo "$(basename "$OUT_BIN") ${SIZE} ${SHA}"
  echo "$(basename "$OUT_APP") ${APP_SIZE} ${APP_SHA}"
  echo
  echo "# preserving update layout"
  echo "partition-table-sha256: ${PARTITION_SHA}"
  echo "ota-slot-size: 0x1e0000"
  echo "update-offsets: 0x20000 0x200000"
} > "$OUT_MANIFEST"

BACKUP_DIR="$ARTIFACTS_DIR/.${TAG}.backup.$$"
if [[ -e "$OUT_DIR" ]]; then
  mv "$OUT_DIR" "$BACKUP_DIR"
fi
if mv "$STAGE_DIR" "$OUT_DIR"; then
  STAGE_DIR=""
  if [[ -d "$BACKUP_DIR" && "$(dirname "$BACKUP_DIR")" == "$ARTIFACTS_DIR" ]]; then
    rm -R -- "$BACKUP_DIR"
  fi
else
  if [[ -d "$BACKUP_DIR" ]]; then
    mv "$BACKUP_DIR" "$OUT_DIR"
  fi
  exit 3
fi

echo
echo "Release artifacts:"
echo "  $OUT_DIR/$(basename "$OUT_BIN")         ($SIZE bytes)"
echo "  $OUT_DIR/$(basename "$OUT_SHA")         sha256 = ${SHA}"
echo "  $OUT_DIR/$(basename "$OUT_APP")         ($APP_SIZE bytes)"
echo "  $OUT_DIR/$(basename "$OUT_APP_SHA")     sha256 = ${APP_SHA}"
echo "  $OUT_DIR/$(basename "$OUT_MANIFEST")    (part-by-part audit)"
