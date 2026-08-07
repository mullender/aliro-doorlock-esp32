import {
  buildGetRequest,
  buildSetRequest,
  compareDevkitVersions,
  parseDevkitVersion,
} from "./device-protocol.js";

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
  manifestUrl = "./manifest-update.json",
  confirmationTimeoutMs = 3000,
}) {
  let currentStatus = null;
  let pendingValues = null;
  let confirmationTimer = null;
  let latestVersion = null;
  let latestLoaded = false;
  let destroyed = false;

  function setResult(message, state = "") {
    elements.result.textContent = message;
    elements.result.className = `settings-result${state ? ` ${state}` : ""}`;
  }

  function clearConfirmationTimer() {
    if (confirmationTimer !== null) clearTimeout(confirmationTimer);
    confirmationTimer = null;
  }

  function setFormBusy(busy) {
    elements.apply.disabled = busy || !currentStatus;
    elements.form.setAttribute?.("aria-busy", String(busy));
  }

  function renderFirmware() {
    const installed = currentStatus?.firmware || null;
    elements.installed.textContent = installed || "Unknown";
    elements.latest.textContent = latestLoaded ? (latestVersion || "Unknown") : "Checking…";
    elements.updateAction.hidden = false;
    elements.current.hidden = true;

    if (!installed) {
      if (!latestLoaded) {
        elements.updateReason.textContent =
          "Connect the lock while the page checks the latest release.";
      } else if (latestVersion) {
        elements.updateReason.textContent =
          "Connect the lock to compare its installed firmware with the latest release.";
      } else {
        elements.updateReason.textContent =
          "The latest release is unknown. The firmware update remains available.";
      }
      return;
    }
    const comparison = compareDevkitVersions(installed, latestVersion);
    if (comparison === 0) {
      elements.current.textContent = "✓ Firmware is current";
      elements.current.hidden = false;
      elements.updateAction.hidden = true;
      elements.updateReason.textContent = "The installed firmware matches the latest release.";
    } else if (comparison === 1) {
      elements.current.textContent = "✓ Firmware is newer than the latest release";
      elements.current.hidden = false;
      elements.updateAction.hidden = true;
      elements.updateReason.textContent =
        "The installed firmware is newer than the published release. A normal update would go back to an older version.";
    } else if (comparison === -1) {
      elements.updateReason.textContent =
        `Firmware ${installed} is installed. Firmware ${latestVersion} is available.`;
    } else {
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
    setFormBusy(false);
    setResult("");
    renderFirmware();
  }

  function onAutoLockChange() {
    elements.delay.disabled = !elements.autoLock.checked;
  }

  async function onSubmit(event) {
    event.preventDefault();
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

  async function loadLatestVersion() {
    if (typeof fetchImpl !== "function") {
      latestLoaded = true;
      renderFirmware();
      return;
    }
    try {
      const response = await fetchImpl(manifestUrl, { cache: "no-store" });
      if (response.ok === false) throw new Error(`HTTP ${response.status}`);
      const manifest = await response.json();
      latestVersion = parseDevkitVersion(manifest.version)?.normalized || null;
    } catch {
      latestVersion = null;
    }
    latestLoaded = true;
    if (!destroyed) renderFirmware();
  }

  elements.form.addEventListener("submit", onSubmit);
  elements.autoLock.addEventListener("change", onAutoLockChange);
  serialMonitor.addEventListener("aliro-status", onStatus);
  serialMonitor.addEventListener("aliro-error", onError);
  serialMonitor.addEventListener("serial-connected", onConnected);
  serialMonitor.addEventListener("serial-disconnected", onDisconnected);
  setFormBusy(false);
  renderFirmware();
  void loadLatestVersion();

  return {
    loadLatestVersion,
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
