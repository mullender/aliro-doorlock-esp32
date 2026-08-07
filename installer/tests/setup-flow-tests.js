import { createSetupFlow } from "../js/setup-flow.js";
import { configureInstallButtons } from "../js/install-controller.js";

function report(container, label, ok) {
  const el = document.createElement("section");
  el.className = ok ? "ok" : "fail";
  el.innerHTML = `<strong>${ok ? "PASS" : "FAIL"}</strong> — ${label}`;
  container.appendChild(el);
  return ok;
}

function makeFlow() {
  const root = document.createElement("div");
  root.innerHTML = `
    <section id="pairing" class="visible" aria-hidden="false"></section>
    <div id="pairing-codes"></div><div id="commissioned" hidden></div>
    <dl id="fabric-details" hidden></dl>
    <code id="fabric-index"></code><code id="fabric-id"></code>
    <code id="node-id"></code><code id="vendor-id"></code>
    <div id="qr">old QR</div><div id="caption">old payload</div>
    <div id="manual">old code</div><div id="status"></div>
    <button id="cancel" hidden></button><button id="retry" hidden></button>`;
  const eventTarget = document.createElement("div");
  const elements = {
    pairing: root.querySelector("#pairing"),
    qr: root.querySelector("#qr"),
    qrCaption: root.querySelector("#caption"),
    manual: root.querySelector("#manual"),
    pairingCodes: root.querySelector("#pairing-codes"),
    commissioned: root.querySelector("#commissioned"),
    fabricDetails: root.querySelector("#fabric-details"),
    fabricIndex: root.querySelector("#fabric-index"),
    fabricId: root.querySelector("#fabric-id"),
    nodeId: root.querySelector("#node-id"),
    vendorId: root.querySelector("#vendor-id"),
    status: root.querySelector("#status"),
    cancel: root.querySelector("#cancel"),
    retry: root.querySelector("#retry"),
  };
  const flow = createSetupFlow({
    elements,
    eventTarget,
    renderQRCode: () => "<svg></svg>",
  });
  return { flow, elements, eventTarget };
}

function makeInstallButton(eraseFirst) {
  const element = document.createElement("div");
  element.setAttribute("erase-first", String(eraseFirst));
  element.setAttribute("inert", "");
  element.inert = true;
  const activator = document.createElement("button");
  activator.slot = "activate";
  activator.disabled = true;
  element.appendChild(activator);
  return element;
}

export async function runSetupFlowTests(container) {
  let pass = 0;
  let fail = 0;
  const count = (ok) => ok ? pass++ : fail++;
  const pair = { mt: "MT:Y.K9042C00KA0648G00", manualCode: "34970112332" };

  {
    const { flow, elements, eventTarget } = makeFlow();
    let detail;
    eventTarget.addEventListener("install-complete", (event) => { detail = event.detail; });
    flow.begin();
    const shown = flow.finish({ ok: true, kind: "success", ...pair });
    const ok = shown && elements.pairing.getAttribute("aria-hidden") === "false" &&
      elements.qr.textContent === "" && elements.qr.innerHTML === "<svg></svg>" &&
      detail?.mt === pair.mt && elements.retry.hidden;
    count(report(container, "success opens the pairing panel and sends install-complete", ok));
  }

  for (const kind of ["timeout", "parse-failure", "serial-failure", "cancel"]) {
    const { flow, elements, eventTarget } = makeFlow();
    let eventSeen = false;
    eventTarget.addEventListener(`install-${kind}`, () => { eventSeen = true; });
    flow.showPairing(pair.mt, pair.manualCode);
    flow.begin();
    const shown = flow.finish({ ok: false, kind });
    const current = flow.getCurrent();
    const ok = !shown && eventSeen && elements.pairing.getAttribute("aria-hidden") === "true" &&
      elements.qr.innerHTML === "" && elements.qrCaption.textContent === "" &&
      current.mt === null && current.manualCode === null && !elements.retry.hidden;
    count(report(container, `${kind} never shows pairing data`, ok));
  }

  {
    const { flow, elements } = makeFlow();
    const signal = flow.begin();
    flow.cancel();
    const ok = signal.aborted && !elements.cancel.hidden;
    count(report(container, "Cancel code read aborts the active serial read", ok));
  }

  {
    const factoryButton = makeInstallButton(true);
    const updateButton = makeInstallButton(false);
    const { flow } = makeFlow();
    configureInstallButtons({ factoryButton, updateButton, setupFlow: flow });
    const ok = factoryButton.eraseFirst === true && updateButton.eraseFirst === false &&
      !factoryButton.inert && !updateButton.inert &&
      !factoryButton.querySelector("button").disabled &&
      !updateButton.querySelector("button").disabled;
    count(report(container, "installer buttons force safe erase modes", ok));
  }

  {
    const { flow, elements } = makeFlow();
    const updateTarget = document.createElement("div");
    let detail;
    updateTarget.addEventListener("install-update-complete", (event) => { detail = event.detail; });
    flow.showPairing(pair.mt, pair.manualCode);
    flow.finishPreservedUpdate({ chipFamily: "ESP32-C6", version: "test" }, updateTarget);
    const ok = elements.pairing.getAttribute("aria-hidden") === "true" &&
      flow.getCurrent().mt === null && detail?.version === "test" &&
      !("mt" in detail) && !("manualCode" in detail);
    count(report(container, "preserved update clears pairing data and emits no secrets", ok));
  }

  {
    const factoryButton = makeInstallButton(true);
    const updateButton = makeInstallButton(false);
    const { flow, elements } = makeFlow();
    configureInstallButtons({
      factoryButton,
      updateButton,
      setupFlow: flow,
      parseCodes: async () => ({ ok: true, kind: "success", ...pair }),
    });
    await factoryButton.onPostFlash({});
    const readyStatus = elements.status.textContent;
    factoryButton.dispatchEvent(new CustomEvent("install-result", {
      detail: { status: "success", chipFamily: "ESP32-C6", version: "test" },
    }));
    const ok = elements.pairing.getAttribute("aria-hidden") === "false" &&
      elements.qrCaption.textContent === pair.mt && elements.status.textContent === readyStatus;
    count(report(container, "factory terminal success keeps post-flash pairing data", ok));
  }

  {
    const factoryButton = makeInstallButton(true);
    const updateButton = makeInstallButton(false);
    const { flow, elements } = makeFlow();
    configureInstallButtons({ factoryButton, updateButton, setupFlow: flow });
    flow.showPairing(pair.mt, pair.manualCode);
    await updateButton.onPostFlash({});
    const pairingStayedVisible = elements.pairing.getAttribute("aria-hidden") === "false";
    updateButton.dispatchEvent(new CustomEvent("install-result", {
      detail: { status: "success", chipFamily: "ESP32-C6", version: "test" },
    }));
    const ok = pairingStayedVisible && elements.pairing.getAttribute("aria-hidden") === "true" &&
      elements.status.textContent ===
        "Update complete. Setup data was kept. Wait for the lock to reconnect to Matter and Thread.";
    count(report(container, "update terminal success owns the final status", ok));
  }

  return { pass, fail };
}
