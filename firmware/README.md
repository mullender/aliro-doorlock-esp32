# firmware/

Aliro firmware overlay for ESP32 boards.

## Today (pre-Phase-5)

Empty. The MVP builds `esp-matter/examples/door_lock` unmodified with the
`sdkconfig.esp32c6.aliro` config. See
`../docs/run_aliro_door_lock_on_nanoc6_plan.md`.

## Phase 5 (unique device credentials)

Will hold either:

- A downstream fork of `esp-matter/examples/door_lock` with a first-boot
  passcode generator and SPAKE2+ verifier derivation, or
- An overlay directory that references a pinned `esp-matter` checkout and
  injects the same code as a small component.

The interface with the flasher does not change between the two options.
The stock `PrintOnboardingCodes()` boot output continues to carry the
per-device values; only the values change.
