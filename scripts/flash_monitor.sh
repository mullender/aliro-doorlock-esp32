#!/usr/bin/env bash
# flash_monitor.sh — erase + flash + monitor. Requires --port explicitly.
#
# Usage:
#   scripts/flash_monitor.sh --port /dev/tty.usbmodem101 [--no-erase]
#
# Options:
#   --port PATH   USB serial port (required; script will not guess)
#   --no-erase    skip erase-flash. Default is to erase on every flash
#                 because the plan says the first boot needs clean flash.
#
# Environment:
#   ESP_MATTER_DIR   defaults to ~/Development/esp-matter

set -euo pipefail

ESP_MATTER_DIR="${ESP_MATTER_DIR:-$HOME/Development/esp-matter}"
PORT=""
ERASE=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --no-erase) ERASE=0; shift ;;
    *) echo "unknown arg: $1"; exit 2 ;;
  esac
done

if [[ -z "${PORT}" ]]; then
  echo "error: --port is required. Common values:"
  echo "  macOS: ls /dev/tty.usbmodem* /dev/cu.usbmodem*"
  echo "  Linux: ls /dev/ttyACM*"
  exit 2
fi

if [[ ! -e "${PORT}" ]]; then
  echo "error: ${PORT} does not exist. Is the NanoC6 plugged in?"
  exit 2
fi

DOOR_LOCK_DIR="${ESP_MATTER_DIR}/examples/door_lock"
cd "${DOOR_LOCK_DIR}"

if [[ -f "${ESP_MATTER_DIR}/export.sh" ]]; then
  # shellcheck disable=SC1091
  . "${ESP_MATTER_DIR}/export.sh"
fi

if [[ ! -d "build" ]]; then
  echo "error: no build/ directory. Run scripts/build.sh first."
  exit 2
fi

if [[ "${ERASE}" == "1" ]]; then
  echo "Erasing flash on ${PORT}"
  idf.py -p "${PORT}" erase-flash
fi

echo "Flashing and monitoring ${PORT}"
echo "Ctrl+] to exit the monitor."
idf.py -p "${PORT}" flash monitor
