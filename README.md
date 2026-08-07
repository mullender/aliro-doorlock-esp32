# Aliro Door Lock for ESP32-C6

Build a tap-to-unlock, virtual Matter-over-Thread door lock for about **$13**.
Add it to your smart home, use an Apple Home Key at the NFC reader, and use
the lock state to start an automation.

> [Install the firmware in your browser](https://mullender.github.io/aliro-doorlock-esp32/)

The device does not move a physical lock by itself. It gives your automation
system a Matter lock that can receive an Aliro wallet credential. Your
automation can then unlock a real lock, open a garage door, disarm an alarm,
or run another action.

## $13 hardware

| Part | Price |
|---|---:|
| [M5Stack NanoC6 Dev Kit](https://shop.m5stack.com/products/m5stack-nanoc6-dev-kit) | about $6 |
| [M5Stack NFC Universal Unit (ST25R3916)](https://shop.m5stack.com/products/nfc-universal-unit-st25r3916) | $7.00 |
| **Total** | **about $13** |

Prices are from M5Stack on 2026-08-07 and are rounded. Tax and shipping are
not included, and prices can change. Connect the NFC unit with its Grove
cable, then connect the NanoC6 to your computer with a USB-C data cable.

## What works

- Matter door lock over Thread on the ESP32-C6.
- Matter setup from the browser, with a QR code for Apple Home, Google Home,
  or Home Assistant.
- Apple Home Key setup and tap-to-unlock.
- Persistent Matter, Thread, Aliro, auto-lock, and LED settings across a
  preserving firmware update.
- Green, red, or blue RGB feedback for successful credentials, failed
  credentials, and other NFC tags.
- A browser settings page for auto-lock time and LED colors and durations.

Aliro is designed for wallet-based access credentials across smart-home
ecosystems. Apple Home Key is tested with this build. Google Home can act as
a Matter controller, but a Google wallet key has not been verified in this
project. Support depends on Google's Aliro rollout and the controller device.

This is development hardware with Matter test attestation. Do not use it as
the only control for a door, alarm, or other safety-critical system.

## Try it

You need:

- the two M5Stack parts above;
- a USB-C data cable;
- Chrome or Edge on a desktop computer;
- a Thread border router, such as a HomePod mini, a second-generation
  HomePod, a compatible Google Nest Hub, or Home Assistant with a supported
  Thread radio; and
- Bluetooth on the phone that you use for Matter setup.

Then:

1. Connect the NFC unit to the NanoC6.
2. Open the [Aliro door-lock installer](https://mullender.github.io/aliro-doorlock-esp32/).
3. Select **Factory install — erase everything** for the first install.
4. Connect to the device and scan the Matter QR code.
5. Add a Home Key in Apple Home, then tap it on the NFC reader.
6. Use the virtual lock state as a trigger or condition in your automation
   system.

For later releases, select **Update firmware — keep setup**. This update keeps
the Matter fabrics, Thread credentials, Aliro keys, and lock settings.

## How it fits together

```text
Phone wallet
    │  NFC / Aliro credential
    ▼
ST25R3916 reader ── Grove / I²C ── NanoC6
                                      │
                                      │ Matter over Thread
                                      ▼
                         Apple Home, Google Home,
                         or Home Assistant
                                      │
                                      ▼
                               Your automation
```

The firmware builds on Espressif's `esp-matter` door-lock example. The
browser installer, firmware patches, release scripts, and verification tests
live in this repository so each release uses one reviewed contract.

## Current status

The current prerelease is
[`aliro-c6-v0.0.4-devkit`](https://github.com/mullender/aliro-doorlock-esp32/releases/tag/aliro-c6-v0.0.4-devkit).
The browser installer and Apple Home Key flow work on the M5Stack NanoC6 and
the ST25R3916 unit. This is still a devkit release, not a certified retail
lock.

## Repository map

```text
firmware/              Audited esp-matter patches, release config, and tests
installer/             Browser installer and device settings UI
scripts/               Build, package, flash, and verification helpers
docs/                  Design notes and investigation records
lab_notes/             Hardware bring-up records
.github/workflows/     Tested GitHub Pages deployment
```

Build and release details are in
[`firmware/RELEASE.md`](firmware/RELEASE.md). Installer design and local test
commands are in [`installer/README.md`](installer/README.md).

## License

The repository uses the Apache-2.0 license. See [`LICENSE`](LICENSE).

The firmware links to Espressif's precompiled `esp_aliro_lib`. Review the
license terms for that component before you redistribute a firmware binary.
