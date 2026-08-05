// test-vectors.js
//
// Known Matter setup payloads used by the ESP-Matter examples and the Matter
// SDK developer docs. These are the pairs the flasher must accept.
//
// The "shared example" values appear verbatim in every esp-matter example's
// default build (passcode 20202021, discriminator 3840, VID 0xFFF1, PID 0x8000).
//
// Two independently sourced encodings with the same passcode and discriminator
// are included to guard against silent library changes. If a payload string in this file no
// longer round-trips through the validators, the validators are wrong or the
// Matter spec has changed — investigate before "fixing" the vectors.

export const VECTORS = [
  {
    label: "esp-matter shared example (form A — SDK 1.x)",
    mt: "MT:Y.K9042C00KA0648G00",
    manualCode: "34970112332",
    passcode: 20202021,
    discriminator: 3840,
    valid: true,
  },
  {
    label: "esp-matter shared example (form B — earlier SDK, same discriminator)",
    // The older SDK produced this alternate MT: encoding for the same setup
    // parameters. Included so the validator's Base38 check tolerates both.
    mt: "MT:-24J042C00KA0648G00",
    manualCode: "34970112332",
    passcode: 20202021,
    discriminator: 3840,
    valid: true,
  },
];

// These vectors come from connectedhomeip TestQRCode.cpp.
export const BASE38_VECTORS = [
  { bytes: [72, 101, 108, 108, 111, 32, 87, 111, 114, 108, 100, 33], encoded: "KKHF3W2S013OPM3EJX11" },
  { bytes: [10], encoded: "A0" },
  { bytes: [255], encoded: "R6" },
  { bytes: [0, 1], encoded: "S600" },
  { bytes: [255, 255], encoded: "NE71" },
  { bytes: [0, 0, 1], encoded: "OE710" },
  { bytes: [255, 255, 255], encoded: "PLS18" },
];

export const INVALID_BASE38_VECTORS = ["S6", "OE71", "QLS18"];

export const NEGATIVE_VECTORS = [
  {
    label: "empty string",
    mt: "",
    manualCode: "",
    expectError: /missing MT/,
  },
  {
    label: "MT: prefix but body too short",
    mt: "MT:ABC",
    manualCode: "34970112332",
    expectError: /body too short/,
  },
  {
    label: "MT: with invalid Base38 char",
    mt: "MT:Y.K9042C00KA0648G0#",
    manualCode: "34970112332",
    expectError: /not in Base38 alphabet/,
  },
  {
    label: "manual code with wrong check digit",
    mt: "MT:Y.K9042C00KA0648G00",
    // Original was 34970112332; last digit changed to 3.
    manualCode: "34970112333",
    expectError: /Verhoeff check digit mismatch/,
  },
  {
    label: "manual code with 10 digits",
    mt: "MT:Y.K9042C00KA0648G00",
    manualCode: "3497011233",
    expectError: /expected 11 digits/,
  },
  {
    label: "manual code with non-digit character",
    mt: "MT:Y.K9042C00KA0648G00",
    manualCode: "3497011233A",
    expectError: /expected 11 digits/,
  },
  {
    label: "valid manual code for a different discriminator",
    mt: "MT:Y.K9042C00KA0648G00",
    manualCode: "00054912336",
    expectError: /different discriminators/,
  },
];
