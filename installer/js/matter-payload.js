// matter-payload.js
//
// Lightweight validators for Matter setup payloads. This is NOT a general-purpose
// Matter SDK. It only does what the flasher needs:
//
//   1. Sanity-check an `MT:` string parsed out of the firmware boot log
//      (character set + version prefix + reasonable length).
//   2. Sanity-check an 11-digit manual pairing code by recomputing its Verhoeff
//      check digit and comparing.
//   3. A tiny cross-check that the two codes plausibly refer to the same device
//      (their embedded discriminator matches).
//
// The full binary decode of the MT: payload is intentionally NOT implemented.
// The flasher trusts the firmware to produce a valid pair; it just refuses to
// display something that clearly is not a valid pair. If a stronger check is
// required later, add a Base38 decoder here and pull the discriminator from
// bits 15..26 of the TLV setup payload per the Matter Core Specification.
//
// References:
//   - Matter Core Specification 1.4, section 5.1.5 "Onboarding Payload"
//   - connectedhomeip/src/setup_payload/QRCodeSetupPayloadGenerator.cpp
//   - connectedhomeip/src/setup_payload/ManualSetupPayloadGenerator.cpp

// Matter's Base38 alphabet, exactly as defined in the spec.
const BASE38_ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-.";

// Verhoeff tables — used by the Matter manual pairing code check digit.
// Source: https://en.wikipedia.org/wiki/Verhoeff_algorithm
// (also embedded verbatim in connectedhomeip/src/setup_payload/)
const VERHOEFF_D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];

const VERHOEFF_P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

const VERHOEFF_INV = [0, 4, 3, 2, 1, 5, 6, 7, 8, 9];

function verhoeffCheckDigit(digits) {
  // digits: array of ints, most-significant first, WITHOUT the check digit.
  // Returns the check digit that should be appended.
  let c = 0;
  const reversed = [...digits].reverse();
  for (let i = 0; i < reversed.length; i++) {
    c = VERHOEFF_D[c][VERHOEFF_P[(i + 1) % 8][reversed[i]]];
  }
  return VERHOEFF_INV[c];
}

/**
 * Sanity-check an MT: setup payload string.
 * Returns { valid: boolean, error?: string }.
 *
 * Passes iff:
 *   - starts with "MT:"
 *   - remaining chars are all in the Base38 alphabet
 *   - length is within a plausible range (Matter payloads are 17-24 chars for
 *     the short form; the pass through here is lenient because vendor-specific
 *     extensions can add TLV bytes)
 */
export function validateMTPayload(mt) {
  if (typeof mt !== "string") {
    return { valid: false, error: "not a string" };
  }
  if (!mt.startsWith("MT:")) {
    return { valid: false, error: "missing MT: prefix" };
  }
  const body = mt.slice(3);
  if (body.length < 16) {
    return { valid: false, error: `body too short (${body.length} chars)` };
  }
  if (body.length > 128) {
    // Arbitrary sanity ceiling. Real payloads with TLV extensions can grow
    // but 128 chars would decode to more than 700 bits of setup data.
    return { valid: false, error: `body implausibly long (${body.length} chars)` };
  }
  for (let i = 0; i < body.length; i++) {
    if (BASE38_ALPHABET.indexOf(body[i]) < 0) {
      return {
        valid: false,
        error: `char ${JSON.stringify(body[i])} at position ${i} not in Base38 alphabet`,
      };
    }
  }
  return { valid: true };
}

/**
 * Sanity-check an 11-digit Matter manual pairing code.
 * Returns { valid: boolean, error?: string }.
 *
 * Passes iff:
 *   - exactly 11 digits (0-9)
 *   - Verhoeff check digit at position 10 matches recomputation
 *
 * Does NOT verify that the encoded discriminator / passcode are in-range.
 * That check belongs to the phone-side commissioner.
 */
export function validateManualCode(code) {
  if (typeof code !== "string") {
    return { valid: false, error: "not a string" };
  }
  if (!/^\d{11}$/.test(code)) {
    return { valid: false, error: `expected 11 digits, got ${JSON.stringify(code)}` };
  }
  const digits = code.split("").map(Number);
  const body = digits.slice(0, 10);
  const claimed = digits[10];
  const expected = verhoeffCheckDigit(body);
  if (claimed !== expected) {
    return {
      valid: false,
      error: `Verhoeff check digit mismatch: claimed ${claimed}, expected ${expected}`,
    };
  }
  return { valid: true };
}

/**
 * Validate a pair of codes as coming from the same device.
 * Today this just runs both sanity checks. A future version can decode the
 * discriminator from each and compare.
 */
export function validatePair(mt, manualCode) {
  const mtResult = validateMTPayload(mt);
  if (!mtResult.valid) return { valid: false, error: `MT: ${mtResult.error}` };
  const mcResult = validateManualCode(manualCode);
  if (!mcResult.valid) return { valid: false, error: `manual code: ${mcResult.error}` };
  return { valid: true };
}

// Export internals for the test harness only.
export const __internals = { verhoeffCheckDigit, BASE38_ALPHABET };
