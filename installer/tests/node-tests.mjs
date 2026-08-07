import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  decodeBase38,
  decodeMTPayload,
  decodeManualCode,
  encodeBase38,
  isValidSetupPIN,
  validatePair,
  __internals as payloadInternals,
} from "../js/matter-payload.js";
import {
  parseMatterOnboardingCodes,
  parseOnboardingText,
  __internals as parserInternals,
} from "../js/boot-parser.js";
import { createSetupFlow } from "../js/setup-flow.js";
import { configureInstallButtons } from "../js/install-controller.js";
import { createSerialMonitor } from "../js/serial-monitor.js";
import { LOG_FIXTURES } from "./boot-log-fixtures.js";
import {
  BASE38_VECTORS,
  INVALID_BASE38_VECTORS,
  NEGATIVE_VECTORS,
  VECTORS,
} from "./test-vectors.js";

if (!globalThis.CustomEvent) {
  globalThis.CustomEvent = class extends Event {
    constructor(type, options = {}) {
      super(type);
      this.detail = options.detail;
    }
  };
}

function textStream(text) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

function fakeElement() {
  const classes = new Set();
  const attributes = new Map();
  return {
    innerHTML: "",
    textContent: "",
    hidden: false,
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
    },
    setAttribute: (name, value) => attributes.set(name, String(value)),
    getAttribute: (name) => attributes.get(name),
  };
}

class FakeControl extends EventTarget {
  constructor() {
    super();
    this.disabled = false;
    this.textContent = "";
    this.scrollTop = 0;
    this.scrollHeight = 0;
  }

  click() {
    return this.dispatchEvent(new Event("click", { bubbles: true, cancelable: true }));
  }
}

class FakeInstallButton extends EventTarget {
  constructor(eraseFirst) {
    super();
    this.attributes = new Map([
      ["erase-first", String(eraseFirst)],
      ["inert", ""],
    ]);
    this.activator = new FakeControl();
    this.activator.disabled = true;
    this.inert = true;
  }

  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  querySelector(selector) { return selector === '[slot="activate"]' ? this.activator : null; }
}

function fakeMonitorElements() {
  return {
    connect: new FakeControl(),
    reset: new FakeControl(),
    copy: new FakeControl(),
    clear: new FakeControl(),
    disconnect: new FakeControl(),
    status: new FakeControl(),
    log: new FakeControl(),
  };
}

function fakeSerialPort({ openError } = {}) {
  let streamController;
  const readable = new ReadableStream({
    start(controller) { streamController = controller; },
  });
  return {
    readable,
    streamController,
    openCalls: [],
    closeCalls: 0,
    signalCalls: [],
    async open(options) {
      this.openCalls.push(options);
      if (openError) throw openError;
    },
    async close() { this.closeCalls += 1; },
    async setSignals(value) { this.signalCalls.push(value); },
  };
}

class FakeSerial extends EventTarget {
  constructor(results, authorizedPorts = []) {
    super();
    this.results = [...results];
    this.authorizedPorts = [...authorizedPorts];
    this.requestCount = 0;
    this.getPortsCount = 0;
    this.disconnectListeners = new Set();
  }

  addEventListener(type, listener, options) {
    if (type === "disconnect") this.disconnectListeners.add(listener);
    else super.addEventListener(type, listener, options);
  }

  removeEventListener(type, listener, options) {
    if (type === "disconnect") this.disconnectListeners.delete(listener);
    else super.removeEventListener(type, listener, options);
  }

  emitDisconnect(event) {
    for (const listener of this.disconnectListeners) listener.call(this, event);
  }

  async getPorts() {
    this.getPortsCount += 1;
    return [...this.authorizedPorts];
  }

  async requestPort() {
    this.requestCount += 1;
    const result = this.results.shift();
    if (result instanceof Error) throw result;
    return result;
  }
}

const nextTask = () => new Promise((resolve) => setTimeout(resolve, 0));

function matchingPairForPIN(passcode) {
  const discriminator = 3840;
  const bytes = decodeBase38("Y.K9042C00KA0648G00");
  for (let bit = 0; bit < 27; bit++) {
    const targetBit = 57 + bit;
    const mask = 1 << (targetBit % 8);
    if (Math.floor(passcode / (2 ** bit)) % 2) {
      bytes[Math.floor(targetBit / 8)] |= mask;
    } else {
      bytes[Math.floor(targetBit / 8)] &= ~mask;
    }
  }

  const shortDiscriminator = discriminator >> 8;
  const chunk1 = (shortDiscriminator >> 2) & 0x3;
  const chunk2 = ((shortDiscriminator & 0x3) << 14) | (passcode & 0x3fff);
  const chunk3 = passcode >> 14;
  const body = String(chunk1) + String(chunk2).padStart(5, "0") +
    String(chunk3).padStart(4, "0");
  const checkDigit = payloadInternals.verhoeffCheckDigit([...body].map(Number));
  return {
    mt: `MT:${encodeBase38(bytes)}`,
    manualCode: `${body}${checkDigit}`,
  };
}

function fakeFlow() {
  const elements = {
    pairing: fakeElement(),
    qr: fakeElement(),
    qrCaption: fakeElement(),
    manual: fakeElement(),
    pairingCodes: fakeElement(),
    commissioned: fakeElement(),
    fabricDetails: fakeElement(),
    fabricIndex: fakeElement(),
    fabricId: fakeElement(),
    nodeId: fakeElement(),
    vendorId: fakeElement(),
    status: fakeElement(),
    cancel: fakeElement(),
    retry: fakeElement(),
  };
  elements.cancel.hidden = true;
  elements.retry.hidden = true;
  const eventTarget = new EventTarget();
  return {
    elements,
    eventTarget,
    flow: createSetupFlow({
      elements,
      eventTarget,
      renderQRCode: () => "<svg></svg>",
    }),
  };
}

test("known Matter codes decode and Base38 round-trips", () => {
  for (const vector of VECTORS) {
    assert.equal(validatePair(vector.mt, vector.manualCode).valid, true);
    const bytes = decodeBase38(vector.mt.slice(3));
    assert.equal(encodeBase38(bytes), vector.mt.slice(3));
    const qr = decodeMTPayload(vector.mt);
    const manual = decodeManualCode(vector.manualCode);
    assert.equal(qr.discriminator, vector.discriminator);
    assert.equal(qr.passcode, vector.passcode);
    assert.equal(manual.shortDiscriminator, vector.discriminator >> 8);
    assert.equal(manual.passcode, vector.passcode);
  }
});

test("official Matter Base38 vectors encode and decode", () => {
  for (const vector of BASE38_VECTORS) {
    assert.equal(encodeBase38(vector.bytes), vector.encoded);
    assert.deepEqual([...decodeBase38(vector.encoded)], vector.bytes);
  }
  for (const encoded of INVALID_BASE38_VECTORS) {
    assert.throws(() => decodeBase38(encoded));
  }
});

test("matching pairs with forbidden Matter setup PINs fail", () => {
  const forbidden = [
    0,
    99999999,
    11111111,
    22222222,
    33333333,
    44444444,
    55555555,
    66666666,
    77777777,
    88888888,
    12345678,
    87654321,
  ];
  for (const pin of forbidden) {
    assert.equal(isValidSetupPIN(pin), false);
    const pair = matchingPairForPIN(pin);
    assert.deepEqual(validatePair(pair.mt, pair.manualCode), {
      valid: false,
      error: "codes contain a forbidden setup PIN",
    });
  }
  assert.equal(isValidSetupPIN(1), true);
  assert.equal(isValidSetupPIN(99999998), true);
});

test("invalid or mismatched code pairs fail", () => {
  for (const vector of NEGATIVE_VECTORS) {
    const result = validatePair(vector.mt, vector.manualCode);
    assert.equal(result.valid, false, vector.label);
    assert.match(result.error, vector.expectError, vector.label);
  }
});

test("boot fixtures use the production parser", () => {
  for (const fixture of LOG_FIXTURES) {
    const result = parseOnboardingText(fixture.log);
    if (fixture.expectFail) {
      assert.equal(Boolean(result.mt && result.manualCode), false, fixture.label);
    } else if (fixture.expectParseFailure) {
      assert.equal(validatePair(result.mt, result.manualCode).valid, false, fixture.label);
    } else {
      assert.deepEqual(result, fixture.expect, fixture.label);
    }
  }
});

test("boot parser requires the commissioned marker and keeps raw fabric values", () => {
  const fabricLine = "I (773) chip[FP]: Fabric index 0x1 was retrieved from storage. " +
    "Compressed FabricId 0x992322CA0AB8BB0A, FabricId 0x0000000000000001, " +
    "NodeId 0x0000000000000001, VendorId 0xFFF1";
  const detailsOnly = parseOnboardingText(fabricLine);
  assert.equal(detailsOnly.commissioned, undefined);
  assert.deepEqual(detailsOnly.fabric, {
    fabricIndex: "0x1",
    fabricId: "0x0000000000000001",
    nodeId: "0x0000000000000001",
    vendorId: "0xFFF1",
  });

  const commissioned = parseOnboardingText(
    `${fabricLine}\nI (843) chip[SVR]: Fabric already commissioned. Disabling BLE advertisement`,
  );
  assert.equal(commissioned.commissioned, true);
  assert.deepEqual(commissioned.fabric, detailsOnly.fabric);

  const similarText = parseOnboardingText("I chip[SVR]: Fabric is already commissioned");
  assert.equal(similarText.commissioned, undefined);
});

test("serial parser returns commissioned before later QR lines", async () => {
  const readable = textStream([
    "I chip[FP]: Fabric index 0x2 was retrieved from storage. Compressed FabricId 0xAA, " +
      "FabricId 0x0000000000000042, NodeId 0x0000000000000099, VendorId 0xFFF1",
    "I chip[SVR]: Fabric already commissioned. Disabling BLE advertisement",
    "I chip[SVR]: SetupQRCode: [MT:Y.K9042C00KA0648G00]",
    "I chip[SVR]: Manual pairing code: [34970112332]",
  ].join("\n"));
  const result = await parseMatterOnboardingCodes(
    { readable },
    { timeoutMs: 100, requestReset: false },
  );
  assert.deepEqual(result, {
    ok: true,
    kind: "commissioned",
    fabric: {
      fabricIndex: "0x2",
      fabricId: "0x0000000000000042",
      nodeId: "0x0000000000000099",
      vendorId: "0xFFF1",
    },
    source: "boot",
  });
  assert.equal(readable.locked, false);
});

test("serial parser returns success and no raw log", async () => {
  const log = "I (1110) chip[SVR]: SetupQRCode: [MT:Y.K9042C00KA0648G00]\n" +
    "I (1110) chip[SVR]: Manual pairing code: [34970112332]";
  const readable = textStream(log);
  const result = await parseMatterOnboardingCodes(
    { readable },
    { timeoutMs: 100, requestReset: false },
  );
  assert.equal(result.ok, true);
  assert.equal(result.source, "boot");
  assert.equal("log" in result, false);
  assert.equal(readable.locked, false);
});

test("serial parser returns distinct timeout and cancel results", async () => {
  const timeoutStream = new ReadableStream({ start() {} });
  const timeout = await parseMatterOnboardingCodes(
    { readable: timeoutStream },
    { timeoutMs: 10, requestReset: false },
  );
  assert.equal(timeout.kind, "timeout");
  assert.equal(timeoutStream.locked, false);

  const cancelStream = new ReadableStream({ start() {} });
  const controller = new AbortController();
  const pending = parseMatterOnboardingCodes(
    { readable: cancelStream },
    { timeoutMs: 100, requestReset: false, signal: controller.signal },
  );
  controller.abort();
  const canceled = await pending;
  assert.equal(canceled.kind, "cancel");
  assert.equal(cancelStream.locked, false);
});

test("one reset recovers a missed boot log", async () => {
  const log = "I (1110) chip[SVR]: SetupQRCode: [MT:Y.K9042C00KA0648G00]\n" +
    "I (1110) chip[SVR]: Manual pairing code: [34970112332]";
  let streamController;
  const readable = new ReadableStream({ start(controller) { streamController = controller; } });
  const signalChanges = [];
  const port = {
    readable,
    async setSignals(value) {
      signalChanges.push(value);
      if (value.requestToSend === false) {
        streamController.enqueue(new TextEncoder().encode(log));
        streamController.close();
      }
    },
  };
  const result = await parseMatterOnboardingCodes(port, {
    timeoutMs: 100,
    resetAfterMs: 0,
    resetPulseMs: 0,
  });
  assert.equal(result.ok, true);
  assert.equal(signalChanges.length, 2);
  assert.equal(readable.locked, false);
});

test("reset deassertion retries after a signal failure", async () => {
  const calls = [];
  let failedOnce = false;
  const port = {
    async setSignals(value) {
      calls.push(value);
      if (value.requestToSend === false && !failedOnce) {
        failedOnce = true;
        throw new Error("injected deassert failure");
      }
    },
  };
  await parserInternals.requestDeviceReset(port, 0);
  assert.deepEqual(calls, [
    { dataTerminalReady: false, requestToSend: true },
    { dataTerminalReady: false, requestToSend: false },
    { dataTerminalReady: false, requestToSend: false },
  ]);
});

test("serial command recovery works when the firmware supports it", async () => {
  const log = "I (1110) chip[SVR]: SetupQRCode: [MT:Y.K9042C00KA0648G00]\n" +
    "I (1110) chip[SVR]: Manual pairing code: [34970112332]";
  let streamController;
  let command = "";
  const readable = new ReadableStream({ start(controller) { streamController = controller; } });
  const writable = new WritableStream({
    write(chunk) {
      command += new TextDecoder().decode(chunk);
      streamController.enqueue(new TextEncoder().encode(log));
      streamController.close();
    },
  });
  const result = await parseMatterOnboardingCodes(
    { readable, writable },
    { timeoutMs: 10, reemitTimeoutMs: 100, requestReset: false, requestReemit: true },
  );
  assert.equal(result.source, "reemit");
  assert.equal(command, "matter onboardingcodes\r\n");
  assert.equal(readable.locked, false);
  assert.equal(writable.locked, false);
});

test("failure states clear all pairing data", () => {
  for (const kind of ["timeout", "parse-failure", "serial-failure", "cancel"]) {
    const { flow, elements } = fakeFlow();
    assert.equal(flow.showPairing("MT:Y.K9042C00KA0648G00", "34970112332"), true);
    flow.begin();
    assert.equal(flow.finish({ ok: false, kind }), false);
    assert.equal(elements.pairing.getAttribute("aria-hidden"), "true");
    assert.equal(elements.qr.innerHTML, "");
    assert.equal(elements.qrCaption.textContent, "");
    assert.deepEqual(flow.getCurrent().mt, null);
  }
});

test("success is the only state that sends pairing data", () => {
  const { flow, elements, eventTarget } = fakeFlow();
  let completed;
  eventTarget.addEventListener("install-complete", (event) => { completed = event.detail; });
  flow.begin("factory");
  assert.equal(flow.finish({
    ok: true,
    kind: "success",
    mt: "MT:Y.K9042C00KA0648G00",
    manualCode: "34970112332",
  }), true);
  assert.equal(elements.pairing.getAttribute("aria-hidden"), "false");
  assert.equal(completed.installMode, "factory");
});

test("commissioned state replaces pairing codes and shows raw fabric values", () => {
  const { flow, elements } = fakeFlow();
  flow.showPairing("MT:Y.K9042C00KA0648G00", "34970112332");
  flow.showCommissioned({
    fabricIndex: "0x1",
    fabricId: "0x0000000000000001",
    nodeId: "0x0000000000000002",
    vendorId: "0xFFF1",
  });

  assert.equal(elements.pairing.getAttribute("aria-hidden"), "false");
  assert.equal(elements.pairingCodes.hidden, true);
  assert.equal(elements.commissioned.hidden, false);
  assert.equal(elements.fabricDetails.hidden, false);
  assert.equal(elements.fabricIndex.textContent, "0x1");
  assert.equal(elements.fabricId.textContent, "0x0000000000000001");
  assert.equal(elements.nodeId.textContent, "0x0000000000000002");
  assert.equal(elements.vendorId.textContent, "0xFFF1");
  assert.deepEqual(flow.getCurrent().mt, null);
});

test("installer buttons force safe erase modes", () => {
  const factoryButton = new FakeInstallButton(true);
  const updateButton = new FakeInstallButton(false);
  const setupFlow = {
    handleInstallResult() {},
    begin: () => new AbortController().signal,
    finish() {},
    finishPreservedUpdate() {},
  };
  configureInstallButtons({ factoryButton, updateButton, setupFlow });
  assert.equal(factoryButton.eraseFirst, true);
  assert.equal(updateButton.eraseFirst, false);
  assert.equal(factoryButton.inert, false);
  assert.equal(updateButton.inert, false);
  assert.equal(factoryButton.activator.disabled, false);
  assert.equal(updateButton.activator.disabled, false);
});

test("installer page declares disabled fail-closed policies", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html,
    /id="update-button"[\s\S]*?erase-first="false"[\s\S]*?inert>[\s\S]*?<button slot="activate" disabled>/);
  assert.match(html,
    /id="factory-button"[\s\S]*?erase-first="true"[\s\S]*?inert>[\s\S]*?<button slot="activate" disabled>/);
});

test("installer buttons stay disabled when a policy declaration is wrong", () => {
  const factoryButton = new FakeInstallButton(false);
  const updateButton = new FakeInstallButton(false);
  const setupFlow = {
    handleInstallResult() {},
    begin: () => new AbortController().signal,
    finish() {},
    finishPreservedUpdate() {},
  };
  assert.throws(() => configureInstallButtons({ factoryButton, updateButton, setupFlow }));
  assert.equal(factoryButton.inert, true);
  assert.equal(updateButton.inert, true);
  assert.equal(factoryButton.activator.disabled, true);
  assert.equal(updateButton.activator.disabled, true);
});

test("install-result events use visible mode-specific state", () => {
  const factoryButton = new FakeInstallButton(true);
  const updateButton = new FakeInstallButton(false);
  const calls = [];
  const setupFlow = {
    handleInstallResult: (...args) => calls.push(args),
    begin: () => new AbortController().signal,
    finish() {},
    finishPreservedUpdate() {},
  };
  configureInstallButtons({ factoryButton, updateButton, setupFlow });
  factoryButton.dispatchEvent(new CustomEvent("install-result", {
    detail: { status: "cancelled", reason: "port-picker" },
  }));
  updateButton.dispatchEvent(new CustomEvent("install-result", {
    detail: { status: "error", error: "write_failed", message: "Write failed" },
  }));
  assert.equal(calls[0][0], "factory");
  assert.equal(calls[0][1].status, "cancelled");
  assert.equal(calls[1][0], "update");
  assert.equal(calls[1][1].status, "error");
});

test("factory post-flash parses codes but update post-flash does not", async () => {
  const factoryButton = new FakeInstallButton(true);
  const updateButton = new FakeInstallButton(false);
  let parseCount = 0;
  let factoryFinished;
  let updateFinished;
  const setupFlow = {
    handleInstallResult() {},
    begin: () => new AbortController().signal,
    finish: (result) => { factoryFinished = result; },
    finishPreservedUpdate: (result, target) => { updateFinished = { result, target }; },
  };
  configureInstallButtons({
    factoryButton,
    updateButton,
    setupFlow,
    parseCodes: async () => {
      parseCount += 1;
      return { ok: true, mt: "MT:Y.K9042C00KA0648G00", manualCode: "34970112332" };
    },
  });

  await factoryButton.onPostFlash({});
  assert.equal(parseCount, 1);
  assert.equal(factoryFinished.ok, true);

  await updateButton.onPostFlash({});
  assert.equal(parseCount, 1);
  assert.equal(updateFinished, undefined);

  updateButton.dispatchEvent(new CustomEvent("install-result", {
    detail: { status: "success", chipFamily: "ESP32-C6", version: "test" },
  }));
  assert.equal(updateFinished.result.version, "test");
  assert.equal(updateFinished.target, updateButton);
});

test("factory terminal success keeps pairing data from post-flash", async () => {
  const factoryButton = new FakeInstallButton(true);
  const updateButton = new FakeInstallButton(false);
  const { flow, elements } = fakeFlow();
  configureInstallButtons({
    factoryButton,
    updateButton,
    setupFlow: flow,
    parseCodes: async () => ({
      ok: true,
      kind: "success",
      mt: "MT:Y.K9042C00KA0648G00",
      manualCode: "34970112332",
    }),
  });

  await factoryButton.onPostFlash({});
  const readyStatus = elements.status.textContent;
  factoryButton.dispatchEvent(new CustomEvent("install-result", {
    detail: { status: "success", chipFamily: "ESP32-C6", version: "test" },
  }));

  assert.equal(elements.pairing.getAttribute("aria-hidden"), "false");
  assert.equal(elements.qrCaption.textContent, "MT:Y.K9042C00KA0648G00");
  assert.equal(elements.status.textContent, readyStatus);
});

test("update terminal success sets the final status after post-flash", async () => {
  const factoryButton = new FakeInstallButton(true);
  const updateButton = new FakeInstallButton(false);
  const { flow, elements } = fakeFlow();
  configureInstallButtons({ factoryButton, updateButton, setupFlow: flow });
  flow.showPairing("MT:Y.K9042C00KA0648G00", "34970112332");

  await updateButton.onPostFlash({});
  assert.equal(elements.pairing.getAttribute("aria-hidden"), "false");
  updateButton.dispatchEvent(new CustomEvent("install-result", {
    detail: { status: "success", chipFamily: "ESP32-C6", version: "test" },
  }));

  assert.equal(elements.pairing.getAttribute("aria-hidden"), "true");
  assert.equal(elements.status.textContent,
    "Update complete. Setup data was kept. Wait for the lock to reconnect to Matter and Thread.");
});

test("flash cancel and error clear setup codes", () => {
  for (const result of [
    { status: "cancelled", reason: "port-picker" },
    { status: "error", error: "write_failed", message: "Write failed" },
  ]) {
    const { flow, elements, eventTarget } = fakeFlow();
    flow.showPairing("MT:Y.K9042C00KA0648G00", "34970112332");
    let detail;
    const eventName = result.status === "cancelled" ? "install-cancel" : "install-error";
    eventTarget.addEventListener(eventName, (event) => { detail = event.detail; });
    flow.handleInstallResult("factory", result, eventTarget);
    assert.equal(elements.pairing.getAttribute("aria-hidden"), "true");
    assert.equal(flow.getCurrent().mt, null);
    assert.equal("mt" in detail, false);
    assert.equal("manualCode" in detail, false);
  }
});

test("preserved update hides pairing data and emits no secrets", () => {
  const { flow, elements } = fakeFlow();
  const updateTarget = new EventTarget();
  let detail;
  updateTarget.addEventListener("install-update-complete", (event) => { detail = event.detail; });
  flow.showPairing("MT:Y.K9042C00KA0648G00", "34970112332");
  flow.finishPreservedUpdate({ chipFamily: "ESP32-C6", version: "test" }, updateTarget);
  assert.equal(elements.pairing.getAttribute("aria-hidden"), "true");
  assert.equal(flow.getCurrent().mt, null);
  assert.deepEqual(detail, {
    installMode: "update",
    chipFamily: "ESP32-C6",
    version: "test",
  });
});

test("live serial monitor shows logs and sends valid codes through setup flow", async () => {
  const serialPort = fakeSerialPort();
  const serial = new FakeSerial([serialPort]);
  const monitorElements = fakeMonitorElements();
  const { flow, elements } = fakeFlow();
  const monitor = createSerialMonitor({
    elements: monitorElements,
    setupFlow: flow,
    serial,
    secureContext: true,
    resetPulseMs: 0,
  });

  assert.equal(await monitor.connect(), true);
  serialPort.streamController.enqueue(new TextEncoder().encode(
    "I (1110) chip[SVR]: SetupQRCode: [MT:Y.K9042C00KA0648G00]\n" +
    "I (1110) chip[SVR]: Manual pairing code: [34970112332]\n",
  ));
  await nextTask();

  assert.match(monitorElements.log.textContent, /SetupQRCode/);
  assert.equal(flow.getCurrent().mt, "MT:Y.K9042C00KA0648G00");
  assert.equal(elements.pairing.getAttribute("aria-hidden"), "false");
  assert.equal(elements.status.textContent, "Live serial setup codes are ready.");
  assert.equal(monitorElements.status.textContent,
    "Connected. Matter setup codes found.");

  monitor.clear();
  assert.equal(monitorElements.log.textContent, "");
  const resetResult = monitor.reset();
  const releaseResult = monitor.releaseForInstall();
  assert.equal(await resetResult, true);
  assert.equal(await releaseResult, true);
  assert.deepEqual(serialPort.signalCalls, [
    { dataTerminalReady: false, requestToSend: true },
    { dataTerminalReady: false, requestToSend: false },
  ]);
  assert.equal(serialPort.closeCalls, 1);
  assert.equal(serialPort.readable.locked, false);
  assert.equal(monitor.isActive(), false);
  assert.equal(monitorElements.status.textContent,
    "Serial monitor disconnected for install. Click the install button again to continue.");
});

test("copy logs button writes the full current console text to the clipboard", async () => {
  const serialPort = fakeSerialPort();
  const elements = fakeMonitorElements();
  let copiedText = null;
  const monitor = createSerialMonitor({
    elements,
    setupFlow: { showPairing: () => true },
    serial: new FakeSerial([serialPort]),
    clipboard: {
      async writeText(text) { copiedText = text; },
    },
    secureContext: true,
  });
  await monitor.connect();
  serialPort.streamController.enqueue(new TextEncoder().encode("First line\n"));
  serialPort.streamController.enqueue(new TextEncoder().encode("Second line\n"));
  await nextTask();

  elements.copy.click();
  await nextTask();
  assert.equal(copiedText, "First line\nSecond line\n");
  assert.equal(elements.status.textContent, "Live logs copied to the clipboard.");
  await monitor.destroy();
});

test("live commissioned marker keeps later boot QR lines hidden", async () => {
  const serialPort = fakeSerialPort();
  const monitorElements = fakeMonitorElements();
  const { flow, elements } = fakeFlow();
  const monitor = createSerialMonitor({
    elements: monitorElements,
    setupFlow: flow,
    serial: new FakeSerial([serialPort]),
    secureContext: true,
  });
  await monitor.connect();

  serialPort.streamController.enqueue(new TextEncoder().encode([
    "I chip[FP]: Fabric index 0x1 was retrieved from storage. Compressed FabricId 0xAA, " +
      "FabricId 0x0000000000000001, NodeId 0x0000000000000002, VendorId 0xFFF1",
    "I chip[SVR]: Fabric already commissioned. Disabling BLE advertisement",
    "I chip[SVR]: SetupQRCode: [MT:Y.K9042C00KA0648G00]",
    "I chip[SVR]: Manual pairing code: [34970112332]",
    "",
  ].join("\n")));
  await nextTask();

  assert.equal(elements.commissioned.hidden, false);
  assert.equal(elements.pairingCodes.hidden, true);
  assert.equal(elements.fabricId.textContent, "0x0000000000000001");
  assert.equal(flow.getCurrent().mt, null);
  assert.equal(monitorElements.status.textContent, "Connected. Device is already commissioned.");
  await monitor.destroy();
});

test("clear allows the same setup-code pair to be shown again", async () => {
  const serialPort = fakeSerialPort();
  const serial = new FakeSerial([serialPort]);
  let showCount = 0;
  const monitor = createSerialMonitor({
    elements: fakeMonitorElements(),
    setupFlow: {
      showPairing() {
        showCount += 1;
        return true;
      },
    },
    serial,
    secureContext: true,
  });
  await monitor.connect();

  const pair = new TextEncoder().encode(
    "I chip[SVR]: SetupQRCode: [MT:Y.K9042C00KA0648G00]\n" +
    "I chip[SVR]: Manual pairing code: [34970112332]\n",
  );
  serialPort.streamController.enqueue(pair);
  await nextTask();
  monitor.clear();
  serialPort.streamController.enqueue(pair);
  await nextTask();

  assert.equal(showCount, 2);
  await monitor.destroy();
});

test("physical disconnect events accept event.port and event.target", async () => {
  for (const eventShape of ["port", "target"]) {
    const serialPort = fakeSerialPort();
    const serial = new FakeSerial([serialPort]);
    const elements = fakeMonitorElements();
    const monitor = createSerialMonitor({
      elements,
      setupFlow: { showPairing: () => true },
      serial,
      secureContext: true,
    });
    await monitor.connect();

    serial.emitDisconnect({ [eventShape]: serialPort });
    await nextTask();

    assert.equal(serialPort.readable.locked, false, eventShape);
    assert.equal(serialPort.closeCalls, 1, eventShape);
    assert.equal(monitor.isActive(), false, eventShape);
    assert.equal(elements.status.textContent, "Device disconnected. You can reconnect.");
    await monitor.destroy();
  }
});

test("one authorized port connects automatically without a picker", async () => {
  const serialPort = fakeSerialPort();
  const serial = new FakeSerial([], [serialPort]);
  const monitor = createSerialMonitor({
    elements: fakeMonitorElements(),
    setupFlow: { showPairing: () => true },
    serial,
    secureContext: true,
  });

  await nextTask();

  assert.equal(serial.getPortsCount, 1);
  assert.equal(serial.requestCount, 0);
  assert.deepEqual(serialPort.openCalls, [{ baudRate: 115200, bufferSize: 8192 }]);
  assert.equal(monitor.getState().connected, true);
  await monitor.destroy();
});

test("install release waits for authorized auto-connect and closes its port", async () => {
  const serialPort = fakeSerialPort();
  let resolveAuthorizedPorts;
  const serial = new FakeSerial([], []);
  serial.getPorts = async () => new Promise((resolve) => {
    resolveAuthorizedPorts = resolve;
  });
  const monitor = createSerialMonitor({
    elements: fakeMonitorElements(),
    setupFlow: { showPairing: () => true },
    serial,
    secureContext: true,
  });

  assert.equal(monitor.isActive(), true);
  const released = monitor.releaseForInstall();
  resolveAuthorizedPorts([serialPort]);

  assert.equal(await released, true);
  assert.equal(serialPort.openCalls.length, 1);
  assert.equal(serialPort.closeCalls, 1);
  assert.equal(serialPort.readable.locked, false);
  assert.equal(monitor.isActive(), false);
});

test("zero or multiple authorized ports never open a picker automatically", async () => {
  for (const authorizedCount of [0, 2]) {
    const selectedPort = fakeSerialPort();
    const authorizedPorts = Array.from({ length: authorizedCount }, () => fakeSerialPort());
    const elements = fakeMonitorElements();
    const serial = new FakeSerial([selectedPort], authorizedPorts);
    const monitor = createSerialMonitor({
      elements,
      setupFlow: { showPairing: () => true },
      serial,
      secureContext: true,
    });

    await nextTask();
    assert.equal(serial.requestCount, 0, authorizedCount);
    assert.equal(selectedPort.openCalls.length, 0, authorizedCount);
    for (const authorizedPort of authorizedPorts) {
      assert.equal(authorizedPort.openCalls.length, 0, authorizedCount);
    }

    elements.connect.click();
    await nextTask();
    assert.equal(serial.requestCount, 1, authorizedCount);
    assert.equal(selectedPort.openCalls.length, 1, authorizedCount);
    await monitor.destroy();
  }
});

test("serial monitor reconnects and cleans up the active reader", async () => {
  const firstPort = fakeSerialPort();
  const secondPort = fakeSerialPort();
  const serial = new FakeSerial([firstPort, secondPort]);
  const elements = fakeMonitorElements();
  const monitor = createSerialMonitor({
    elements,
    setupFlow: { showPairing: () => true },
    serial,
    secureContext: true,
  });

  assert.equal(await monitor.connect(), true);
  assert.equal(await monitor.disconnect(), true);
  assert.equal(firstPort.readable.locked, false);
  assert.equal(await monitor.connect(), true);
  assert.equal(serial.requestCount, 2);
  assert.equal(monitor.getState().connected, true);

  await monitor.destroy();
  assert.equal(secondPort.readable.locked, false);
  assert.equal(secondPort.closeCalls, 1);
  assert.equal(elements.connect.disabled, true);
});

test("live serial parsing recovers from a bad pair and split input", async () => {
  const serialPort = fakeSerialPort();
  const monitorElements = fakeMonitorElements();
  const { flow } = fakeFlow();
  const monitor = createSerialMonitor({
    elements: monitorElements,
    setupFlow: flow,
    serial: new FakeSerial([serialPort]),
    secureContext: true,
  });
  await monitor.connect();

  serialPort.streamController.enqueue(new TextEncoder().encode(
    "I chip[SVR]: SetupQRCode: [MT:Y.K9042C00KA0648G00]\n" +
    "I chip[SVR]: Manual pairing code: [00054912336]\n" +
    "I chip[SVR]: SetupQRCode: [MT:Y.K9042C00K",
  ));
  await nextTask();
  assert.equal(flow.getCurrent().mt, null);
  serialPort.streamController.enqueue(new TextEncoder().encode(
    "A0648G00]\nI chip[SVR]: Manual pairing code: [34970112332]\n",
  ));
  await nextTask();

  assert.equal(flow.getCurrent().mt, "MT:Y.K9042C00KA0648G00");
  assert.equal(flow.getCurrent().manualCode, "34970112332");
  await monitor.destroy();
});

test("serial monitor reports permission and concurrent-reader failures", async () => {
  const denied = new Error("permission denied");
  denied.name = "NotAllowedError";
  const deniedElements = fakeMonitorElements();
  const deniedMonitor = createSerialMonitor({
    elements: deniedElements,
    setupFlow: { showPairing: () => true },
    serial: new FakeSerial([denied]),
    secureContext: true,
  });
  assert.equal(await deniedMonitor.connect(), false);
  assert.match(deniedElements.status.textContent, /permission/i);

  const busyPort = fakeSerialPort();
  const otherReader = busyPort.readable.getReader();
  const busyElements = fakeMonitorElements();
  const busyMonitor = createSerialMonitor({
    elements: busyElements,
    setupFlow: { showPairing: () => true },
    serial: new FakeSerial([busyPort]),
    secureContext: true,
  });
  assert.equal(await busyMonitor.connect(), false);
  assert.match(busyElements.status.textContent, /active reader/i);
  assert.equal(busyPort.closeCalls, 0);
  otherReader.releaseLock();
  assert.equal(await busyMonitor.disconnect(), true);
  assert.equal(busyPort.closeCalls, 1);

  await deniedMonitor.destroy();
  await busyMonitor.destroy();
});

test("an install click releases the monitor before the installer can continue", async () => {
  const factoryButton = new FakeInstallButton(true);
  const updateButton = new FakeInstallButton(false);
  let active = true;
  let releaseCount = 0;
  const serialMonitor = {
    isActive: () => active,
    async releaseForInstall() {
      releaseCount += 1;
      await nextTask();
      active = false;
      return true;
    },
  };
  const setupFlow = {
    handleInstallResult() {},
    begin: () => new AbortController().signal,
    finish() {},
    finishPreservedUpdate() {},
  };
  configureInstallButtons({
    factoryButton,
    updateButton,
    setupFlow,
    serialMonitor,
  });

  assert.equal(factoryButton.activator.click(), false);
  assert.equal(factoryButton.activator.disabled, true);
  await nextTask();
  await nextTask();
  assert.equal(releaseCount, 1);
  assert.equal(factoryButton.activator.disabled, false);
  assert.equal(factoryButton.activator.click(), true);
  assert.equal(releaseCount, 1);
});

test("installer page includes all live monitor controls", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  for (const id of [
    "serial-connect",
    "serial-reset",
    "serial-copy",
    "serial-clear",
    "serial-disconnect",
    "serial-status",
    "serial-log",
  ]) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  assert.match(html, /id="serial-connect">Connect device<\/button>/);
  assert.match(html, /id="serial-reset" disabled>Reset device<\/button>/);
  assert.match(html, /id="serial-copy">Copy logs<\/button>/);
  assert.match(html, /<h2>Already commissioned<\/h2>/);
  assert.match(html, /The original QR cannot start pairing while BLE commissioning is closed/);
  assert.match(html, /use Factory install\s+if the device was deleted from that controller/);
});
