import { parseMatterOnboardingCodes } from "./boot-parser.js";
import {
  buildGetRequest,
  parseAliroProtocolLine,
} from "./device-protocol.js";
import {
  checkPreservingUpdate,
  selectFactoryVariant,
} from "./firmware-matrix.js";
import { attachUpdateDialogGuard } from "./update-dialog-guard.js";

const RE_ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const STATUS_TIMEOUT_MS = 3000;
const DEFAULT_FACTORY_VARIANT = "nanoc6-thread";

function prepareButton(button) {
  const activator = button.querySelector?.('[slot="activate"]');
  if (!activator) throw new Error("Install button has no activation control.");
  return activator;
}

function enableButton(button, activator) {
  activator.disabled = false;
  button.inert = false;
  button.removeAttribute("inert");
}

function disableButton(button, activator) {
  activator.disabled = true;
  button.inert = true;
  button.setAttribute?.("inert", "");
}

function setButtonManifest(button, manifestPath) {
  button.manifest = manifestPath;
  button.setAttribute?.("manifest", manifestPath);
}

function clearButtonManifest(button) {
  button.manifest = null;
  button.removeAttribute?.("manifest");
}

function guardInstallClick(activator, serialMonitor) {
  if (!serialMonitor) return;
  let releasing = false;
  activator.addEventListener("click", (event) => {
    if (!serialMonitor.isActive()) return;
    event.preventDefault();
    event.stopPropagation();
    if (releasing) return;
    releasing = true;
    activator.disabled = true;
    void serialMonitor.releaseForInstall().catch(() => false).finally(() => {
      releasing = false;
      activator.disabled = false;
    });
  }, { capture: true });
}

// PR 733 adds an optional `onPostFlash` field to esp-web-tools' InstallButton.
// It has no runtime marker to feature-detect: the TypeScript declaration
// compiles to no runtime footprint at es2019. Assign the property directly.
// Older or unpatched builds ignore the assignment; the serial-monitor
// reconnect path at the top of the page then re-parses codes AND settings
// from the live boot log, populating the same UI.

async function captureDeviceStatus(port, logger, timeoutMs = STATUS_TIMEOUT_MS) {
  if (!port?.writable || port.writable.locked) return null;
  if (!port?.readable || port.readable.locked) return null;

  const writer = port.writable.getWriter();
  try {
    await writer.write(new TextEncoder().encode(`${buildGetRequest()}\n`));
  } catch (error) {
    logger.error("[install-controller] ALIRO/1 GET write failed.", error);
    try { writer.releaseLock(); } catch { /* Already free. */ }
    return null;
  }
  try { writer.releaseLock(); } catch { /* Already free. */ }

  const reader = port.readable.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const remaining = Math.max(0, deadline - Date.now());
      let timer = null;
      const readPromise = reader.read().then(
        (value) => ({ type: "read", value }),
        (error) => ({ type: "error", error }),
      );
      const outcome = await Promise.race([
        readPromise,
        new Promise((resolve) => {
          timer = setTimeout(() => resolve({ type: "timeout" }), remaining);
        }),
      ]);
      if (timer) clearTimeout(timer);
      if (outcome.type === "timeout") return null;
      if (outcome.type === "error") {
        logger.error("[install-controller] ALIRO/1 STATUS read failed.", outcome.error);
        return null;
      }
      if (outcome.value.done) return null;
      buffer += decoder.decode(outcome.value.value, { stream: true }).replace(RE_ANSI, "");
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        const parsed = parseAliroProtocolLine(line);
        if (parsed?.type === "status") return parsed.status;
      }
    }
    return null;
  } finally {
    try { reader.releaseLock(); } catch { /* Pending read has already rejected. */ }
  }
}

export function configureInstallButtons({
  factoryButton,
  updateButton,
  setupFlow,
  factoryVariantSelector,
  factoryWarning,
  parseCodes = parseMatterOnboardingCodes,
  logger = console,
  serialMonitor,
  deviceSettings,
  statusTimeoutMs = STATUS_TIMEOUT_MS,
  attachDialogGuard = attachUpdateDialogGuard,
  defaultFactoryVariant = DEFAULT_FACTORY_VARIANT,
}) {
  const factoryActivator = prepareButton(factoryButton);
  const updateActivator = prepareButton(updateButton);

  // Factory selection. Always resolves through selectFactoryVariant so an
  // unknown or missing selector value throws before the button becomes
  // active. On every change the button's manifest and the visible
  // erase-and-recommission warning move together.
  function applyFactorySelection(variantId) {
    const pick = selectFactoryVariant(variantId);
    setButtonManifest(factoryButton, pick.manifest);
    if (factoryWarning) {
      factoryWarning.textContent = pick.note;
      factoryWarning.hidden = false;
    }
  }

  const initialFactoryId =
    factoryVariantSelector?.value || defaultFactoryVariant;
  applyFactorySelection(initialFactoryId);
  factoryVariantSelector?.addEventListener?.("change", () => {
    applyFactorySelection(factoryVariantSelector.value);
  });

  // Update button. Starts inert with no manifest. checkPreservingUpdate is
  // the only path that ever sets a manifest and enables the activator.
  // Every deny path clears both, so a stale manifest cannot survive a
  // disconnect or a device swap.
  let updateGuardHandle = null;
  let currentUpdateManifest = null;

  function detachUpdateGuard() {
    if (updateGuardHandle) {
      updateGuardHandle.disconnect?.();
      updateGuardHandle = null;
    }
  }

  function disableUpdateTarget() {
    detachUpdateGuard();
    if (currentUpdateManifest !== null) {
      clearButtonManifest(updateButton);
      currentUpdateManifest = null;
    }
    disableButton(updateButton, updateActivator);
  }

  function enableUpdateTarget(manifestPath) {
    if (manifestPath !== currentUpdateManifest) {
      detachUpdateGuard();
      setButtonManifest(updateButton, manifestPath);
      currentUpdateManifest = manifestPath;
      if (attachDialogGuard) {
        updateGuardHandle = attachDialogGuard({ updateManifestPath: manifestPath });
      }
    }
    enableButton(updateButton, updateActivator);
  }

  function evaluateStatusForUpdate(status) {
    const decision = checkPreservingUpdate(status);
    if (decision.allowed) enableUpdateTarget(decision.manifest);
    else disableUpdateTarget();
    return decision;
  }

  // Start disabled so the button is safe even before any STATUS arrives.
  disableUpdateTarget();

  serialMonitor?.addEventListener?.("aliro-status", (event) => {
    evaluateStatusForUpdate(event.detail);
  });
  serialMonitor?.addEventListener?.("serial-disconnected", () => {
    disableUpdateTarget();
  });

  async function runFactoryCallback(port) {
    const signal = setupFlow.begin("factory");
    try {
      const codes = await parseCodes(port, {
        timeoutMs: 15000,
        signal,
        requestReemit: false,
        logger: (message, level) =>
          (level === "error" ? logger.error : logger.log)(`[boot-parser] ${message}`),
      });
      setupFlow.finish(codes);
    } catch (error) {
      logger.error("[install-controller] The boot-code read failed.", error);
      setupFlow.finish({ ok: false, kind: "serial-failure" });
    }
    try {
      const status = await captureDeviceStatus(port, logger, statusTimeoutMs);
      if (status) {
        if (deviceSettings?.applyStatus) deviceSettings.applyStatus(status);
        evaluateStatusForUpdate(status);
      }
    } catch (error) {
      logger.error("[install-controller] The device-settings capture failed.", error);
    }
  }

  factoryButton.onPostFlash = async (port) => {
    await runFactoryCallback(port);
  };
  updateButton.onPostFlash = async () => {
    setupFlow.finishPreservedUpdate();
  };

  guardInstallClick(factoryActivator, serialMonitor);
  guardInstallClick(updateActivator, serialMonitor);
  enableButton(factoryButton, factoryActivator);
}
