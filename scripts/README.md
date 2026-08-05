# scripts/

Bring-up helpers referenced by
`../docs/run_aliro_door_lock_on_nanoc6_plan.md`.

All scripts are idempotent, safe to re-run, and print what they will do
before doing it. None modify tracked files. None commit.

## Contents

- `preflight.sh` — check host prerequisites (ESP-IDF exported, esp-matter
  reachable, USB port present). Read only.
- `build.sh` — invoke `idf.py set-target esp32c6` and `idf.py build`
  against `esp-matter/examples/door_lock` with the aliro config.
- `flash_monitor.sh` — erase + flash + monitor. Requires a `--port`
  argument; will refuse to guess.
- `capture_boot_log.sh` — flash and capture the boot log to a fresh
  `lab_notes/YYYY-MM-DD-boot.log` file.

None of these scripts run during CI. They are engineer-side helpers only.

## Requirements

- ESP-IDF installed and its `export.sh` sourced in the current shell.
- `~/Development/esp-matter` checked out with submodules initialised
  (see the bring-up plan for the pin discipline).
- macOS or Linux; no Windows support today.
