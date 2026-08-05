// This module validates the two Matter setup codes that the firmware prints.
// It implements only the fixed setup fields that this installer needs.

const BASE38_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-.";
const QR_FIXED_BYTES = 11;
const MAX_SETUP_PIN = 99999998;
const FORBIDDEN_SETUP_PINS = new Set([
  11111111,
  22222222,
  33333333,
  44444444,
  55555555,
  66666666,
  77777777,
  88888888,
  12345678,
  87654321,
]);

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
  let c = 0;
  const reversed = [...digits].reverse();
  for (let i = 0; i < reversed.length; i++) {
    c = VERHOEFF_D[c][VERHOEFF_P[(i + 1) % 8][reversed[i]]];
  }
  return VERHOEFF_INV[c];
}

function chunkSizeForDecode(remaining) {
  if (remaining >= 5) return { chars: 5, bytes: 3 };
  if (remaining === 4) return { chars: 4, bytes: 2 };
  if (remaining === 2) return { chars: 2, bytes: 1 };
  throw new Error("invalid Base38 length");
}

export function decodeBase38(value) {
  if (typeof value !== "string") throw new TypeError("Base38 value is not a string");
  const bytes = [];
  let offset = 0;
  while (offset < value.length) {
    const { chars, bytes: byteCount } = chunkSizeForDecode(value.length - offset);
    let decoded = 0;
    for (let i = chars - 1; i >= 0; i--) {
      const digit = BASE38_ALPHABET.indexOf(value[offset + i]);
      if (digit < 0) throw new Error("invalid Base38 character");
      decoded = decoded * 38 + digit;
    }
    for (let i = 0; i < byteCount; i++) {
      bytes.push(decoded & 0xff);
      decoded = Math.floor(decoded / 256);
    }
    if (decoded !== 0) throw new Error("Base38 chunk is too large");
    offset += chars;
  }
  return new Uint8Array(bytes);
}

export function encodeBase38(bytes) {
  if (!(bytes instanceof Uint8Array) && !Array.isArray(bytes)) {
    throw new TypeError("Base38 input is not a byte array");
  }
  let output = "";
  for (let offset = 0; offset < bytes.length; offset += 3) {
    const count = Math.min(3, bytes.length - offset);
    let value = 0;
    for (let i = count - 1; i >= 0; i--) value = value * 256 + bytes[offset + i];
    const chars = count === 3 ? 5 : count === 2 ? 4 : 2;
    for (let i = 0; i < chars; i++) {
      output += BASE38_ALPHABET[value % 38];
      value = Math.floor(value / 38);
    }
  }
  return output;
}

function readBits(bytes, offset, count) {
  let value = 0;
  for (let bit = 0; bit < count; bit++) {
    if (bytes[Math.floor((offset + bit) / 8)] & (1 << ((offset + bit) % 8))) {
      value += 2 ** bit;
    }
  }
  return value;
}

export function decodeMTPayload(mt) {
  const syntax = validateMTPayload(mt);
  if (!syntax.valid) throw new Error(syntax.error);
  const bytes = decodeBase38(mt.slice(3));
  if (bytes.length < QR_FIXED_BYTES) throw new Error("payload has too few bytes");
  let offset = 0;
  const take = (count) => {
    const value = readBits(bytes, offset, count);
    offset += count;
    return value;
  };
  const decoded = {
    version: take(3),
    vendorId: take(16),
    productId: take(16),
    commissioningFlow: take(2),
    rendezvousInfo: take(8),
    discriminator: take(12),
    passcode: take(27),
    padding: take(4),
    bytes,
  };
  if (decoded.version !== 0) throw new Error(`unsupported payload version ${decoded.version}`);
  if (decoded.padding !== 0) throw new Error("payload padding is not zero");
  return decoded;
}

export function decodeManualCode(code) {
  const syntax = validateManualCode(code);
  if (!syntax.valid) throw new Error(syntax.error);
  const chunk1 = Number(code.slice(0, 1));
  const chunk2 = Number(code.slice(1, 6));
  const chunk3 = Number(code.slice(6, 10));
  if (chunk1 >= 8) throw new Error("manual code uses an unsupported version");
  const hasVendorProduct = ((chunk1 >> 2) & 1) === 1;
  if (hasVendorProduct) throw new Error("long manual codes are not supported");
  return {
    shortDiscriminator: ((chunk1 & 0x3) << 2) | ((chunk2 >> 14) & 0x3),
    passcode: (chunk2 & 0x3fff) | ((chunk3 & 0x1fff) << 14),
  };
}

export function validateMTPayload(mt) {
  if (typeof mt !== "string") return { valid: false, error: "not a string" };
  if (!mt.startsWith("MT:")) return { valid: false, error: "missing MT: prefix" };
  const body = mt.slice(3);
  if (body.length < 16) return { valid: false, error: `body too short (${body.length} chars)` };
  if (body.length > 128) return { valid: false, error: `body too long (${body.length} chars)` };
  for (let i = 0; i < body.length; i++) {
    if (!BASE38_ALPHABET.includes(body[i])) {
      return { valid: false, error: `char ${JSON.stringify(body[i])} at position ${i} not in Base38 alphabet` };
    }
  }
  try {
    decodeBase38(body);
  } catch (error) {
    return { valid: false, error: error.message };
  }
  return { valid: true };
}

export function validateManualCode(code) {
  if (typeof code !== "string") return { valid: false, error: "not a string" };
  if (!/^\d{11}$/.test(code)) {
    return { valid: false, error: `expected 11 digits, got ${JSON.stringify(code)}` };
  }
  const digits = code.split("").map(Number);
  const expected = verhoeffCheckDigit(digits.slice(0, 10));
  if (digits[10] !== expected) {
    return {
      valid: false,
      error: `Verhoeff check digit mismatch: claimed ${digits[10]}, expected ${expected}`,
    };
  }
  return { valid: true };
}

export function isValidSetupPIN(pin) {
  return Number.isInteger(pin) && pin >= 1 && pin <= MAX_SETUP_PIN &&
    !FORBIDDEN_SETUP_PINS.has(pin);
}

export function validatePair(mt, manualCode) {
  const mtResult = validateMTPayload(mt);
  if (!mtResult.valid) return { valid: false, error: `MT: ${mtResult.error}` };
  const manualResult = validateManualCode(manualCode);
  if (!manualResult.valid) return { valid: false, error: `manual code: ${manualResult.error}` };
  try {
    const qr = decodeMTPayload(mt);
    const manual = decodeManualCode(manualCode);
    if (!isValidSetupPIN(qr.passcode) || !isValidSetupPIN(manual.passcode)) {
      return { valid: false, error: "codes contain a forbidden setup PIN" };
    }
    if ((qr.discriminator >> 8) !== manual.shortDiscriminator) {
      return { valid: false, error: "codes have different discriminators" };
    }
    if (qr.passcode !== manual.passcode) {
      return { valid: false, error: "codes have different passcodes" };
    }
  } catch (error) {
    return { valid: false, error: `payload decode failed: ${error.message}` };
  }
  return { valid: true };
}

export const __internals = { verhoeffCheckDigit, BASE38_ALPHABET, readBits };
