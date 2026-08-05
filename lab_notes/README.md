# lab_notes/

One markdown file per bring-up session. Naming: `YYYY-MM-DD-<slug>.md`.

Boot logs from these sessions become the test fixtures for the flasher's
serial-log parser. Keep raw logs verbatim in fenced code blocks.

## What to record

Copy `TEMPLATE.md`. Every session captures:

- Date, engineer, host OS.
- ESP-IDF version and the SHA at build time.
- `esp-matter` HEAD commit and submodule status.
- Full boot log (fenced, verbatim; redact only genuinely sensitive
  material).
- `idf.py size` output.
- Controller used (Apple Home / Google Home / Home Assistant Companion).
- Commissioning outcome and any error text.
- Deviations from `../docs/run_aliro_door_lock_on_nanoc6_plan.md` and why.

## Privacy

Session logs may contain USB serial numbers, MAC addresses, and Thread
credentials. Do not commit files matching `*.local.md` (already in
`.gitignore`). Anything sensitive goes there; the parser fixtures live
in the plain `.md` files.
