#!/usr/bin/env bash
# Package one matrix variant's release binaries and their SHA-256
# sidecars from an idf.py build tree.
#
# Usage:
#   scripts/prepare_release.sh --variant <id> --tag <matrix-tag> [--build-dir <path>]
#
# Required arguments:
#   --variant <id>       matrix variant id from firmware/variants.json
#                        (nanoc6-thread, nanoc6-wifi, atoms3-lite-wifi)
#   --tag <matrix-tag>   matrix release tag aliro-vX.Y.Z-devkit
#
# Optional:
#   --build-dir <path>   idf.py build/ directory to package.
#                        Default: <ESP_MATTER_SRC>/examples/door_lock/build
#
# Legacy positional form (kept only for the nanoc6-thread variant with
# an aliro-c6-vX.Y.Z-devkit tag, so bench workflows built before
# Phase 1B keep working):
#   scripts/prepare_release.sh <BUILD_DIR> [<LEGACY_TAG>]
#
# Outputs (relative to the repo root):
#   artifacts/<TAG>/<TAG>-<variant>-factory.bin
#   artifacts/<TAG>/<TAG>-<variant>-factory.bin.sha256
#   artifacts/<TAG>/<TAG>-<variant>-app.bin
#   artifacts/<TAG>/<TAG>-<variant>-app.bin.sha256
#   artifacts/<TAG>/<TAG>-<variant>-manifest.txt

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VARIANTS_JSON="$REPO_ROOT/firmware/variants.json"
if [[ ! -f "$VARIANTS_JSON" ]]; then
  echo "error: variants config not found at $VARIANTS_JSON" >&2
  exit 2
fi

VARIANT_ID=""
TAG=""
BUILD_DIR=""
POSITIONAL=()
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --variant) VARIANT_ID="${2:?--variant requires a value}"; shift 2 ;;
    --variant=*) VARIANT_ID="${1#--variant=}"; shift ;;
    --tag) TAG="${2:?--tag requires a value}"; shift 2 ;;
    --tag=*) TAG="${1#--tag=}"; shift ;;
    --build-dir) BUILD_DIR="${2:?--build-dir requires a value}"; shift 2 ;;
    --build-dir=*) BUILD_DIR="${1#--build-dir=}"; shift ;;
    -h|--help) sed -n '1,28p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    --) shift; break ;;
    -*)
      echo "error: unknown option $1" >&2
      echo "usage: $0 --variant <id> --tag <matrix-tag> [--build-dir <path>]" >&2
      exit 2
      ;;
    *) POSITIONAL+=("$1"); shift ;;
  esac
done

# Preserve the legacy positional form ONLY for nanoc6-thread with the
# aliro-c6-* tag, so bench builds cut before Phase 1B still work. Any
# other combination must use --variant + --tag.
if [[ "${#POSITIONAL[@]}" -gt 0 ]]; then
  if [[ -n "$VARIANT_ID" || -n "$BUILD_DIR" ]]; then
    echo "error: legacy positional call may not be mixed with --variant / --build-dir" >&2
    exit 2
  fi
  BUILD_DIR="${POSITIONAL[0]}"
  if [[ "${#POSITIONAL[@]}" -ge 2 ]]; then
    TAG="${POSITIONAL[1]}"
  fi
  if [[ -z "$TAG" ]]; then
    TAG="aliro-c6-v0.0.5-devkit"
  fi
  if [[ ! "$TAG" =~ ^aliro-c6-v[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9._-]+)?$ ]]; then
    echo "error: legacy positional call only accepts aliro-c6-vX.Y.Z-devkit tags; use --variant + --tag for matrix releases" >&2
    exit 2
  fi
  VARIANT_ID="nanoc6-thread"
fi

if [[ -z "$VARIANT_ID" ]]; then
  echo "error: --variant is required (matrix tag) or use the legacy positional form" >&2
  exit 2
fi
if [[ -z "$TAG" ]]; then
  echo "error: --tag is required" >&2
  exit 2
fi

# The matrix tag pattern is authoritative for --variant + --tag calls.
# Legacy positional call already validated its own tag above.
if [[ "${#POSITIONAL[@]}" -eq 0 ]]; then
  if [[ ! "$TAG" =~ ^aliro-v[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9._-]+)?$ ]]; then
    echo "error: matrix tag must match aliro-vX.Y.Z-devkit (got $TAG)" >&2
    exit 2
  fi
fi
FIRMWARE_VERSION="${TAG#aliro-c6-v}"
FIRMWARE_VERSION="${FIRMWARE_VERSION#aliro-v}"
if [[ "${#FIRMWARE_VERSION}" -gt 31 ]]; then
  echo "error: firmware version exceeds the 31-character app descriptor limit: $FIRMWARE_VERSION" >&2
  exit 2
fi

# Read the variant record from the SSOT.
VARIANT_JSON="$(python3 - "$VARIANTS_JSON" "$VARIANT_ID" <<'PY'
import json, sys
with open(sys.argv[1]) as source:
    data = json.load(source)
variant_id = sys.argv[2]
variants = data.get("variants", {})
if variant_id not in variants:
    print(f"error: unknown variant '{variant_id}'", file=sys.stderr)
    print(f"       known variants: {', '.join(sorted(variants))}", file=sys.stderr)
    sys.exit(2)
print(json.dumps(variants[variant_id]))
PY
)"

eval "$(VARIANT_JSON="$VARIANT_JSON" python3 - <<'PY'
import json, os, shlex
entry = json.loads(os.environ["VARIANT_JSON"])
scalars = ["id", "project_name", "chip", "chip_family", "flash_size",
           "partition_table_sha256", "ota_slot_size_hex"]
for key in scalars:
    value = entry.get(key, "")
    if value is None:
        value = ""
    print(f'VARIANT_{key.upper()}={shlex.quote(str(value))}')
offsets = entry.get("ota_offsets_hex", []) or []
print("VARIANT_OTA_OFFSETS_HEX=(" + " ".join(shlex.quote(str(o)) for o in offsets) + ")")
PY
)"

if [[ -z "$BUILD_DIR" ]]; then
  if [[ -n "${ESP_MATTER_SRC:-}" ]]; then
    BUILD_DIR="$ESP_MATTER_SRC/examples/door_lock/build"
  else
    echo "error: --build-dir is required when ESP_MATTER_SRC is not set" >&2
    exit 2
  fi
fi

if [[ ! -f "$BUILD_DIR/flasher_args.json" ]]; then
  echo "error: $BUILD_DIR/flasher_args.json not found. Was 'idf.py build' run?" >&2
  exit 2
fi
if [[ ! -f "$BUILD_DIR/project_description.json" ]]; then
  echo "error: $BUILD_DIR/project_description.json not found. Was 'idf.py build' run?" >&2
  exit 2
fi

BUILD_META="$(python3 - "$BUILD_DIR/project_description.json" <<'PY'
import json, sys
with open(sys.argv[1], encoding="utf-8") as source:
    d = json.load(source)
print(json.dumps({
    "project_name": d.get("project_name", ""),
    "project_version": d.get("project_version", ""),
    "app_bin": d.get("app_bin", ""),
    "app_elf": d.get("app_elf", ""),
}))
PY
)"
eval "$(BUILD_META="$BUILD_META" python3 - <<'PY'
import json, os, shlex
d = json.loads(os.environ["BUILD_META"])
for key, value in d.items():
    print(f'BUILD_{key.upper()}={shlex.quote(str(value))}')
PY
)"

# ---- Fail-closed pre-flight checks ----

if [[ "$BUILD_PROJECT_NAME" != "$VARIANT_PROJECT_NAME" ]]; then
  echo "error: build project_name is '$BUILD_PROJECT_NAME', variant $VARIANT_ID requires '$VARIANT_PROJECT_NAME'" >&2
  echo "       The build tree does not identify the selected variant; rebuild with the right variant." >&2
  exit 3
fi
if [[ "$BUILD_PROJECT_VERSION" != "$FIRMWARE_VERSION" ]]; then
  echo "error: build project_version is '$BUILD_PROJECT_VERSION', tag $TAG requires '$FIRMWARE_VERSION'" >&2
  exit 3
fi

BUILD_CHIP="$(python3 - "$BUILD_DIR/flasher_args.json" <<'PY'
import json, sys
with open(sys.argv[1]) as source:
    data = json.load(source)
print(data.get("extra_esptool_args", {}).get("chip", ""))
PY
)"
if [[ "$BUILD_CHIP" != "$VARIANT_CHIP" ]]; then
  echo "error: build chip is '$BUILD_CHIP', variant $VARIANT_ID requires '$VARIANT_CHIP'" >&2
  exit 3
fi

if [[ -z "$VARIANT_PARTITION_TABLE_SHA256" ]]; then
  echo "error: variant $VARIANT_ID has no approved partition_table_sha256 in variants.json" >&2
  echo "       Set the approved hash before packaging so a drifted layout is caught." >&2
  exit 3
fi
PARTITION_SOURCE="$BUILD_DIR/partition_table/partition-table.bin"
if [[ ! -f "$PARTITION_SOURCE" ]]; then
  echo "error: partition table not found: $PARTITION_SOURCE" >&2
  exit 2
fi
PARTITION_SHA="$(shasum -a 256 "$PARTITION_SOURCE" | awk '{print $1}')"
if [[ "$PARTITION_SHA" != "$VARIANT_PARTITION_TABLE_SHA256" ]]; then
  echo "error: partition table is not the approved layout for $VARIANT_ID" >&2
  echo "       expected $VARIANT_PARTITION_TABLE_SHA256" >&2
  echo "       found    $PARTITION_SHA" >&2
  exit 3
fi

# ---- App binary discovery ----

# Derive the app binary name from project_description.json when available;
# fall back to <project_name>.bin. Refuse a mismatched or missing file.
if [[ -n "$BUILD_APP_BIN" ]]; then
  APP_BIN_NAME="$BUILD_APP_BIN"
elif [[ -n "$BUILD_APP_ELF" ]]; then
  APP_BIN_NAME="${BUILD_APP_ELF%.elf}.bin"
else
  APP_BIN_NAME="${VARIANT_PROJECT_NAME}.bin"
fi
APP_SOURCE="$BUILD_DIR/$APP_BIN_NAME"
if [[ ! -f "$APP_SOURCE" ]]; then
  echo "error: app image not found at $APP_SOURCE (project_description app_bin='$BUILD_APP_BIN')" >&2
  exit 2
fi

# ---- Atomic staging ----

ARTIFACTS_DIR="$REPO_ROOT/artifacts"
OUT_DIR="$ARTIFACTS_DIR/$TAG"
mkdir -p "$ARTIFACTS_DIR" "$OUT_DIR"
STAGE_DIR="$(mktemp -d "$ARTIFACTS_DIR/.${TAG}-${VARIANT_ID}.stage.XXXXXX")"
BACKUP_DIR=""

cleanup() {
  if [[ -n "${STAGE_DIR:-}" && -d "$STAGE_DIR" &&
        "$(dirname "$STAGE_DIR")" == "$ARTIFACTS_DIR" ]]; then
    rm -R -- "$STAGE_DIR"
  fi
  if [[ -n "${BACKUP_DIR:-}" && -d "$BACKUP_DIR" &&
        "$(dirname "$BACKUP_DIR")" == "$ARTIFACTS_DIR" ]]; then
    for item in "$BACKUP_DIR"/*; do
      [[ -e "$item" ]] || continue
      mv "$item" "$OUT_DIR/"
    done
    rmdir "$BACKUP_DIR" 2>/dev/null || true
  fi
}
trap cleanup EXIT

ASSET_STEM="${TAG}-${VARIANT_ID}"
OUT_BIN="$STAGE_DIR/${ASSET_STEM}-factory.bin"
OUT_SHA="$OUT_BIN.sha256"
OUT_APP="$STAGE_DIR/${ASSET_STEM}-app.bin"
OUT_APP_SHA="$OUT_APP.sha256"
OUT_MANIFEST="$STAGE_DIR/${ASSET_STEM}-manifest.txt"

MAX_APP_SIZE="$(printf '%d' "$VARIANT_OTA_SLOT_SIZE_HEX")"
APP_SIZE="$(stat -f%z "$APP_SOURCE" 2>/dev/null || stat -c%s "$APP_SOURCE")"
if [[ "$APP_SIZE" -eq 0 || "$APP_SIZE" -gt "$MAX_APP_SIZE" ]]; then
  printf 'error: app image is %d bytes; OTA slot limit is %d bytes (%s)\n' \
    "$APP_SIZE" "$MAX_APP_SIZE" "$VARIANT_OTA_SLOT_SIZE_HEX" >&2
  exit 3
fi

cp "$APP_SOURCE" "$OUT_APP"
if ! cmp -s "$APP_SOURCE" "$OUT_APP"; then
  echo "error: copied app asset differs from $APP_SOURCE" >&2
  exit 3
fi
APP_SHA="$(shasum -a 256 "$OUT_APP" | awk '{print $1}')"
echo "${APP_SHA}  $(basename "$OUT_APP")" > "$OUT_APP_SHA"

ESPTOOL=()
if command -v esptool.py >/dev/null 2>&1; then
  ESPTOOL=("$(command -v esptool.py)")
elif [[ -n "${IDF_PATH:-}" && -f "$IDF_PATH/components/esptool_py/esptool/esptool.py" ]]; then
  ESPTOOL=(python3 "$IDF_PATH/components/esptool_py/esptool/esptool.py")
else
  echo "error: esptool.py not on PATH and IDF_PATH not set" >&2
  exit 2
fi

PARTS="$(python3 - "$BUILD_DIR/flasher_args.json" <<'PY'
import json, sys
data = json.load(open(sys.argv[1]))
pairs = [(off, path) for off, path in data.get("flash_files", {}).items()]
pairs.sort(key=lambda p: int(p[0], 16))
for off, path in pairs:
    print(f"{off} {path}")
PY
)"
if [[ -z "$PARTS" ]]; then
  echo "error: flasher_args.json has no flash files" >&2
  exit 2
fi

echo "=== parts to merge ($VARIANT_ID) ==="
echo "$PARTS"

MERGE_ARGS=()
while read -r OFF FILE; do
  if [[ ! -f "$BUILD_DIR/$FILE" ]]; then
    echo "error: flash part not found: $BUILD_DIR/$FILE" >&2
    exit 2
  fi
  MERGE_ARGS+=("$OFF" "$BUILD_DIR/$FILE")
done <<< "$PARTS"

echo "=== merge_bin --> $OUT_BIN ==="
"${ESPTOOL[@]}" --chip "$VARIANT_CHIP" merge_bin \
  --flash_mode dio \
  --flash_freq 80m \
  --flash_size "$VARIANT_FLASH_SIZE" \
  --fill-flash-size "$VARIANT_FLASH_SIZE" \
  -o "$OUT_BIN" \
  "${MERGE_ARGS[@]}"

EXPECTED_MERGED_SIZE="$(python3 -c "
size = '$VARIANT_FLASH_SIZE'
unit = size[-2:]
value = int(size[:-2])
mult = {'KB': 1024, 'MB': 1024*1024}[unit]
print(value * mult)")"
SIZE="$(stat -f%z "$OUT_BIN" 2>/dev/null || stat -c%s "$OUT_BIN")"
if [[ "$SIZE" -ne "$EXPECTED_MERGED_SIZE" ]]; then
  echo "error: merged binary is $SIZE bytes, expected $EXPECTED_MERGED_SIZE ($VARIANT_FLASH_SIZE)" >&2
  exit 3
fi

SHA="$(shasum -a 256 "$OUT_BIN" | awk '{print $1}')"
echo "${SHA}  $(basename "$OUT_BIN")" > "$OUT_SHA"

FACTORY_PARTITION_SHA="$(dd if="$OUT_BIN" bs=1 skip=$((0xC000)) count=$((0xC00)) 2>/dev/null | shasum -a 256 | awk '{print $1}')"
if [[ "$FACTORY_PARTITION_SHA" != "$VARIANT_PARTITION_TABLE_SHA256" ]]; then
  echo "error: merged factory partition table does not match the approved layout" >&2
  exit 3
fi
FIRST_OTA_OFFSET_HEX="${VARIANT_OTA_OFFSETS_HEX[0]:-0x20000}"
FIRST_OTA_OFFSET="$(printf '%d' "$FIRST_OTA_OFFSET_HEX")"
FACTORY_APP_SHA="$(dd if="$OUT_BIN" bs=1 skip="$FIRST_OTA_OFFSET" count="$APP_SIZE" 2>/dev/null | shasum -a 256 | awk '{print $1}')"
if [[ "$FACTORY_APP_SHA" != "$APP_SHA" ]]; then
  echo "error: app asset does not match the merged factory image at offset $FIRST_OTA_OFFSET_HEX" >&2
  exit 3
fi

{
  echo "# ${TAG} ${VARIANT_ID} factory image manifest"
  echo "tag: $TAG"
  echo "variant: $VARIANT_ID"
  echo "project_name: $BUILD_PROJECT_NAME"
  echo "project_version: $BUILD_PROJECT_VERSION"
  echo "chip: $VARIANT_CHIP"
  echo "flash_size: $VARIANT_FLASH_SIZE"
  echo "size: ${SIZE} bytes"
  echo "sha256: ${SHA}"
  echo
  echo "# parts (offset, source file, size, sha256)"
  while read -r OFF FILE; do
    FULL="$BUILD_DIR/$FILE"
    PSIZE="$(stat -f%z "$FULL" 2>/dev/null || stat -c%s "$FULL")"
    PSHA="$(shasum -a 256 "$FULL" | awk '{print $1}')"
    echo "${OFF} ${FILE} ${PSIZE} ${PSHA}"
  done <<< "$PARTS"
  echo
  echo "# release assets (name, size, sha256)"
  echo "$(basename "$OUT_BIN") ${SIZE} ${SHA}"
  echo "$(basename "$OUT_APP") ${APP_SIZE} ${APP_SHA}"
  echo
  echo "# preserving update layout"
  echo "partition-table-sha256: ${PARTITION_SHA}"
  echo "ota-slot-size: ${VARIANT_OTA_SLOT_SIZE_HEX}"
  printf 'update-offsets:'
  for offset in "${VARIANT_OTA_OFFSETS_HEX[@]}"; do
    printf ' %s' "$offset"
  done
  echo
} > "$OUT_MANIFEST"

# Move each staged asset into $OUT_DIR, first backing up any per-variant
# assets that a previous run of THIS variant left behind. Variants share
# the tag directory, so never touch unrelated variant files.
BACKUP_DIR="$ARTIFACTS_DIR/.${TAG}-${VARIANT_ID}.backup.$$"
mkdir -p "$BACKUP_DIR"
shopt -s nullglob
for existing in "$OUT_DIR/${ASSET_STEM}"*; do
  mv "$existing" "$BACKUP_DIR/"
done
for staged in "$STAGE_DIR"/*; do
  mv "$staged" "$OUT_DIR/"
done
shopt -u nullglob
STAGE_DIR=""

# Success — drop the backup, don't restore.
if [[ -d "$BACKUP_DIR" ]]; then
  rm -R -- "$BACKUP_DIR"
  BACKUP_DIR=""
fi

echo
echo "Release artifacts for variant $VARIANT_ID under tag $TAG:"
echo "  $OUT_DIR/$(basename "$OUT_BIN")         ($SIZE bytes)"
echo "  $OUT_DIR/$(basename "$OUT_SHA")         sha256 = ${SHA}"
echo "  $OUT_DIR/$(basename "$OUT_APP")         ($APP_SIZE bytes)"
echo "  $OUT_DIR/$(basename "$OUT_APP_SHA")     sha256 = ${APP_SHA}"
echo "  $OUT_DIR/$(basename "$OUT_MANIFEST")    (part-by-part audit)"
