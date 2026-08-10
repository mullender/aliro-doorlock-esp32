// Installer matrix safety model.
//
// This module holds the exact set of shipped variants and two small
// helpers the installer UI uses to decide what is safe to write to a
// connected device. It does not touch the DOM and does not enable any
// button on its own. The install-controller pulls the helpers to
// gate its factory buttons and the update button.

import { parseDevkitVersion } from "./device-protocol.js";

// The variant map is a null-prototype object so lookups only see keys
// that were explicitly added. Inherited object properties such as
// `constructor`, `toString`, and `__proto__` therefore appear as
// undefined and never leak into a factory selection or update guard.
const VARIANTS = Object.freeze(Object.assign(Object.create(null), {
  "nanoc6-thread": Object.freeze({
    id: "nanoc6-thread",
    transport: "thread",
    boardLabel: "M5Stack NanoC6",
    manifestFactory: "manifest-nanoc6-thread.json",
    manifestUpdate: "manifest-update-nanoc6-thread.json",
  }),
  "nanoc6-wifi": Object.freeze({
    id: "nanoc6-wifi",
    transport: "wifi",
    boardLabel: "M5Stack NanoC6",
    manifestFactory: "manifest-nanoc6-wifi.json",
    manifestUpdate: "manifest-update-nanoc6-wifi.json",
  }),
  "atoms3-lite-wifi": Object.freeze({
    id: "atoms3-lite-wifi",
    transport: "wifi",
    boardLabel: "M5Stack AtomS3 Lite",
    manifestFactory: "manifest-atoms3-lite-wifi.json",
    manifestUpdate: "manifest-update-atoms3-lite-wifi.json",
  }),
}));

const SUPPORTED_VARIANT_IDS = Object.freeze(Object.keys(VARIANTS));

// Reason strings are stable so the UI can key on them and so tests
// can assert the exact refusal path without matching prose. The
// human-readable message stays in `note` for display.
const REASON = Object.freeze({
  MALFORMED_STATUS: "malformed-status",
  NO_VARIANT_REPORTED: "no-variant-reported",
  NO_TRANSPORT_REPORTED: "no-transport-reported",
  UNKNOWN_VARIANT: "unknown-variant",
  TRANSPORT_MISMATCH: "transport-mismatch",
});

// Match parseAliroProtocolLine's identifier rule. Duplicated (not
// imported) so a caller cannot supply a status object that satisfies
// the guard through a different pattern than the parser used.
const IDENTIFIER_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RGB_PATTERN = /^#[0-9a-f]{6}$/;
const SETTING_INT_LIMITS = Object.freeze(Object.assign(Object.create(null), {
  auto_relock_seconds: [0, 3600],
  success_ms: [0, 10000],
  failure_ms: [0, 10000],
  other_ms: [0, 10000],
}));
const SETTING_RGB_KEYS = Object.freeze(["success_rgb", "failure_rgb", "other_rgb"]);

// Own-property-only lookup. Guards against inherited keys like
// constructor / toString / __proto__ leaking a VARIANTS value.
function lookupVariant(variantId) {
  if (typeof variantId !== "string") return undefined;
  return Object.hasOwn(VARIANTS, variantId) ? VARIANTS[variantId] : undefined;
}

// Complete validated-STATUS shape check. Rejects any object that
// parseAliroProtocolLine would not have produced, so the preserving-
// update guard never sees a partially-formed status.
function isValidatedStatus(status) {
  if (!status || typeof status !== "object") return false;
  if (typeof status.firmware !== "string") return false;
  if (!parseDevkitVersion(status.firmware)) return false;
  if (status.protocol !== 1) return false;
  if (typeof status.variant !== "string" || !IDENTIFIER_PATTERN.test(status.variant)) {
    return false;
  }
  if (typeof status.transport !== "string" || !IDENTIFIER_PATTERN.test(status.transport)) {
    return false;
  }
  if (typeof status.variantExplicit !== "boolean") return false;
  if (typeof status.transportExplicit !== "boolean") return false;
  for (const key of Object.keys(SETTING_INT_LIMITS)) {
    const value = status[key];
    const [min, max] = SETTING_INT_LIMITS[key];
    if (!Number.isInteger(value) || value < min || value > max) return false;
  }
  for (const key of SETTING_RGB_KEYS) {
    const value = status[key];
    if (typeof value !== "string" || !RGB_PATTERN.test(value)) return false;
  }
  return true;
}

export function getSupportedVariantIds() {
  return SUPPORTED_VARIANT_IDS.slice();
}

export function getVariant(variantId) {
  return lookupVariant(variantId) || null;
}

// Factory selection always resolves. The caller must show the note
// about erase and recommission before it enables the button so the
// user sees that a board or transport change is destructive.
export function selectFactoryVariant(variantId) {
  const variant = lookupVariant(variantId);
  if (!variant) {
    throw new Error(`unknown variant '${variantId}'`);
  }
  return Object.freeze({
    variant,
    manifest: variant.manifestFactory,
    mustEraseAndRecommission: true,
    note:
      "Factory install erases the whole flash. Changing the board or the Matter transport removes the current pairing; " +
      "you must add the device to your smart home again after the install.",
  });
}

// A preserving update is only safe when the connected device has
// explicitly reported both a supported variant and its matching
// transport, AND the status object is the complete validated shape
// that parseAliroProtocolLine produces. Anything less returns
// { allowed: false } with a machine-checkable reason and a short
// human-readable note.
export function checkPreservingUpdate(status) {
  if (!isValidatedStatus(status)) {
    return Object.freeze({
      allowed: false,
      reason: REASON.MALFORMED_STATUS,
      note:
        "The device did not return a valid status line, or the status is missing required fields. " +
        "A preserving update needs the complete validated STATUS shape.",
    });
  }
  if (status.variantExplicit !== true) {
    return Object.freeze({
      allowed: false,
      reason: REASON.NO_VARIANT_REPORTED,
      note:
        "The connected firmware does not report its variant. A preserving update needs proof that the running build " +
        "matches this release; use Factory install instead.",
    });
  }
  if (status.transportExplicit !== true) {
    return Object.freeze({
      allowed: false,
      reason: REASON.NO_TRANSPORT_REPORTED,
      note:
        "The connected firmware does not report its Matter transport. A preserving update needs proof that the running " +
        "transport matches this release; use Factory install instead.",
    });
  }
  const variant = lookupVariant(status.variant);
  if (!variant) {
    return Object.freeze({
      allowed: false,
      reason: REASON.UNKNOWN_VARIANT,
      note:
        `The device reports variant '${status.variant}', which this installer does not support. ` +
        "Use Factory install for a supported variant to switch.",
    });
  }
  if (status.transport !== variant.transport) {
    return Object.freeze({
      allowed: false,
      reason: REASON.TRANSPORT_MISMATCH,
      note:
        `The device reports transport '${status.transport}' for variant '${variant.id}', which requires transport ` +
        `'${variant.transport}'. Use Factory install to correct the transport.`,
    });
  }
  return Object.freeze({
    allowed: true,
    targetVariant: variant.id,
    manifest: variant.manifestUpdate,
    note:
      "The device reports a supported variant and its matching transport; a preserving update keeps the pairing.",
  });
}

export const __internals = Object.freeze({
  VARIANTS,
  REASON,
});
