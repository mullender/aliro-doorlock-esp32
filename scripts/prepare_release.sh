#!/usr/bin/env bash
# prepare_release.sh — produce a merged 4 MB factory binary and its
# SHA-256 sidecar from an idf.py build tree.
#
# Usage:
#   scripts/prepare_release.sh <BUILD_DIR> [<TAG>]
#
# Arguments:
#   BUILD_DIR   absolute path to an idf.py build/ directory that
#               contains flasher_args.json (produced by `idf.py build`)
#   TAG         release tag; default aliro-c6-v0.0.1-devkit
#
# Outputs (relative to the repo root):
#   artifacts/<TAG>/<TAG>-factory.bin
#   artifacts/<TAG>/<TAG>-factory.bin.sha256
#   artifacts/<TAG>/manifest.txt   (part offsets and hashes for audit)
#
# The merged binary is produced with `esptool.py merge_bin` using the
# part list from flasher_args.json. `flash_size 4MB` ensures the final
# image is exactly 4 MiB (padding with 0xFF between parts).

set -euo pipefail

BUILD_DIR="${1:?usage: prepare_release.sh <BUILD_DIR> [<TAG>]}"
TAG="${2:-aliro-c6-v0.0.1-devkit}"

if [[ ! -f "$BUILD_DIR/flasher_args.json" ]]; then
  echo "error: $BUILD_DIR/flasher_args.json not found. Was 'idf.py build' run?" >&2
  exit 2
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="$REPO_ROOT/artifacts/$TAG"
OUT_BIN="$OUT_DIR/${TAG}-factory.bin"
OUT_SHA="$OUT_BIN.sha256"
OUT_MANIFEST="$OUT_DIR/manifest.txt"

mkdir -p "$OUT_DIR"

# esptool.py can either come from the ESP-IDF's exported venv or from
# the system. We prefer the exported one for version parity.
ESPTOOL=""
if command -v esptool.py >/dev/null 2>&1; then
  ESPTOOL=$(command -v esptool.py)
elif [[ -n "${IDF_PATH:-}" && -x "$IDF_PATH/components/esptool_py/esptool/esptool.py" ]]; then
  ESPTOOL="python3 $IDF_PATH/components/esptool_py/esptool/esptool.py"
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

echo "=== parts to merge ==="
echo "$PARTS"

# Build the argv list.
MERGE_ARGS=()
while read -r OFF FILE; do
  MERGE_ARGS+=("$OFF" "$BUILD_DIR/$FILE")
done <<< "$PARTS"

CHIP="$(python3 -c "import json; print(json.load(open('$BUILD_DIR/flasher_args.json')).get('extra_esptool_args', {}).get('chip', 'esp32c6'))")"

echo "=== merge_bin --> $OUT_BIN ==="
# shellcheck disable=SC2086
$ESPTOOL --chip "$CHIP" merge_bin \
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

{
  echo "# ${TAG} — factory image manifest"
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
} > "$OUT_MANIFEST"

echo
echo "Release artefacts:"
echo "  $OUT_BIN         ($SIZE bytes)"
echo "  $OUT_SHA         sha256 = ${SHA}"
echo "  $OUT_MANIFEST    (part-by-part audit)"
