import { validatePair } from "./matter-payload.js";

const FAILURE_MESSAGES = {
  cancel: "Pairing code read canceled. Run Install again to retry.",
  timeout: "The flash finished, but the device did not print both setup codes. Run Install again to reset the device and read its boot log.",
  "parse-failure": "The flash finished, but the device printed invalid or mismatched setup codes. Do not use these codes. Run Install again to retry.",
  "serial-failure": "The flash finished, but the serial read failed. Reconnect the device and run Install again.",
};

export function createSetupFlow({ elements, renderQRCode, eventTarget, scrollPairing, installMode = "factory" }) {
  let currentMT = null;
  let currentManual = null;
  let abortController = null;
  let currentInstallMode = installMode;

  function dispatch(name, detail, target = eventTarget) {
    target?.dispatchEvent(new CustomEvent(name, { detail }));
  }

  function hidePairing() {
    currentMT = null;
    currentManual = null;
    elements.qr.innerHTML = "";
    elements.qrCaption.textContent = "";
    elements.manual.textContent = "—";
    elements.pairing.classList.remove("visible");
    elements.pairing.setAttribute("aria-hidden", "true");
  }

  function begin(mode = installMode) {
    currentInstallMode = mode;
    abortController?.abort();
    abortController = new AbortController();
    hidePairing();
    elements.status.textContent = "Flash complete. Reading Matter setup codes from the device...";
    elements.cancel.hidden = false;
    elements.retry.hidden = true;
    return abortController.signal;
  }

  function showPairing(mt, manualCode, options = {}) {
    hidePairing();
    const validation = validatePair(mt, manualCode);
    if (!validation.valid) return false;
    let svg;
    try {
      svg = renderQRCode(mt, { size: 300 });
    } catch {
      return false;
    }
    currentMT = mt;
    currentManual = manualCode;
    elements.qr.innerHTML = svg;
    elements.qrCaption.textContent = mt;
    elements.manual.textContent = manualCode.replace(/(\d{4})(\d{4})(\d{3})/, "$1-$2-$3");
    elements.pairing.classList.add("visible");
    elements.pairing.setAttribute("aria-hidden", "false");
    elements.status.textContent = options.statusMessage ||
      "Flash complete. The Matter setup codes are ready.";
    scrollPairing?.();
    return true;
  }

  function finish(result) {
    elements.cancel.hidden = true;
    abortController = null;
    if (result?.ok && showPairing(result.mt, result.manualCode)) {
      elements.retry.hidden = true;
      dispatch("install-complete", {
        mt: result.mt,
        manualCode: result.manualCode,
        installMode: currentInstallMode,
      });
      return true;
    }

    hidePairing();
    const kind = result?.ok ? "parse-failure" : (result?.kind || "serial-failure");
    elements.status.textContent = FAILURE_MESSAGES[kind] || FAILURE_MESSAGES["serial-failure"];
    elements.retry.hidden = false;
    dispatch(`install-${kind}`);
    return false;
  }

  function handleInstallResult(mode, result, target) {
    currentInstallMode = mode;
    if (result?.status === "success") return;

    abortController?.abort();
    abortController = null;
    hidePairing();
    elements.cancel.hidden = true;
    elements.retry.hidden = false;
    if (result?.status === "cancelled") {
      elements.status.textContent = "Install canceled. No firmware was written.";
      dispatch("install-cancel", { installMode: mode, reason: result.reason }, target);
      return;
    }

    elements.status.textContent = result?.message
      ? `Install failed: ${result.message}`
      : "Install failed. Reconnect the device and try again.";
    dispatch("install-error", {
      installMode: mode,
      error: result?.error,
      message: result?.message,
    }, target);
  }

  function finishPreservedUpdate(result = {}, target) {
    currentInstallMode = "update";
    abortController?.abort();
    abortController = null;
    hidePairing();
    elements.cancel.hidden = true;
    elements.retry.hidden = true;
    elements.status.textContent =
      "Update complete. Setup data was kept. Wait for the lock to reconnect to Matter and Thread.";
    dispatch("install-update-complete", {
      installMode: "update",
      chipFamily: result.chipFamily,
      version: result.version,
    }, target);
    return true;
  }

  function cancel() {
    abortController?.abort();
  }

  function getCurrent() {
    return { mt: currentMT, manualCode: currentManual, installMode: currentInstallMode };
  }

  hidePairing();
  return {
    begin,
    finish,
    cancel,
    getCurrent,
    showPairing,
    hidePairing,
    handleInstallResult,
    finishPreservedUpdate,
  };
}
