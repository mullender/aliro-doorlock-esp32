import { parseMatterOnboardingCodes } from "./boot-parser.js";

function prepareButton(button, expectedEraseFirst) {
  const declared = button.getAttribute?.("erase-first");
  if (declared !== String(expectedEraseFirst)) {
    throw new Error(`Invalid erase-first policy: expected ${expectedEraseFirst}`);
  }
  const activator = button.querySelector?.('[slot="activate"]');
  if (!activator) throw new Error("Install button has no activation control.");
  return activator;
}

function enableButton(button, activator) {
  button.eraseFirst = button.getAttribute("erase-first") === "true";
  activator.disabled = false;
  button.inert = false;
  button.removeAttribute("inert");
}

export function configureInstallButtons({
  factoryButton,
  updateButton,
  setupFlow,
  parseCodes = parseMatterOnboardingCodes,
  logger = console,
}) {
  const factoryActivator = prepareButton(factoryButton, true);
  const updateActivator = prepareButton(updateButton, false);

  factoryButton.eraseFirst = true;
  updateButton.eraseFirst = false;

  factoryButton.addEventListener("install-result", (event) => {
    if (event.detail?.status === "success") return;
    setupFlow.handleInstallResult("factory", event.detail, factoryButton);
  });

  updateButton.addEventListener("install-result", (event) => {
    if (event.detail?.status === "success") {
      setupFlow.finishPreservedUpdate(event.detail, updateButton);
      return;
    }
    setupFlow.handleInstallResult("update", event.detail, updateButton);
  });

  factoryButton.onPostFlash = async (port) => {
    const signal = setupFlow.begin("factory");
    try {
      const result = await parseCodes(port, {
        timeoutMs: 15000,
        signal,
        requestReemit: false,
        logger: (message, level) =>
          (level === "error" ? logger.error : logger.log)(`[boot-parser] ${message}`),
      });
      setupFlow.finish(result);
    } catch (error) {
      logger.error("[boot-parser] The serial callback failed.", error);
      setupFlow.finish({ ok: false, kind: "serial-failure" });
    }
  };

  updateButton.onPostFlash = async () => {};

  enableButton(factoryButton, factoryActivator);
  enableButton(updateButton, updateActivator);
}
