import { parseMatterOnboardingCodes } from "./boot-parser.js";
import {
  buildGetRequest,
  parseAliroProtocolLine,
} from "./device-protocol.js";
import { attachUpdateDialogGuard } from "./update-dialog-guard.js";

const RE_ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const STATUS_TIMEOUT_MS = 3000;

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

  // Send ALIRO/1 GET first.
  const writer = port.writable.getWriter();
  try {
    await writer.write(new TextEncoder().encode(`${buildGetRequest()}\n`));
  } catch (error) {
    logger.error("[install-controller] ALIRO/1 GET write failed.", error);
    try { writer.releaseLock(); } catch { /* Already free. */ }
    return null;
  }
  try { writer.releaseLock(); } catch { /* Already free. */ }

  // Then take one timed reader. On timeout we releaseLock — never cancel —
  // so the ReadableStream stays open for ESP Web Tools' Improv init or a
  // subsequent monitor connection.
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

function readUpdateManifestPath(updateButton) {
  return updateButton?.manifest ?? updateButton?.getAttribute?.("manifest") ?? null;
}

export function configureInstallButtons({
  factoryButton,
  updateButton,
  setupFlow,
  parseCodes = parseMatterOnboardingCodes,
  logger = console,
  serialMonitor,
  deviceSettings,
  statusTimeoutMs = STATUS_TIMEOUT_MS,
  attachDialogGuard = attachUpdateDialogGuard,
}) {
  const factoryActivator = prepareButton(factoryButton);
  const updateActivator = prepareButton(updateButton);

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
    if (deviceSettings?.applyStatus) {
      try {
        const status = await captureDeviceStatus(port, logger, statusTimeoutMs);
        if (status) deviceSettings.applyStatus(status);
      } catch (error) {
        logger.error("[install-controller] The device-settings capture failed.", error);
      }
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
  const updateManifestPath = readUpdateManifestPath(updateButton);
  if (updateManifestPath) {
    attachDialogGuard?.({ updateManifestPath });
  }
  enableButton(factoryButton, factoryActivator);
  enableButton(updateButton, updateActivator);
}
