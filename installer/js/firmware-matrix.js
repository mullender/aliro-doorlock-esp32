// Installer matrix safety model.
//
// This module holds the exact set of shipped variants and two small
// helpers the installer UI uses to decide what is safe to write to a
// connected device. It does not touch the DOM and does not enable any
// button on its own. The install-controller pulls the helpers to
// gate its factory buttons and the update button.

const VARIANTS = Object.freeze({
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
});

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

export function getSupportedVariantIds() {
  return SUPPORTED_VARIANT_IDS.slice();
}

export function getVariant(variantId) {
  return VARIANTS[variantId] || null;
}

// Factory selection always resolves. The caller must show the note
// about erase and recommission before it enables the button so the
// user sees that a board or transport change is destructive.
export function selectFactoryVariant(variantId) {
  const variant = VARIANTS[variantId];
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
// transport. Legacy defaults, unknown variants, and any mismatch
// return `{ allowed: false }` with a machine-checkable reason and a
// short human-readable note.
export function checkPreservingUpdate(status) {
  if (!status || typeof status !== "object") {
    return Object.freeze({
      allowed: false,
      reason: REASON.MALFORMED_STATUS,
      note: "The device did not return a valid status line.",
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
  const variant = VARIANTS[status.variant];
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
