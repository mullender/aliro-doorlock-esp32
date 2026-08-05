// boot-log-fixtures.js
//
// Synthetic boot logs used to test the parser regexes. Once a real device
// bring-up produces a boot log (lab_notes/YYYY-MM-DD-boot.log), replace
// or supplement these fixtures with a verbatim capture and keep both.
//
// Every fixture has a label, a `log` string (the input), and either
// `expect` (a { mt, manualCode } pair) or `expectFail: true`.

export const LOG_FIXTURES = [
  {
    label: "canonical SDK 1.x output — both lines present, in order",
    log: [
      "I (2500) esp_ot_init: OpenThread interface up",
      "CHIP:SVR: SetupQRCode: [MT:Y.K9042C00KA0648G00]",
      "CHIP:SVR: Copy/paste the below URL in a browser to see the QR Code:",
      "CHIP:SVR: https://project-chip.github.io/connectedhomeip/qrcode.html?data=MT%3AY.K9042C00KA0648G00",
      "CHIP:SVR: Manual pairing code: [34970112332]",
      "I (2510) app: door lock ready",
    ].join("\n"),
    expect: { mt: "MT:Y.K9042C00KA0648G00", manualCode: "34970112332" },
  },
  {
    label: "older SDK 1.0 with CH: prefix",
    log: [
      "CH:SVR: SetupQRCode: [MT:-24J042C00KA0648G00]",
      "CH:SVR: Manual pairing code: [34970112332]",
    ].join("\n"),
    expect: { mt: "MT:-24J042C00KA0648G00", manualCode: "34970112332" },
  },
  {
    label: "SDK log tag with tight spacing (some builds emit no space after colon)",
    log: [
      "CHIP:SVR:SetupQRCode: [MT:Y.K9042C00KA0648G00]",
      "CHIP:SVR:Manual pairing code: [34970112332]",
    ].join("\n"),
    expect: { mt: "MT:Y.K9042C00KA0648G00", manualCode: "34970112332" },
  },
  {
    label: "lines interleaved with unrelated logs — parser must skip past them",
    log: [
      "I (100) boot: ESP-ROM:esp32c6-20220919",
      "I (200) cpu_start: Pro cpu start user code",
      "CHIP:SVR: SetupQRCode: [MT:Y.K9042C00KA0648G00]",
      "CHIP:BLE: NimBLE started",
      "CHIP:DIS: mDNS platform initialized successfully",
      "CHIP:SVR: Manual pairing code: [34970112332]",
      "CHIP:DIS: Advertise commission parameter vendorID=0xFFF1 productID=0x8000",
    ].join("\n"),
    expect: { mt: "MT:Y.K9042C00KA0648G00", manualCode: "34970112332" },
  },
  {
    label: "lines out of order (Manual first, then QR)",
    log: [
      "CHIP:SVR: Manual pairing code: [34970112332]",
      "CHIP:SVR: SetupQRCode: [MT:Y.K9042C00KA0648G00]",
    ].join("\n"),
    expect: { mt: "MT:Y.K9042C00KA0648G00", manualCode: "34970112332" },
  },
  {
    label: "with ANSI colour escapes",
    log:
      "\x1b[32mI (2500) esp_ot_init:\x1b[0m OpenThread interface up\n" +
      "\x1b[36mCHIP:SVR:\x1b[0m SetupQRCode: [MT:Y.K9042C00KA0648G00]\n" +
      "\x1b[36mCHIP:SVR:\x1b[0m Manual pairing code: [34970112332]\n",
    expect: { mt: "MT:Y.K9042C00KA0648G00", manualCode: "34970112332" },
  },
  {
    label: "only the QR-URL line survives (tagged line lost in log noise)",
    log: [
      "some junk",
      "CHIP:SVR: https://project-chip.github.io/connectedhomeip/qrcode.html?data=MT%3AY.K9042C00KA0648G00",
      "CHIP:SVR: Manual pairing code: [34970112332]",
    ].join("\n"),
    expect: { mt: "MT:Y.K9042C00KA0648G00", manualCode: "34970112332" },
  },
  {
    label: "MT: line only, no manual — expected to fail parse",
    log: "CHIP:SVR: SetupQRCode: [MT:Y.K9042C00KA0648G00]",
    expectFail: true,
  },
  {
    label: "Manual line only, no MT: — expected to fail parse",
    log: "CHIP:SVR: Manual pairing code: [34970112332]",
    expectFail: true,
  },
  {
    label: "empty log",
    log: "",
    expectFail: true,
  },
];
