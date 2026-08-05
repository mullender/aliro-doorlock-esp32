#!/usr/bin/env bash
# Build the Aliro NanoC6 release image against a
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
#   TAG              release tag; default aliro-c6-v0.0.2-devkit
#   ESP_MATTER_REVISION
#                    required when ESP_MATTER_SRC is a git archive
#
# Outputs:
#   $ESP_MATTER_SRC/examples/door_lock/build/              build tree
#   $ESP_MATTER_SRC/examples/door_lock/build/door_lock.bin app image
#
# The merged 4 MB factory image and its .sha256 sidecar are produced by
# scripts/prepare_release.sh, which consumes the outputs of this script.

set -euo pipefail

: "${ESP_MATTER_SRC:?set to absolute path of a clean esp-matter source tree}"
: "${IDF_PATH:?ESP-IDF not exported. source \$IDF_PATH/export.sh first}"

TAG="${TAG:-aliro-c6-v0.0.2-devkit}"
PINNED_ESP_MATTER="85c76a1788c5b70b4b0811734af8616dda15e7ac"
PINNED_CONNECTEDHOMEIP="efefc94fee39d8d1fbbc3c27b9d7fc9025095887"

if [[ ! -f "$ESP_MATTER_SRC/examples/door_lock/sdkconfig.esp32c6.aliro" ]]; then
  echo "error: $ESP_MATTER_SRC does not look like an esp-matter tree" >&2
  exit 2
fi
if [[ ! "$TAG" =~ ^aliro-c6-[A-Za-z0-9._-]+$ ]]; then
  echo "error: invalid Aliro release tag: $TAG" >&2
  exit 2
fi

SOURCE_ROOT="$(cd "$ESP_MATTER_SRC" && pwd -P)"
GIT_ROOT="$(git -C "$ESP_MATTER_SRC" rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -n "$GIT_ROOT" && "$(cd "$GIT_ROOT" && pwd -P)" == "$SOURCE_ROOT" ]]; then
  ESP_MATTER_REVISION="$(git -C "$ESP_MATTER_SRC" rev-parse HEAD)"
else
  : "${ESP_MATTER_REVISION:?set to the pinned commit for a git-archive source tree}"
fi
if [[ "$ESP_MATTER_REVISION" != "$PINNED_ESP_MATTER" ]]; then
  echo "error: esp-matter revision is $ESP_MATTER_REVISION" >&2
  echo "       expected $PINNED_ESP_MATTER" >&2
  exit 2
fi

if [[ ! -e "$ESP_MATTER_SRC/connectedhomeip/connectedhomeip/BUILD.gn" ]]; then
  echo "error: connectedhomeip submodule not populated under $ESP_MATTER_SRC" >&2
  echo "       (a symlink to the shared submodule is fine)" >&2
  exit 2
fi
CONNECTEDHOMEIP_REVISION="$(git -C "$ESP_MATTER_SRC/connectedhomeip/connectedhomeip" rev-parse HEAD)"
if [[ "$CONNECTEDHOMEIP_REVISION" != "$PINNED_CONNECTEDHOMEIP" ]]; then
  echo "error: connectedhomeip revision is $CONNECTEDHOMEIP_REVISION" >&2
  echo "       expected $PINNED_CONNECTEDHOMEIP" >&2
  exit 2
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OVERLAY="$REPO_ROOT/firmware/overlay/sdkconfig.release.nanoc6"
APP_PATCH="$REPO_ROOT/firmware/patches/0001-print-onboarding-codes.patch"
if [[ ! -f "$OVERLAY" ]]; then
  echo "error: overlay not found at $OVERLAY" >&2
  exit 2
fi
if [[ ! -f "$APP_PATCH" ]]; then
  echo "error: app patch not found at $APP_PATCH" >&2
  exit 2
fi

APP_DIR="$ESP_MATTER_SRC/examples/door_lock"
OVERLAY_LOCAL="$APP_DIR/sdkconfig.release.nanoc6"
PATCH_APPLIED=0
OVERLAY_COPIED=0

cleanup() {
  # Restore the pristine example directory by removing artifacts the
  # build created (except build/, which is what the caller wants).
  # The overlay copy is ours; safe to delete.
  if [[ "$OVERLAY_COPIED" == "1" && -f "$OVERLAY_LOCAL" ]]; then
    command rm -f "$OVERLAY_LOCAL"
  fi
  if [[ "$PATCH_APPLIED" == "1" ]]; then
    if ! patch --batch --reverse -p1 -d "$ESP_MATTER_SRC" < "$APP_PATCH" >/dev/null; then
      echo "warning: could not remove the release source patch" >&2
    fi
  fi
}
trap cleanup EXIT

if [[ -e "$OVERLAY_LOCAL" ]]; then
  echo "error: refusing to overwrite existing $OVERLAY_LOCAL" >&2
  exit 2
fi

# The pinned example does not call PrintOnboardingCodes(). Apply the
# audited project delta for this build, then remove it in cleanup.
patch --batch --forward -p1 -d "$ESP_MATTER_SRC" < "$APP_PATCH"
PATCH_APPLIED=1

# Copy the overlay into the example dir so idf.py's SDKCONFIG_DEFAULTS
# search resolves it relative to the app directory.
cp "$OVERLAY" "$OVERLAY_LOCAL"
OVERLAY_COPIED=1

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
