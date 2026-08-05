# aliro-doorlock-esp32

Aliro door-lock reader firmware for ESP32 boards, plus a Chrome-browser
flasher that takes you from unboxing to a Matter-adopted device in one page.

**Status:** early — plans landed, scaffolding in place, hardware bring-up
pending.

## What this is

- Aliro (the CSA Matter-based access-credential protocol) reader firmware
  for ESP32 boards with an 802.15.4 radio (ESP32-C6 today, others as
  supported).
- Multiple NFC front-ends supported over time; the reference build targets
  the M5Stack Unit NFC (ST25R3916) on the M5Stack NanoC6.
- A GitHub-Pages-hosted browser flasher: plug the board into USB, click
  **Install**, then scan the Matter QR that appears on screen with Apple
  Home, Google Home, or Home Assistant.

The two are deliberately co-located in one repository: the firmware and
the flasher share a release channel and a commissioning contract.

## What this is not

- The HomeKit-only build for the ESP32-S3 (M5Stack AtomS3 Lite) lives in
  a sibling repository — `mullender/HomeKey-ESP32`. It uses a different
  framework (HomeSpan), a different chip, a different NFC driver, and a
  different post-flash flow (Improv Wi-Fi). No code is shared today.
- Not an Espressif project. It builds against Espressif's
  [`esp-matter`](https://github.com/espressif/esp-matter) `door_lock`
  example without modifying it.

## Repository layout

```
docs/                  Plans and evidence — start with docs/README.md
firmware/              Aliro firmware overlay (Phase 5); stock esp-matter today
installer/             Browser flasher (index.html, JS, CSS)
  vendor/              Third-party dependencies (esp-web-tools fork)
lab_notes/             One markdown file per bring-up session
scripts/               Build/flash helper shell scripts
.github/workflows/     CI, including deploy-installer.yml
LEDGER.md              Running record of findings, questions, and decisions
```

## Start here

If you are a new engineer picking this up:

1. Read `docs/README.md` for the map of plans.
2. Read `docs/run_aliro_door_lock_on_nanoc6_plan.md` for hardware bring-up.
3. Skim `LEDGER.md` for open questions and recent decisions.

## License

Apache-2.0. See `LICENSE`.

The firmware overlay links against `esp_aliro_lib` from Espressif, which
is a precompiled binary under a non-Apache licence. Confirm the exact
terms of the Espressif component registry entry before redistribution of
built binaries.
