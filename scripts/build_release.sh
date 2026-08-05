#!/usr/bin/env bash
# build_release.sh — build the Aliro NanoC6 release image against a
# pinned esp-matter checkout.
#
# The script does NOT touch the shared ~/Development/esp-matter checkout.
# It expects a caller-supplied clean source tree at ESP_MATTER_SRC that
# is checked out at the pinned commit (a git-archive extract is fine).
#
# Usage:
#   scripts/build_release.sh
#
# Required environment:
#   ESP_MATTER_SRC   absolute path to a clean esp-matter source tree,
#                    already checked out at the pinned commit
#   IDF_PATH         set by ESP-IDF's export.sh (or by direnv). Script
#                    exits if unset.
#
# Optional environment:
#   TAG              release tag; default aliro-c6-v0.0.1-devkit
#   BUILD_ROOT       parent directory for the build tree; default is a
#                    fresh mktemp under ESP_MATTER_SRC's parent
#
# Outputs:
#   $BUILD_ROOT/build/                     idf.py build tree
#   $BUILD_ROOT/build/door_lock.bin        the app image
#   $BUILD_ROOT/build/partition_table/     partition table image
#   $BUILD_ROOT/build/bootloader/          bootloader image
#
# The merged 4 MB factory image and its .sha256 sidecar are produced by
# scripts/prepare_release.sh, which consumes the outputs of this script.

set -euo pipefail

: "${ESP_MATTER_SRC:?set to absolute path of a clean esp-matter source tree}"
: "${IDF_PATH:?ESP-IDF not exported. source \$IDF_PATH/export.sh first}"

TAG="${TAG:-aliro-c6-v0.0.1-devkit}"

if [[ ! -f "$ESP_MATTER_SRC/examples/door_lock/sdkconfig.esp32c6.aliro" ]]; then
  echo "error: $ESP_MATTER_SRC does not look like an esp-matter tree" >&2
  exit 2
fi
if [[ ! -e "$ESP_MATTER_SRC/connectedhomeip/connectedhomeip/BUILD.gn" ]]; then
  echo "error: connectedhomeip submodule not populated under $ESP_MATTER_SRC" >&2
  echo "       (a symlink to the shared submodule is fine)" >&2
  exit 2
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OVERLAY="$REPO_ROOT/firmware/overlay/sdkconfig.release.nanoc6"
if [[ ! -f "$OVERLAY" ]]; then
  echo "error: overlay not found at $OVERLAY" >&2
  exit 2
fi

APP_DIR="$ESP_MATTER_SRC/examples/door_lock"

# Copy the overlay into the example dir so idf.py's SDKCONFIG_DEFAULTS
# search resolves it relative to the app directory. Removed by the
# `finally` cleanup below.
OVERLAY_LOCAL="$APP_DIR/sdkconfig.release.nanoc6"
cp "$OVERLAY" "$OVERLAY_LOCAL"

cleanup() {
  # Restore the pristine example directory by removing artefacts the
  # build created (except build/, which is what the caller wants).
  # The overlay copy is ours; safe to delete.
  [[ -f "$OVERLAY_LOCAL" ]] && command rm -f "$OVERLAY_LOCAL"
}
trap cleanup EXIT

cd "$APP_DIR"

echo "=== esp-matter env ==="
if [[ -f "$ESP_MATTER_SRC/export.sh" ]]; then
  # export.sh reads this variable without a default value. Set it before
  # sourcing the file because this script enables nounset.
  export ESP_MATTER_PATH="$ESP_MATTER_SRC"
  # shellcheck disable=SC1091
  . "$ESP_MATTER_SRC/export.sh"
fi

echo "=== set-target esp32c6 with layered defaults ==="
idf.py \
  -D SDKCONFIG_DEFAULTS="sdkconfig.esp32c6.aliro;sdkconfig.release.nanoc6" \
  set-target esp32c6

echo "=== build ==="
idf.py build

echo "=== size ==="
idf.py size

echo
echo "Build complete."
echo "  APP_DIR       = $APP_DIR"
echo "  build/        = $APP_DIR/build"
echo "  target tag    = $TAG"
echo
echo "Next: scripts/prepare_release.sh $APP_DIR/build $TAG"
