#!/usr/bin/env bash
# build.sh — build esp-matter/examples/door_lock for ESP32-C6 with the Aliro
# config. Idempotent; safe to re-run.
#
# Usage:
#   scripts/build.sh [--clean]
#
# Options:
#   --clean   remove build/ and sdkconfig before building
#
# Environment:
#   ESP_MATTER_DIR   defaults to ~/Development/esp-matter

set -euo pipefail

ESP_MATTER_DIR="${ESP_MATTER_DIR:-$HOME/Development/esp-matter}"
CLEAN=0

for arg in "$@"; do
  case "$arg" in
    --clean) CLEAN=1 ;;
    *) echo "usage: $0 [--clean]"; exit 2 ;;
  esac
done

# Preflight, but do not fail if the user has bypassed it. Show a warning.
if ! "$(dirname "$0")/preflight.sh" >/dev/null 2>&1; then
  echo "warning: preflight failed. Running scripts/preflight.sh directly will show details."
fi

DOOR_LOCK_DIR="${ESP_MATTER_DIR}/examples/door_lock"
cd "${DOOR_LOCK_DIR}"

# Source esp-matter env if it exists. If not, the user is expected to have
# already exported IDF and esp-matter into the shell.
if [[ -f "${ESP_MATTER_DIR}/export.sh" ]]; then
  # shellcheck disable=SC1091
  . "${ESP_MATTER_DIR}/export.sh"
fi

if [[ "${CLEAN}" == "1" ]]; then
  echo "Cleaning build/ and sdkconfig"
  rm -rf build sdkconfig
fi

echo "Setting target esp32c6 with sdkconfig.esp32c6.aliro"
idf.py -D SDKCONFIG_DEFAULTS="sdkconfig.esp32c6.aliro" set-target esp32c6

echo "Building"
idf.py build

echo
idf.py size
echo
echo "Built at $(pwd)/build. Flash with:"
echo "  scripts/flash_monitor.sh --port /dev/tty.usbmodemXXX"
