#!/usr/bin/env bash
# capture_boot_log.sh — flash the device, capture the boot log for a fixed
# duration, and save it into lab_notes/ as a plain text file that the
# per-session TEMPLATE.md can reference.
#
# This runs the monitor headless (no interactive prompt) for a bounded
# window, then exits so the log can be committed.
#
# Usage:
#   scripts/capture_boot_log.sh --port /dev/tty.usbmodem101 [--seconds 30]
#
# Environment:
#   ESP_MATTER_DIR   defaults to ~/Development/esp-matter
#   LAB_NOTES_DIR    defaults to $(git rev-parse --show-toplevel)/lab_notes

set -euo pipefail

ESP_MATTER_DIR="${ESP_MATTER_DIR:-$HOME/Development/esp-matter}"
LAB_NOTES_DIR="${LAB_NOTES_DIR:-$(git rev-parse --show-toplevel 2>/dev/null)/lab_notes}"
PORT=""
SECONDS_TO_CAPTURE=30

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --seconds) SECONDS_TO_CAPTURE="$2"; shift 2 ;;
    *) echo "unknown arg: $1"; exit 2 ;;
  esac
done

if [[ -z "${PORT}" ]]; then
  echo "error: --port is required."
  exit 2
fi
if [[ ! -e "${PORT}" ]]; then
  echo "error: ${PORT} does not exist."
  exit 2
fi
if [[ ! -d "${LAB_NOTES_DIR}" ]]; then
  echo "error: ${LAB_NOTES_DIR} not found. Run from the repo or set LAB_NOTES_DIR."
  exit 2
fi

DOOR_LOCK_DIR="${ESP_MATTER_DIR}/examples/door_lock"
cd "${DOOR_LOCK_DIR}"

if [[ -f "${ESP_MATTER_DIR}/export.sh" ]]; then
  # shellcheck disable=SC1091
  . "${ESP_MATTER_DIR}/export.sh"
fi

# Use a portable-ish date; macOS `date` supports -u and +%F.
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="${LAB_NOTES_DIR}/${STAMP}-boot.log"

echo "Flashing (no erase; use scripts/flash_monitor.sh for erase)"
idf.py -p "${PORT}" flash

echo "Capturing ${SECONDS_TO_CAPTURE}s of serial output to ${OUT}"
# Prefer esptool.py monitor via idf.py, but that is interactive. Use a
# background monitor with a timeout instead.
#
# The idiomatic capture uses `python -m esp_idf_monitor` with a --no-input
# flag. Fall back to `screen` if that is unavailable.
if command -v esp_idf_monitor >/dev/null 2>&1 || \
   python -c "import esp_idf_monitor" >/dev/null 2>&1; then
  # Preferred: bounded run of the IDF monitor
  timeout "${SECONDS_TO_CAPTURE}s" python -m esp_idf_monitor -p "${PORT}" \
    --disable-address-decoding > "${OUT}" 2>&1 || true
elif command -v tio >/dev/null 2>&1; then
  timeout "${SECONDS_TO_CAPTURE}s" tio -b 115200 -m INLCRNL "${PORT}" \
    > "${OUT}" 2>&1 || true
else
  echo "warning: no non-interactive monitor found (esp_idf_monitor or tio)."
  echo "Falling back to raw cat with stty. This may drop bytes."
  stty -f "${PORT}" 115200 raw -echo 2>/dev/null || stty -F "${PORT}" 115200 raw -echo
  timeout "${SECONDS_TO_CAPTURE}s" cat "${PORT}" > "${OUT}" || true
fi

# Extract the onboarding lines for quick eyeballing.
echo
echo "----- extracted MT: payload / manual code (if present) -----"
grep -E 'CHIP:SVR.*SetupQRCode|CHIP:SVR.*Manual pairing code|CH:|MT:' "${OUT}" || echo "(none found)"
echo "-----"
echo
echo "Full log saved to ${OUT}"
echo "Remember: lab_notes/*.md is the write-up. This .log is a fixture."
