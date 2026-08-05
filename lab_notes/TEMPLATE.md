# Lab Notes — YYYY-MM-DD — <short slug>

**Engineer:** <name>
**Host OS:** macOS 14.x / Ubuntu 22.04 / ...
**Hardware:** M5NanoC6 (rev X) + Unit NFC (ST25R3916 / PN532)
**Controller:** Home Assistant Companion / Apple Home / Google Home
**Border router:** Home Assistant + SkyConnect / HomePod / Nest Hub

## Environment

- ESP-IDF: version X.Y.Z, SHA `<hex>`
- esp-matter: HEAD `<hex>`
- Submodule status:
  ```
  <paste `git submodule status --recursive` output>
  ```

## Build

- Command: `idf.py -D SDKCONFIG_DEFAULTS="sdkconfig.esp32c6.aliro" set-target esp32c6 build`
- Result: success / failure
- Size:
  ```
  <paste `idf.py size` output>
  ```
- Warnings of note: <text or "none">

## Flash

- Port: `/dev/tty.usbmodem...` / `/dev/ttyACM...`
- Command: `idf.py -p <port> erase-flash flash monitor`
- Time to boot: <seconds>

## Boot log (verbatim)

```
<paste full boot log — DO NOT edit or truncate>
```

## Onboarding codes

- QR payload: `MT:...`
- Manual pairing code: `...`
- Match against expected shared example (`MT:Y.K9042C00KA0648G00`,
  `34970112332`)? yes / no
- Parsed by browser correctly? yes / no / not tested

## I2C / NFC

- ST25R3916 driver banner present in log? yes / no
- I2C probe result on GPIO SDA=2, SCL=1: `0x??` at ...

## Commissioning

- Controller: <name>
- BLE discovery: succeeded / timed out
- Thread dataset hand-off: succeeded / failed at ...
- Time from QR scan to device visible in controller: <seconds>
- Attestation warning shown? <text>

## Aliro delegate exercise

- `NumberOfAliroCredentialIssuerKeysSupported`: <value> (expected 8)
- `NumberOfAliroEndpointKeysSupported`: <value> (expected 8)
- `SetAliroReaderConfig` with test values: succeeded / failed with ...
- `AliroReaderConfig` read-back matches write? yes / no
- `ClearAliroReaderConfig`: succeeded / failed

## Deviations from plan

<what you did differently and why>

## Follow-ups for the ledger

<items to promote into ../LEDGER.md>
