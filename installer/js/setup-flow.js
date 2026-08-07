import { validatePair } from "./matter-payload.js";

const FAILURE_MESSAGES = {
  cancel: "Pairing code read canceled. Run Install again to retry.",
  timeout: "The flash finished, but the device did not print both setup codes. Run Install again to reset the device and read its boot log.",
  "parse-failure": "The flash finished, but the device printed invalid or mismatched setup codes. Do not use these codes. Run Install again to retry.",
  "serial-failure": "The flash finished, but the serial read failed. Reconnect the device and run Install again.",
};

const SERVICE_BY_VENDOR = new Map([
  [0x1349, { key: "apple", name: "Apple Home" }],
  [0x1384, { key: "apple", name: "Apple Keychain" }],
  [0x6006, { key: "google", name: "Google LLC" }],
  [0x134B, { key: "home-assistant", name: "Home Assistant (Open Home Foundation)" }],
]);

function serviceForVendor(vendorId) {
  if (!/^0x[0-9a-f]+$/i.test(String(vendorId))) return null;
  return SERVICE_BY_VENDOR.get(Number.parseInt(vendorId, 16)) || null;
}

function uniqueValues(values) {
  return [...new Set(values)];
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderCommissionedGuidance(fabrics) {
  const services = fabrics.map((fabric) => ({
    fabric,
    service: serviceForVendor(fabric.vendorId),
  }));
  const blocks = [];
  const appleNames = uniqueValues(services
    .filter(({ service }) => service?.key === "apple")
    .map(({ service }) => service.name));

  if (appleNames.length) {
    blocks.push(`<section class="service-guidance"><h3>${appleNames.join(" and ")}</h3>
      <ol>
        <li>Open the lock in the <strong>Home</strong> app.</li>
        <li>Open its settings and select <strong>Turn On Pairing Mode</strong>.</li>
        <li>Copy the new pairing code. Enter it in the app that you want to add.</li>
      </ol></section>`);
  }
  if (services.some(({ service }) => service?.key === "google")) {
    blocks.push(`<section class="service-guidance"><h3>Google LLC</h3>
      <ol>
        <li>Open the lock in the <strong>Google Home</strong> app.</li>
        <li>Open <strong>Settings</strong>, then <strong>Linked Matter apps and services</strong>.</li>
        <li>Select <strong>Link apps and services</strong>, then follow the app.</li>
      </ol></section>`);
  }
  if (services.some(({ service }) => service?.key === "home-assistant")) {
    blocks.push(`<section class="service-guidance"><h3>Home Assistant (Open Home Foundation)</h3>
      <ol>
        <li>Open the Home Assistant Companion app.</li>
        <li>Go to <strong>Settings &gt; Matter &gt; Add device</strong>.</li>
        <li>Select <strong>Yes, it is already in use</strong>, then follow the app.</li>
      </ol></section>`);
  }

  const unknownVendors = uniqueValues(services
    .filter(({ service }) => !service)
    .map(({ fabric }) => fabric.vendorId));
  if (unknownVendors.length || !fabrics.length) {
    const vendorText = unknownVendors.length
      ? `<p>Other Matter service vendor IDs: <code>${unknownVendors.map(escapeHtml).join("</code>, <code>")}</code>.</p>`
      : "";
    blocks.push(`<section class="service-guidance"><h3>Other Matter service</h3>
      ${vendorText}
      <p>Open the app that added this device. Use its option to share or add an
        already commissioned Matter device, then follow the app.</p></section>`);
  }
  return blocks.join("");
}

function renderFabricDetails(fabrics) {
  return fabrics.map((fabric, index) => `<section class="fabric-record">
    <h3>Fabric ${index + 1}</h3>
    <dl class="fabric-details">
      <dt>Fabric index</dt><dd><code>${escapeHtml(fabric.fabricIndex)}</code></dd>
      <dt>Fabric ID</dt><dd><code>${escapeHtml(fabric.fabricId)}</code></dd>
      <dt>Node ID</dt><dd><code>${escapeHtml(fabric.nodeId)}</code></dd>
      <dt>Vendor ID</dt><dd><code>${escapeHtml(fabric.vendorId)}</code></dd>
    </dl>
  </section>`).join("");
}

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
    elements.pairingCodes.hidden = false;
    elements.commissioned.hidden = true;
    elements.fabricDetails.hidden = true;
    elements.commissionedGuidance.innerHTML = "";
    elements.fabricList.innerHTML = "";
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

  function showCommissioned(fabricOrFabrics = null, options = {}) {
    hidePairing();
    const fabrics = Array.isArray(fabricOrFabrics)
      ? fabricOrFabrics
      : (fabricOrFabrics ? [fabricOrFabrics] : []);
    elements.pairingCodes.hidden = true;
    elements.commissioned.hidden = false;
    elements.commissionedGuidance.innerHTML = renderCommissionedGuidance(fabrics);
    if (fabrics.length) {
      elements.fabricDetails.hidden = false;
      elements.fabricList.innerHTML = renderFabricDetails(fabrics);
    }
    elements.pairing.classList.add("visible");
    elements.pairing.setAttribute("aria-hidden", "false");
    elements.status.textContent = options.statusMessage ||
      "This device is already commissioned.";
    scrollPairing?.();
    return true;
  }

  function finish(result) {
    elements.cancel.hidden = true;
    abortController = null;
    if (result?.ok && result.kind === "commissioned") {
      elements.retry.hidden = true;
      showCommissioned(result.fabrics?.length ? result.fabrics : result.fabric);
      dispatch("install-commissioned", { installMode: currentInstallMode });
      return true;
    }
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
    showCommissioned,
    hidePairing,
    handleInstallResult,
    finishPreservedUpdate,
  };
}
