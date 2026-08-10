import {
  buildGetRequest,
  buildSetRequest,
  compareDevkitVersions,
  parseDevkitVersion,
} from "./device-protocol.js";
import { checkPreservingUpdate, getVariant } from "./firmware-matrix.js";

const SETTING_KEYS = [
  "auto_relock_seconds",
  "success_rgb",
  "success_ms",
  "failure_rgb",
  "failure_ms",
  "other_rgb",
  "other_ms",
];

function sameValue(left, right) {
  if (typeof left === "string" || typeof right === "string") {
    return String(left).toLowerCase() === String(right).toLowerCase();
  }
  return left === right;
}

export function createDeviceSettings({
  elements,
  serialMonitor,
  fetchImpl = globalThis.fetch,
  confirmationTimeoutMs = 3000,
}) {
  let currentStatus = null;
  let pendingValues = null;
  let confirmationTimer = null;
  let eligibleVariant = null;
  let latestVersion = null;
  let latestLoaded = false;
  let latestManifest = null;
  let destroyed = false;
  let readOnly = false;

  function setResult(message, state = "") {
    elements.result.textContent = message;
    elements.result.className = `settings-result${state ? ` ${state}` : ""}`;
  }

  function clearConfirmationTimer() {
    if (confirmationTimer !== null) clearTimeout(confirmationTimer);
    confirmationTimer = null;
  }

  function setFormBusy(busy) {
    elements.apply.disabled = busy || !currentStatus || readOnly;
    elements.form.setAttribute?.("aria-busy", String(busy));
  }

  function renderFirmware() {
    const installed = currentStatus?.firmware || null;
    elements.installed.textContent = installed || "Unknown";
    elements.current.hidden = true;
    elements.updateAction.hidden = true;

    if (!installed) {
      elements.latest.textContent = "Unknown";
      elements.updateReason.textContent =
        "Connect the lock to see whether a preserving update is available.";
      return;
    }
    if (!eligibleVariant) {
      elements.latest.textContent = "Unknown";
      elements.updateReason.textContent =
        "The connected lock's firmware cannot be updated in-place from this page. " +
        "Use Factory install below to change the board or the Matter transport.";
      return;
    }
    if (!latestLoaded) {
      elements.latest.textContent = "Checking…";
      elements.updateReason.textContent =
        "Checking the latest release for this variant.";
      return;
    }
    elements.latest.textContent = latestVersion || "Unknown";
    const comparison = compareDevkitVersions(installed, latestVersion);
    if (comparison === 0) {
      elements.current.textContent = "✓ Firmware is current";
      elements.current.hidden = false;
      elements.updateReason.textContent = "The installed firmware matches the latest release.";
    } else if (comparison === 1) {
      elements.current.textContent = "✓ Firmware is newer than the latest release";
      elements.current.hidden = false;
      elements.updateReason.textContent =
        "The installed firmware is newer than the published release. A normal update would go back to an older version.";
    } else if (comparison === -1) {
      elements.updateAction.hidden = false;
      elements.updateReason.textContent =
        `Firmware ${installed} is installed. Firmware ${latestVersion} is available.`;
    } else {
      elements.updateAction.hidden = false;
      elements.updateReason.textContent =
        "The installed and latest versions could not be compared. The firmware update remains available.";
    }
  }

  function populate(status) {
    elements.autoLock.checked = status.auto_relock_seconds > 0;
    elements.delay.value = String(status.auto_relock_seconds || 5);
    elements.delay.disabled = !elements.autoLock.checked;
    elements.successRgb.value = status.success_rgb;
    elements.successMs.value = String(status.success_ms);
    elements.failureRgb.value = status.failure_rgb;
    elements.failureMs.value = String(status.failure_ms);
    elements.otherRgb.value = status.other_rgb;
    elements.otherMs.value = String(status.other_ms);
  }

  function formValues() {
    const integerValue = (element, name) => {
      if (!/^\d+$/.test(element.value)) throw new Error(`${name} must be a whole number.`);
      return Number(element.value);
    };
    const values = {
      auto_relock_seconds: elements.autoLock.checked
        ? integerValue(elements.delay, "Auto-lock delay")
        : 0,
      success_rgb: elements.successRgb.value,
      success_ms: integerValue(elements.successMs, "Success duration"),
      failure_rgb: elements.failureRgb.value,
      failure_ms: integerValue(elements.failureMs, "Failure duration"),
      other_rgb: elements.otherRgb.value,
      other_ms: integerValue(elements.otherMs, "Other tag duration"),
    };
    buildSetRequest(values);
    return values;
  }

  function changedValues(values) {
    return Object.fromEntries(SETTING_KEYS
      .filter((key) => !sameValue(values[key], currentStatus[key]))
      .map((key) => [key, values[key]]));
  }

  function evaluateEligibility(status) {
    const decision = checkPreservingUpdate(status);
    if (decision.allowed) {
      const variant = getVariant(decision.targetVariant);
      const nextManifest = variant?.manifestUpdate || decision.manifest;
      if (variant && nextManifest !== latestManifest) {
        eligibleVariant = variant;
        latestManifest = nextManifest;
        latestVersion = null;
        latestLoaded = false;
        void loadLatestVersion(nextManifest);
      } else if (variant) {
        eligibleVariant = variant;
      }
    } else {
      eligibleVariant = null;
      latestManifest = null;
      latestVersion = null;
      latestLoaded = true;
    }
  }

  function onStatus(event) {
    if (destroyed) return;
    const status = event.detail;
    currentStatus = status;
    elements.panel.hidden = false;
    setFormBusy(false);

    if (pendingValues) {
      clearConfirmationTimer();
      const saved = Object.entries(pendingValues)
        .every(([key, value]) => sameValue(status[key], value));
      setResult(
        saved ? "Settings saved." : "The device returned different settings. Review the values and try again.",
        saved ? "success" : "error",
      );
      pendingValues = null;
    }
    populate(status);
    evaluateEligibility(status);
    renderFirmware();
  }

  function onError(event) {
    if (!pendingValues) return;
    clearConfirmationTimer();
    pendingValues = null;
    setFormBusy(false);
    setResult(`Settings were not saved: ${event.detail.code}.`, "error");
  }

  function onConnected() {
    if (readOnly) {
      readOnly = false;
      setResult("");
      setFormBusy(false);
    }
    if (!currentStatus) {
      elements.panel.hidden = true;
      pendingValues = null;
      setResult("");
    }
    renderFirmware();
    void serialMonitor.writeLine(buildGetRequest()).catch(() => {
      // Some serial adapters cannot write. A boot STATUS line can still show the settings.
    });
  }

  function onDisconnected() {
    clearConfirmationTimer();
    elements.panel.hidden = true;
    currentStatus = null;
    pendingValues = null;
    eligibleVariant = null;
    latestManifest = null;
    latestVersion = null;
    latestLoaded = false;
    setFormBusy(false);
    setResult("");
    renderFirmware();
  }

  function onAutoLockChange() {
    elements.delay.disabled = !elements.autoLock.checked;
  }

  async function onSubmit(event) {
    event.preventDefault();
    if (readOnly) {
      setResult(
        "These values were read from the flash callback. Use Connect device above to take ownership before you save settings.",
        "error",
      );
      return;
    }
    if (!currentStatus) {
      setResult("Connect the device and wait for its status before you save settings.", "error");
      return;
    }
    try {
      const changes = changedValues(formValues());
      if (!Object.keys(changes).length) {
        setResult("No settings changed.");
        return;
      }
      const request = buildSetRequest(changes);
      setFormBusy(true);
      setResult("Sending settings…");
      pendingValues = changes;
      await serialMonitor.writeLine(request);
      if (pendingValues) {
        setResult("Settings sent. Waiting for the device to confirm them.");
        clearConfirmationTimer();
        confirmationTimer = setTimeout(() => {
          confirmationTimer = null;
          if (!pendingValues || destroyed) return;
          pendingValues = null;
          setFormBusy(false);
          setResult("The device did not confirm the settings. Review the connection and try again.", "error");
        }, confirmationTimeoutMs);
      }
    } catch (error) {
      clearConfirmationTimer();
      pendingValues = null;
      setFormBusy(false);
      setResult(`Settings were not sent: ${error.message}`, "error");
    }
  }

  async function loadLatestVersion(manifestPath) {
    if (!manifestPath) return;
    if (typeof fetchImpl !== "function") {
      if (manifestPath !== latestManifest) return;
      latestLoaded = true;
      if (!destroyed) renderFirmware();
      return;
    }
    let version = null;
    try {
      const response = await fetchImpl(manifestPath, { cache: "no-store" });
      if (response.ok === false) throw new Error(`HTTP ${response.status}`);
      const manifest = await response.json();
      version = parseDevkitVersion(manifest.version)?.normalized || null;
    } catch {
      version = null;
    }
    if (destroyed) return;
    if (manifestPath !== latestManifest) return;
    latestVersion = version;
    latestLoaded = true;
    renderFirmware();
  }

  elements.form.addEventListener("submit", onSubmit);
  elements.autoLock.addEventListener("change", onAutoLockChange);
  serialMonitor.addEventListener("aliro-status", onStatus);
  serialMonitor.addEventListener("aliro-error", onError);
  serialMonitor.addEventListener("serial-connected", onConnected);
  serialMonitor.addEventListener("serial-disconnected", onDisconnected);
  setFormBusy(false);
  renderFirmware();

  return {
    applyStatus(status) {
      if (destroyed || !status) return;
      readOnly = true;
      onStatus({ detail: status });
      setResult(
        "Values read from the flash callback. Use Connect device above to save changes.",
      );
      setFormBusy(false);
    },
    destroy() {
      destroyed = true;
      clearConfirmationTimer();
      elements.form.removeEventListener("submit", onSubmit);
      elements.autoLock.removeEventListener("change", onAutoLockChange);
      serialMonitor.removeEventListener("aliro-status", onStatus);
      serialMonitor.removeEventListener("aliro-error", onError);
      serialMonitor.removeEventListener("serial-connected", onConnected);
      serialMonitor.removeEventListener("serial-disconnected", onDisconnected);
    },
  };
}
