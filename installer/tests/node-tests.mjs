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

class FakeInstallButton extends EventTarget {
  constructor(eraseFirst) {
    super();
    this.attributes = new Map([
      ["erase-first", String(eraseFirst)],
      ["inert", ""],
    ]);
    this.activator = { disabled: true };
    this.inert = true;
  }

  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  querySelector(selector) { return selector === '[slot="activate"]' ? this.activator : null; }
}

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
