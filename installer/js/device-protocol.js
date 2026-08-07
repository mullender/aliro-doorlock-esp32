const PROTOCOL_PREFIX = "ALIRO/1";
const MAX_AUTO_RELOCK_SECONDS = 3600;
const MAX_LED_DURATION_MS = 10000;

const SETTING_KEYS = [
  "auto_relock_seconds",
  "success_rgb",
  "success_ms",
  "failure_rgb",
  "failure_ms",
  "other_rgb",
  "other_ms",
];

function parseInteger(value, name, maximum) {
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a whole number.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximum) {
    throw new Error(`${name} must be from 0 to ${maximum}.`);
  }
  return parsed;
}

function normalizeRgb(value, name) {
  const text = String(value).replace(/^#/, "");
  if (!/^[0-9a-f]{6}$/i.test(text)) {
    throw new Error(`${name} must be a six-digit RGB color.`);
  }
  return `#${text.toLowerCase()}`;
}

function parseFields(text) {
  const fields = {};
  const clean = text.trim();
  if (!clean) return fields;
  for (const part of clean.split(/\s+/)) {
    const match = /^([a-z_]+)=([^\s=]+)$/.exec(part);
    if (!match) throw new Error("The protocol line has an invalid field.");
    const [, key, value] = match;
    if (Object.hasOwn(fields, key)) throw new Error(`The ${key} field is repeated.`);
    fields[key] = value;
  }
  return fields;
}

function validateStatus(fields) {
  const required = ["firmware", "protocol", ...SETTING_KEYS];
  for (const key of required) {
    if (!Object.hasOwn(fields, key)) throw new Error(`The ${key} field is missing.`);
  }
  if (fields.protocol !== "1") throw new Error("The device protocol is not supported.");
  if (!parseDevkitVersion(fields.firmware)) {
    throw new Error("The firmware version is not a semantic devkit version.");
  }
  return {
    firmware: fields.firmware,
    protocol: 1,
    auto_relock_seconds: parseInteger(
      fields.auto_relock_seconds,
      "auto_relock_seconds",
      MAX_AUTO_RELOCK_SECONDS,
    ),
    success_rgb: normalizeRgb(fields.success_rgb, "success_rgb"),
    success_ms: parseInteger(fields.success_ms, "success_ms", MAX_LED_DURATION_MS),
    failure_rgb: normalizeRgb(fields.failure_rgb, "failure_rgb"),
    failure_ms: parseInteger(fields.failure_ms, "failure_ms", MAX_LED_DURATION_MS),
    other_rgb: normalizeRgb(fields.other_rgb, "other_rgb"),
    other_ms: parseInteger(fields.other_ms, "other_ms", MAX_LED_DURATION_MS),
  };
}

export function parseAliroProtocolLine(line) {
  if (typeof line !== "string" || !line.startsWith(`${PROTOCOL_PREFIX} `)) return null;
  if (line.startsWith(`${PROTOCOL_PREFIX} STATUS`)) {
    if (!line.startsWith(`${PROTOCOL_PREFIX} STATUS `)) {
      return { type: "invalid-status", error: "The status has no fields." };
    }
    try {
      return {
        type: "status",
        status: validateStatus(parseFields(line.slice(`${PROTOCOL_PREFIX} STATUS `.length))),
      };
    } catch (error) {
      return { type: "invalid-status", error: error.message };
    }
  }
  if (line.startsWith(`${PROTOCOL_PREFIX} ERROR`)) {
    const match = new RegExp(`^${PROTOCOL_PREFIX} ERROR code=([^\\s=]+)$`).exec(line);
    if (!match) return { type: "invalid-error", error: "The error line is invalid." };
    return { type: "error", code: match[1] };
  }
  return null;
}

export function buildGetRequest() {
  return `${PROTOCOL_PREFIX} GET`;
}

export function buildSetRequest(values) {
  if (!values || typeof values !== "object") throw new Error("Settings are required.");
  const fields = [];
  for (const key of Object.keys(values)) {
    if (!SETTING_KEYS.includes(key)) throw new Error(`The ${key} setting is not supported.`);
  }
  for (const key of SETTING_KEYS) {
    if (!Object.hasOwn(values, key)) continue;
    let value;
    if (key.endsWith("_rgb")) {
      value = normalizeRgb(values[key], key).slice(1);
    } else {
      const maximum = key === "auto_relock_seconds"
        ? MAX_AUTO_RELOCK_SECONDS
        : MAX_LED_DURATION_MS;
      value = parseInteger(String(values[key]), key, maximum);
    }
    fields.push(`${key}=${value}`);
  }
  if (!fields.length) throw new Error("At least one setting must change.");
  return `${PROTOCOL_PREFIX} SET ${fields.join(" ")}`;
}

export function parseDevkitVersion(value) {
  if (typeof value !== "string") return null;
  const match = /^(?:aliro-c6-)?v?(\d+)\.(\d+)\.(\d+)-devkit$/.exec(value.trim());
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part))) return null;
  return { parts, normalized: `${parts.join(".")}-devkit` };
}

export function compareDevkitVersions(installed, latest) {
  const left = parseDevkitVersion(installed);
  const right = parseDevkitVersion(latest);
  if (!left || !right) return null;
  for (let index = 0; index < left.parts.length; index += 1) {
    if (left.parts[index] < right.parts[index]) return -1;
    if (left.parts[index] > right.parts[index]) return 1;
  }
  return 0;
}

export const __internals = {
  MAX_AUTO_RELOCK_SECONDS,
  MAX_LED_DURATION_MS,
  SETTING_KEYS,
};
