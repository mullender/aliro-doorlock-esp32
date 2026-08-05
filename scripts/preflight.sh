#!/usr/bin/env bash
# preflight.sh — check host prerequisites for building the Aliro C6 firmware.
#
# Read only. Prints one line per check. Exits non-zero on the first failure
# with a plain-English fix suggestion.
#
# Usage:
#   scripts/preflight.sh
#
# Environment (optional):
#   ESP_MATTER_DIR   defaults to ~/Development/esp-matter

set -euo pipefail

ESP_MATTER_DIR="${ESP_MATTER_DIR:-$HOME/Development/esp-matter}"

pass() { printf "  \033[32mok\033[0m    %s\n" "$1"; }
fail() { printf "  \033[31mfail\033[0m  %s\n\n  fix: %s\n" "$1" "$2"; exit 1; }

echo "aliro-doorlock-esp32 preflight"
echo "==============================="

# ESP-IDF exported into current shell.
if [[ -z "${IDF_PATH:-}" ]]; then
  fail "IDF_PATH is not set" \
       "Source ESP-IDF's export.sh in the current shell, e.g. '. \$HOME/esp/esp-idf-vX.Y/export.sh'"
fi
pass "IDF_PATH=${IDF_PATH}"

# idf.py available.
if ! command -v idf.py >/dev/null 2>&1; then
  fail "idf.py is not on PATH" \
       "Confirm ESP-IDF's export.sh sourced its bin/ directory into PATH."
fi
pass "idf.py at $(command -v idf.py)"

# ESP-IDF version signal (do not enforce a specific version here; the plan
# does that. Just show what's active).
IDF_VERSION="$(idf.py --version 2>/dev/null | head -1 || echo 'unknown')"
pass "ESP-IDF version reported: ${IDF_VERSION}"

# esp-matter checkout present.
if [[ ! -d "${ESP_MATTER_DIR}" ]]; then
  fail "esp-matter not found at ${ESP_MATTER_DIR}" \
       "Clone with 'git clone --recursive https://github.com/espressif/esp-matter.git ${ESP_MATTER_DIR}'"
fi
pass "esp-matter at ${ESP_MATTER_DIR}"

# esp-matter submodules initialised.
if [[ ! -f "${ESP_MATTER_DIR}/connectedhomeip/connectedhomeip/BUILD.gn" ]] \
   && [[ ! -f "${ESP_MATTER_DIR}/connectedhomeip/BUILD.gn" ]]; then
  fail "esp-matter submodules do not look initialised" \
       "Run 'git -C ${ESP_MATTER_DIR} submodule update --init --recursive'"
fi
pass "esp-matter submodules present"

# door_lock example present.
DOOR_LOCK_DIR="${ESP_MATTER_DIR}/examples/door_lock"
if [[ ! -f "${DOOR_LOCK_DIR}/sdkconfig.esp32c6.aliro" ]]; then
  fail "sdkconfig.esp32c6.aliro not found in ${DOOR_LOCK_DIR}" \
       "Confirm your esp-matter checkout is recent enough to include the Aliro example."
fi
pass "door_lock example with aliro config present"

# Suggest but do not enforce a specific IDF version pin — read from the
# checked-out esp-matter's CI script.
IDF_REF_FILE="${ESP_MATTER_DIR}/tools/ci/idf_ref.sh"
if [[ -f "${IDF_REF_FILE}" ]]; then
  IDF_REF="$(grep -E '^ESP_IDF_(REF|BRANCH|VERSION)=' "${IDF_REF_FILE}" | head -1 || true)"
  if [[ -n "${IDF_REF}" ]]; then
    pass "esp-matter suggests IDF pin: ${IDF_REF}"
  fi
fi

echo
echo "Preflight passed. Continue with scripts/build.sh"
