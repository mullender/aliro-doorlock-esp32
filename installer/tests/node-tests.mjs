import assert from "node:assert/strict";
import { readFileSync, mkdirSync, mkdtempSync, writeFileSync, rmSync, readdirSync, existsSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
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
import {
  attachUpdateDialogGuard,
  patchUpdateDialogShadow,
} from "../js/update-dialog-guard.js";
import { createSerialMonitor } from "../js/serial-monitor.js";
import { createDeviceSettings } from "../js/device-settings.js";
import {
  buildGetRequest,
  buildSetRequest,
  compareDevkitVersions,
  parseAliroProtocolLine,
  parseDevkitVersion,
} from "../js/device-protocol.js";
import {
  checkPreservingUpdate,
  getSupportedVariantIds,
  getVariant,
  selectFactoryVariant,
  __internals as matrixInternals,
} from "../js/firmware-matrix.js";
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
    this.attributes = new Map();
    this.disabled = false;
    this.textContent = "";
    this.scrollTop = 0;
    this.scrollHeight = 0;
  }

  click() {
    return this.dispatchEvent(new Event("click", { bubbles: true, cancelable: true }));
  }

  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
}

class FakeInstallButton extends EventTarget {
  constructor() {
    super();
    this.attributes = new Map([["inert", ""]]);
    this.activator = new FakeControl();
    this.activator.disabled = true;
    this.inert = true;
  }

  getAttribute(name) { return this.attributes.get(name) ?? null; }
  setAttribute(name, value) { this.attributes.set(name, String(value ?? "")); }
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
    connected: Object.assign(new FakeControl(), { hidden: true }),
    status: new FakeControl(),
    log: new FakeControl(),
  };
}

function fakeSerialPort({ openError } = {}) {
  let streamController;
  const writes = [];
  const readable = new ReadableStream({
    start(controller) { streamController = controller; },
  });
  const writable = new WritableStream({
    write(value) { writes.push(new TextDecoder().decode(value)); },
  });
  return {
    readable,
    writable,
    writes,
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

// Yields each queued chunk on its own read pass, then keeps subsequent reads
// pending. Used to drive parseMatterOnboardingCodes and the install
// controller's status capture through separate reader lifecycles.
function twoPassSerialPort(chunks) {
  const writes = [];
  const queue = [...chunks];
  const writable = new WritableStream({
    write(value) { writes.push(new TextDecoder().decode(value)); },
  });
  const readable = new ReadableStream({
    async pull(controller) {
      if (queue.length) {
        controller.enqueue(queue.shift());
      } else {
        await new Promise(() => {});
      }
    },
  });
  return { readable, writable, writes };
}

function createFakeElement(tagName) {
  const attrs = new Map();
  return {
    tagName: tagName.toUpperCase(),
    textContent: "",
    setAttribute(name, value) { attrs.set(name, String(value ?? "")); },
    getAttribute(name) { return attrs.get(name) ?? null; },
    hasAttribute(name) { return attrs.has(name); },
  };
}

function matchesSelector(node, selector) {
  const attributeMatch = selector.match(/^([a-z][\w-]*)?(?:\[([\w-]+)\])?$/i);
  if (!attributeMatch) return false;
  const [, tag, attr] = attributeMatch;
  if (tag && node.tagName !== tag.toUpperCase()) return false;
  if (attr && !node.hasAttribute?.(attr)) return false;
  return true;
}

function createFakeDocument() {
  const body = {
    children: [],
    _listeners: new Set(),
    appendChild(node) {
      body.children.push(node);
      for (const listener of body._listeners) listener([{ addedNodes: [node], removedNodes: [] }]);
      return node;
    },
    removeChild(node) {
      body.children = body.children.filter((child) => child !== node);
      for (const listener of body._listeners) listener([{ addedNodes: [], removedNodes: [node] }]);
      return node;
    },
    contains(node) { return body.children.includes(node); },
  };
  class FakeMutationObserver {
    constructor(callback) { this._callback = callback; this._connected = false; }
    observe(target) {
      if (target !== body) return;
      body._listeners.add(this._callback);
      this._connected = true;
    }
    disconnect() {
      if (this._connected) body._listeners.delete(this._callback);
      this._connected = false;
    }
  }
  return {
    body,
    MutationObserver: FakeMutationObserver,
    contains(node) { return body.contains(node); },
    createDialog({ manifestPath }) {
      const shadow = fakeShadowRoot({
        "ew-checkbox": [{
          tagName: "EW-CHECKBOX",
          checked: true,
          disabled: false,
        }],
      });
      return {
        tagName: "EWT-INSTALL-DIALOG",
        manifestPath,
        shadowRoot: shadow,
      };
    },
  };
}

function fakeShadowRoot(seededTemplates) {
  const children = [];
  for (const [selector, entries] of Object.entries(seededTemplates)) {
    for (const template of entries) {
      const node = { ...template };
      const attrs = new Map();
      if (selector.includes("[")) {
        const attr = selector.match(/\[([\w-]+)\]/)?.[1];
        if (attr) attrs.set(attr, "");
      }
      node.setAttribute = (name, value) => attrs.set(name, String(value ?? ""));
      node.getAttribute = (name) => attrs.get(name) ?? null;
      node.hasAttribute = (name) => attrs.has(name);
      children.push(node);
    }
  }
  return {
    _children: children,
    querySelector(selector) {
      return children.find((node) => matchesSelector(node, selector)) ?? null;
    },
    querySelectorAll(selector) {
      return children.filter((node) => matchesSelector(node, selector));
    },
    appendChild(node) { children.push(node); return node; },
    ownerDocument: {
      createElement: createFakeElement,
    },
  };
}

function fakeSettingsElements() {
  const control = () => new FakeControl();
  return {
    panel: Object.assign(control(), { hidden: true }),
    form: control(),
    autoLock: Object.assign(control(), { checked: false }),
    delay: Object.assign(control(), { value: "" }),
    successRgb: Object.assign(control(), { value: "" }),
    successMs: Object.assign(control(), { value: "" }),
    failureRgb: Object.assign(control(), { value: "" }),
    failureMs: Object.assign(control(), { value: "" }),
    otherRgb: Object.assign(control(), { value: "" }),
    otherMs: Object.assign(control(), { value: "" }),
    apply: control(),
    result: control(),
    installed: control(),
    latest: control(),
    current: Object.assign(control(), { hidden: true }),
    updateReason: control(),
    updateAction: Object.assign(control(), { hidden: false }),
  };
}

class FakeProtocolMonitor extends EventTarget {
  constructor() {
    super();
    this.writes = [];
  }

  async writeLine(line) {
    this.writes.push(line);
    return true;
  }
}

const VALID_STATUS = {
  firmware: "0.0.4-devkit",
  protocol: 1,
  // Phase 1A parser fills these when the device omits them (legacy 0.0.5
  // and older). Newer firmware announces the actual variant/transport.
  variant: "nanoc6-thread",
  transport: "thread",
  // Phase 1B safety-model additions. False when the STATUS line omitted
  // the field (legacy firmware); true when the device explicitly reported
  // the identifier over the wire.
  variantExplicit: false,
  transportExplicit: false,
  auto_relock_seconds: 10,
  success_rgb: "#00ff00",
  success_ms: 750,
  failure_rgb: "#ff0000",
  failure_ms: 900,
  other_rgb: "#0000ff",
  other_ms: 500,
};

// A modern device announces both fields explicitly. Tests that need the
// preserving-update guard to admit the status (device-settings latest-
// version fetch, controller enable path) use this fixture.
const EXPLICIT_STATUS = { ...VALID_STATUS, variantExplicit: true, transportExplicit: true };

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
    commissionedGuidance: fakeElement(),
    fabricDetails: fakeElement(),
    fabricList: fakeElement(),
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
  assert.deepEqual(detailsOnly.fabrics, [detailsOnly.fabric]);

  const commissioned = parseOnboardingText(
    `${fabricLine}\nI (843) chip[SVR]: Fabric already commissioned. Disabling BLE advertisement`,
  );
  assert.equal(commissioned.commissioned, true);
  assert.deepEqual(commissioned.fabric, detailsOnly.fabric);
  assert.deepEqual(commissioned.fabrics, [detailsOnly.fabric]);

  const similarText = parseOnboardingText("I chip[SVR]: Fabric is already commissioned");
  assert.equal(similarText.commissioned, undefined);
});

test("boot parser retains unique fabrics and keeps the single-fabric alias", () => {
  const appleHome = "I chip[FP]: Fabric index 0x1 was retrieved from storage. " +
    "Compressed FabricId 0xAA, FabricId 0x10, NodeId 0x20, VendorId 0x1349";
  const appleKeychain = "I chip[FP]: Fabric index 0x2 was retrieved from storage. " +
    "Compressed FabricId 0xBB, FabricId 0x11, NodeId 0x21, VendorId 0x1384";
  const first = parseOnboardingText(appleHome);
  const parsed = parseOnboardingText([
    appleHome.toLowerCase(),
    appleKeychain,
    "I chip[SVR]: Fabric already commissioned. Disabling BLE advertisement",
  ].join("\n"), first);

  assert.equal(parsed.commissioned, true);
  assert.equal(parsed.fabrics.length, 2);
  assert.deepEqual(parsed.fabrics[0], first.fabric);
  assert.deepEqual(parsed.fabric, parsed.fabrics[1]);
  assert.equal(parsed.fabric.vendorId, "0x1384");

  const legacyState = parseOnboardingText(
    "I chip[SVR]: Fabric already commissioned. Disabling BLE advertisement",
    { fabric: first.fabric },
  );
  assert.deepEqual(legacyState.fabric, first.fabric);
  assert.deepEqual(legacyState.fabrics, [first.fabric]);
});

test("serial parser returns commissioned before later QR lines", async () => {
  const readable = textStream([
    "I chip[FP]: Fabric index 0x1 was retrieved from storage. Compressed FabricId 0xBB, " +
      "FabricId 0x0000000000000041, NodeId 0x0000000000000098, VendorId 0x1349",
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
    fabrics: [
      {
        fabricIndex: "0x1",
        fabricId: "0x0000000000000041",
        nodeId: "0x0000000000000098",
        vendorId: "0x1349",
      },
      {
        fabricIndex: "0x2",
        fabricId: "0x0000000000000042",
        nodeId: "0x0000000000000099",
        vendorId: "0xFFF1",
      },
    ],
    source: "boot",
  });
  assert.equal(readable.locked, false);
});

test("serial parser does not retain a vendor ID from a partial line", async () => {
  const readable = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(
        "I chip[FP]: Fabric index 0x1 was retrieved from storage. Compressed FabricId 0xAA, " +
        "FabricId 0x10, NodeId 0x20, VendorId 0x13",
      ));
      controller.enqueue(new TextEncoder().encode(
        "49\nI chip[SVR]: Fabric already commissioned. Disabling BLE advertisement\n",
      ));
      controller.close();
    },
  });
  const result = await parseMatterOnboardingCodes(
    { readable },
    { timeoutMs: 100, requestReset: false },
  );

  assert.equal(result.fabrics.length, 1);
  assert.equal(result.fabrics[0].vendorId, "0x1349");
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

test("commissioned state accepts one fabric and shows its raw values", () => {
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
  assert.match(elements.commissionedGuidance.innerHTML, /Other Matter service/);
  assert.match(elements.fabricList.innerHTML, /0x0000000000000001/);
  assert.match(elements.fabricList.innerHTML, /0x0000000000000002/);
  assert.match(elements.fabricList.innerHTML, /0xFFF1/);
  assert.deepEqual(flow.getCurrent().mt, null);
});

test("commissioned guidance maps services and combines Apple instructions", () => {
  const { flow, elements } = fakeFlow();
  flow.showCommissioned([
    { fabricIndex: "0x1", fabricId: "0x10", nodeId: "0x20", vendorId: "0x1349" },
    { fabricIndex: "0x2", fabricId: "0x11", nodeId: "0x21", vendorId: "0x1384" },
    { fabricIndex: "0x3", fabricId: "0x12", nodeId: "0x22", vendorId: "0x6006" },
    { fabricIndex: "0x4", fabricId: "0x13", nodeId: "0x23", vendorId: "0x134B" },
    { fabricIndex: "0x5", fabricId: "0x14", nodeId: "0x24", vendorId: "0xABCD" },
  ]);

  const guidance = elements.commissionedGuidance.innerHTML;
  assert.equal((guidance.match(/Turn On Pairing Mode/g) || []).length, 1);
  assert.match(guidance, /Apple Home and Apple Keychain/);
  assert.match(guidance, /Google LLC/);
  assert.match(guidance, /Home Assistant \(Open Home Foundation\)/);
  assert.match(guidance, /Settings &gt; Matter &gt; Add device/);
  assert.match(guidance, /Yes, it is already in use/);
  assert.match(guidance, /Other Matter service/);
  assert.match(guidance, /0xABCD/);
  assert.equal((elements.fabricList.innerHTML.match(/class="fabric-record"/g) || []).length, 5);
  assert.match(elements.fabricList.innerHTML, /0x1349/);
  assert.match(elements.fabricList.innerHTML, /0x1384/);
});

test("factory button enables at boot; update button stays inert until STATUS is eligible", () => {
  const factoryButton = new FakeInstallButton();
  const updateButton = new FakeInstallButton();
  const serialMonitor = new FakeProtocolMonitor();
  const setupFlow = {
    begin: () => new AbortController().signal,
    finish() {},
    finishPreservedUpdate() {},
  };
  configureInstallButtons({
    factoryButton,
    updateButton,
    setupFlow,
    serialMonitor,
    attachDialogGuard: () => ({ disconnect() {} }),
  });
  assert.equal(factoryButton.inert, false, "factory button un-inerted at boot");
  assert.equal(factoryButton.activator.disabled, false);
  assert.equal(factoryButton.getAttribute("inert"), null);
  assert.equal(factoryButton.manifest, "manifest-nanoc6-thread.json",
    "factory button gets the default variant's manifest");

  assert.equal(updateButton.inert, true, "update button stays inert until STATUS");
  assert.equal(updateButton.activator.disabled, true);
  assert.equal(updateButton.getAttribute("inert"), "");
  assert.equal(updateButton.manifest ?? null, null,
    "update button starts with no usable manifest");

  serialMonitor.dispatchEvent(new CustomEvent("aliro-status", {
    detail: { ...EXPLICIT_STATUS, variant: "nanoc6-thread", transport: "thread" },
  }));
  assert.equal(updateButton.inert, false, "eligible STATUS un-inerts the update button");
  assert.equal(updateButton.activator.disabled, false);
  assert.equal(updateButton.manifest, "manifest-update-nanoc6-thread.json");
});

test("installer page starts install buttons disabled and inert", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html,
    /id="update-button"[\s\S]*?inert>[\s\S]*?<button slot="activate" disabled>/);
  assert.match(html,
    /id="factory-button"[\s\S]*?inert>[\s\S]*?<button slot="activate" disabled>/);
  // The installer no longer carries fork-only APIs: the erase-first
  // attribute is unused by upstream ESP Web Tools and has been removed.
  assert.doesNotMatch(html, /erase-first=/);
});

test("factory post-flash reads setup codes with the passed serial port", async () => {
  const factoryButton = new FakeInstallButton();
  const updateButton = new FakeInstallButton();
  let parseCount = 0;
  let capturedPort = null;
  let capturedOpts = null;
  let factoryFinished;
  let updatePreserved = false;
  const abortController = new AbortController();
  const setupFlow = {
    begin: () => abortController.signal,
    finish: (result) => { factoryFinished = result; },
    finishPreservedUpdate: () => { updatePreserved = true; },
  };
  configureInstallButtons({
    factoryButton,
    updateButton,
    setupFlow,
    parseCodes: async (port, opts) => {
      parseCount += 1;
      capturedPort = port;
      capturedOpts = opts;
      return { ok: true, mt: "MT:Y.K9042C00KA0648G00", manualCode: "34970112332" };
    },
  });

  const port = { readable: {} };
  await factoryButton.onPostFlash(port);
  assert.equal(parseCount, 1);
  assert.equal(capturedPort, port);
  assert.equal(capturedOpts.signal, abortController.signal);
  assert.equal(capturedOpts.requestReemit, false);
  assert.equal(factoryFinished.ok, true);
  assert.equal(updatePreserved, false);

  await updateButton.onPostFlash(port);
  assert.equal(parseCount, 1);
  assert.equal(updatePreserved, true);
});

test("factory post-flash populates the QR panel through setup flow", async () => {
  const factoryButton = new FakeInstallButton();
  const updateButton = new FakeInstallButton();
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

  await factoryButton.onPostFlash({ readable: {} });
  assert.equal(elements.pairing.getAttribute("aria-hidden"), "false");
  assert.equal(elements.qrCaption.textContent, "MT:Y.K9042C00KA0648G00");
});

test("update post-flash sets the preserved-update status", async () => {
  const factoryButton = new FakeInstallButton();
  const updateButton = new FakeInstallButton();
  const { flow, elements } = fakeFlow();
  configureInstallButtons({ factoryButton, updateButton, setupFlow: flow });
  flow.showPairing("MT:Y.K9042C00KA0648G00", "34970112332");

  await updateButton.onPostFlash({ readable: {} });
  assert.equal(elements.pairing.getAttribute("aria-hidden"), "true");
  assert.equal(elements.status.textContent,
    "Update complete. Setup data was kept. Wait for the lock to reconnect to Matter and Thread.");
});

test("factory post-flash surfaces parser failures without leaking codes", async () => {
  const factoryButton = new FakeInstallButton();
  const updateButton = new FakeInstallButton();
  const { flow, elements } = fakeFlow();
  flow.showPairing("MT:Y.K9042C00KA0648G00", "34970112332");
  configureInstallButtons({
    factoryButton,
    updateButton,
    setupFlow: flow,
    logger: { log() {}, error() {} },
    parseCodes: async () => { throw new Error("boom"); },
  });

  await factoryButton.onPostFlash({ readable: {} });
  assert.equal(elements.pairing.getAttribute("aria-hidden"), "true");
  assert.equal(flow.getCurrent().mt, null);
  assert.match(elements.status.textContent, /serial read failed/i);
});

test("preserved update hides pairing data and emits an update-complete event", () => {
  const { flow, elements, eventTarget } = fakeFlow();
  let detail;
  eventTarget.addEventListener("install-update-complete", (event) => { detail = event.detail; });
  flow.showPairing("MT:Y.K9042C00KA0648G00", "34970112332");
  flow.finishPreservedUpdate();
  assert.equal(elements.pairing.getAttribute("aria-hidden"), "true");
  assert.equal(flow.getCurrent().mt, null);
  assert.deepEqual(detail, { installMode: "update" });
});

test("update-dialog guard forces keep-setup on the ASK_ERASE render", () => {
  const shadowRoot = fakeShadowRoot({
    "ew-checkbox": [{
      tagName: "EW-CHECKBOX",
      checked: true,
      disabled: false,
    }],
  });
  assert.equal(patchUpdateDialogShadow(shadowRoot), true);
  const checkbox = shadowRoot.querySelector("ew-checkbox");
  assert.equal(checkbox.checked, false);
  assert.equal(checkbox.disabled, true);
  const style = shadowRoot.querySelector("style[data-aliro-update-guard]");
  assert.ok(style);
  assert.match(style.textContent, /label\.formfield \{ display: none/);

  // A second pass never appends a duplicate style tag.
  assert.equal(patchUpdateDialogShadow(shadowRoot), true);
  assert.equal(shadowRoot.querySelectorAll("style[data-aliro-update-guard]").length, 1);
});

test("update-dialog guard is a no-op before the erase step renders", () => {
  const shadowRoot = fakeShadowRoot({});
  assert.equal(patchUpdateDialogShadow(shadowRoot), false);
  assert.ok(shadowRoot.querySelector("style[data-aliro-update-guard]"));
});

test("attachUpdateDialogGuard scopes patches by dialog manifestPath", async () => {
  const doc = createFakeDocument();
  const updateManifest = "./manifest-update.json";
  attachUpdateDialogGuard({
    updateManifestPath: updateManifest,
    doc,
    observerFactory: doc.MutationObserver,
  });

  const factoryDialog = doc.createDialog({ manifestPath: "./manifest.json" });
  doc.body.appendChild(factoryDialog);
  assert.equal(factoryDialog.shadowRoot.querySelectorAll("style[data-aliro-update-guard]").length, 0);
  assert.equal(factoryDialog.shadowRoot.querySelector("ew-checkbox").disabled, false);
  doc.body.removeChild(factoryDialog);

  const updateDialog = doc.createDialog({ manifestPath: updateManifest });
  doc.body.appendChild(updateDialog);
  assert.equal(updateDialog.shadowRoot.querySelectorAll("style[data-aliro-update-guard]").length, 1);
  assert.equal(updateDialog.shadowRoot.querySelector("ew-checkbox").disabled, true);
  assert.equal(updateDialog.shadowRoot.querySelector("ew-checkbox").checked, false);
});

test("attachUpdateDialogGuard ignores a Factory dialog opened after a canceled Update", async () => {
  const doc = createFakeDocument();
  const updateManifest = "./manifest-update.json";
  attachUpdateDialogGuard({
    updateManifestPath: updateManifest,
    doc,
    observerFactory: doc.MutationObserver,
  });

  const updateDialog = doc.createDialog({ manifestPath: updateManifest });
  doc.body.appendChild(updateDialog);
  assert.equal(updateDialog.shadowRoot.querySelector("ew-checkbox").disabled, true);
  doc.body.removeChild(updateDialog);

  const factoryDialog = doc.createDialog({ manifestPath: "./manifest.json" });
  doc.body.appendChild(factoryDialog);
  assert.equal(
    factoryDialog.shadowRoot.querySelectorAll("style[data-aliro-update-guard]").length,
    0,
    "factory dialog must never be patched",
  );
  assert.equal(factoryDialog.shadowRoot.querySelector("ew-checkbox").disabled, false);
  assert.equal(factoryDialog.shadowRoot.querySelector("ew-checkbox").checked, true);
});

test("factory callback populates device settings and releases both stream locks", async () => {
  const factoryButton = new FakeInstallButton();
  const updateButton = new FakeInstallButton();
  const settingsCalls = [];
  const deviceSettings = {
    applyStatus(status) { settingsCalls.push(status); },
  };
  const bootLog = new TextEncoder().encode(
    "I chip[SVR]: SetupQRCode: [MT:Y.K9042C00KA0648G00]\n" +
    "I chip[SVR]: Manual pairing code: [34970112332]\n",
  );
  const statusLine = new TextEncoder().encode(
    "ALIRO/1 STATUS firmware=0.0.4-devkit protocol=1 " +
    "auto_relock_seconds=10 success_rgb=00FF00 success_ms=750 " +
    "failure_rgb=ff0000 failure_ms=900 other_rgb=0000ff other_ms=500\n",
  );
  const port = twoPassSerialPort([bootLog, statusLine]);
  configureInstallButtons({
    factoryButton,
    updateButton,
    setupFlow: {
      begin: () => new AbortController().signal,
      finish() {},
      finishPreservedUpdate() {},
    },
    deviceSettings,
    logger: { log() {}, error() {} },
    attachDialogGuard: () => {},
    statusTimeoutMs: 200,
  });

  await factoryButton.onPostFlash(port);

  assert.equal(settingsCalls.length, 1);
  assert.equal(settingsCalls[0].firmware, "0.0.4-devkit");
  assert.equal(settingsCalls[0].auto_relock_seconds, 10);
  assert.equal(port.readable.locked, false);
  assert.equal(port.writable.locked, false);
});

test("factory callback still releases locks when settings capture times out", async () => {
  const factoryButton = new FakeInstallButton();
  const updateButton = new FakeInstallButton();
  const settingsCalls = [];
  const deviceSettings = { applyStatus(status) { settingsCalls.push(status); } };
  const bootLog = new TextEncoder().encode(
    "I chip[SVR]: SetupQRCode: [MT:Y.K9042C00KA0648G00]\n" +
    "I chip[SVR]: Manual pairing code: [34970112332]\n",
  );
  const port = twoPassSerialPort([bootLog]);
  configureInstallButtons({
    factoryButton,
    updateButton,
    setupFlow: {
      begin: () => new AbortController().signal,
      finish() {},
      finishPreservedUpdate() {},
    },
    deviceSettings,
    logger: { log() {}, error() {} },
    attachDialogGuard: () => {},
    statusTimeoutMs: 30,
  });

  await factoryButton.onPostFlash(port);

  assert.equal(settingsCalls.length, 0);
  assert.equal(port.readable.locked, false);
  assert.equal(port.writable.locked, false);
  assert.deepEqual(port.writes, [`${buildGetRequest()}\n`]);
});

test("captureDeviceStatus reads a STATUS enqueued right after GET", async () => {
  const factoryButton = new FakeInstallButton();
  const updateButton = new FakeInstallButton();
  const settingsCalls = [];
  const writes = [];
  let readerRequested = false;
  let streamController;
  const readable = new ReadableStream({
    start(controller) { streamController = controller; },
  });
  const writable = new WritableStream({
    write(chunk) {
      writes.push(new TextDecoder().decode(chunk));
      // The device sends STATUS the instant it receives GET.
      streamController.enqueue(new TextEncoder().encode(
        "ALIRO/1 STATUS firmware=0.0.4-devkit protocol=1 " +
        "auto_relock_seconds=10 success_rgb=00FF00 success_ms=750 " +
        "failure_rgb=ff0000 failure_ms=900 other_rgb=0000ff other_ms=500\n",
      ));
      readerRequested = true;
    },
  });
  const port = { readable, writable };

  configureInstallButtons({
    factoryButton,
    updateButton,
    setupFlow: {
      begin: () => new AbortController().signal,
      finish() {},
      finishPreservedUpdate() {},
    },
    deviceSettings: { applyStatus(s) { settingsCalls.push(s); } },
    parseCodes: async () => ({ ok: true, mt: "MT:Y.K9042C00KA0648G00", manualCode: "34970112332" }),
    logger: { log() {}, error() {} },
    attachDialogGuard: () => {},
    statusTimeoutMs: 300,
  });

  await factoryButton.onPostFlash(port);

  assert.deepEqual(writes, [`${buildGetRequest()}\n`]);
  assert.equal(readerRequested, true);
  assert.equal(settingsCalls.length, 1);
  assert.equal(settingsCalls[0].firmware, "0.0.4-devkit");
  assert.equal(readable.locked, false);
  assert.equal(writable.locked, false);
});

test("captureDeviceStatus timeout releases the lock without canceling the stream", async () => {
  const factoryButton = new FakeInstallButton();
  const updateButton = new FakeInstallButton();
  let streamController;
  const readable = new ReadableStream({
    start(controller) { streamController = controller; },
    cancel() { readable._cancelled = true; },
  });
  const writes = [];
  const writable = new WritableStream({
    write(chunk) { writes.push(new TextDecoder().decode(chunk)); },
  });
  const port = { readable, writable };

  configureInstallButtons({
    factoryButton,
    updateButton,
    setupFlow: {
      begin: () => new AbortController().signal,
      finish() {},
      finishPreservedUpdate() {},
    },
    deviceSettings: { applyStatus() {} },
    parseCodes: async () => ({ ok: true, mt: "MT:Y.K9042C00KA0648G00", manualCode: "34970112332" }),
    logger: { log() {}, error() {} },
    attachDialogGuard: () => {},
    statusTimeoutMs: 20,
  });

  await factoryButton.onPostFlash(port);

  assert.deepEqual(writes, [`${buildGetRequest()}\n`]);
  assert.equal(readable.locked, false);
  assert.notEqual(readable._cancelled, true);
  // A later reader can still read from the stream.
  streamController.enqueue(new TextEncoder().encode("later bytes"));
  const laterReader = readable.getReader();
  const laterResult = await laterReader.read();
  assert.equal(laterResult.done, false);
  assert.equal(new TextDecoder().decode(laterResult.value), "later bytes");
  laterReader.releaseLock();
});

test("older ESP Web Tools that ignores onPostFlash falls back to the serial monitor", async () => {
  const factoryButton = new FakeInstallButton();
  const updateButton = new FakeInstallButton();
  configureInstallButtons({
    factoryButton,
    updateButton,
    setupFlow: {
      begin: () => new AbortController().signal,
      finish() {},
      finishPreservedUpdate() {},
    },
    parseCodes: async () => ({ ok: true, mt: "MT:Y.K9042C00KA0648G00", manualCode: "34970112332" }),
    attachDialogGuard: () => {},
  });
  assert.equal(typeof factoryButton.onPostFlash, "function");
  assert.equal(typeof updateButton.onPostFlash, "function");

  const serialPort = fakeSerialPort();
  const monitorElements = fakeMonitorElements();
  const settingsElements = fakeSettingsElements();
  const { flow, elements } = fakeFlow();
  const monitor = createSerialMonitor({
    elements: monitorElements,
    setupFlow: flow,
    serial: new FakeSerial([], [serialPort]),
    secureContext: true,
    resetPulseMs: 0,
  });
  const settings = createDeviceSettings({
    elements: settingsElements,
    serialMonitor: monitor,
    fetchImpl: async () => ({ ok: true, json: async () => ({ version: "0.0.4-devkit" }) }),
  });

  await nextTask();
  await nextTask();
  serialPort.streamController.enqueue(new TextEncoder().encode(
    "I chip[SVR]: SetupQRCode: [MT:Y.K9042C00KA0648G00]\n" +
    "I chip[SVR]: Manual pairing code: [34970112332]\n" +
    "ALIRO/1 STATUS firmware=0.0.4-devkit protocol=1 " +
    "auto_relock_seconds=10 success_rgb=00FF00 success_ms=750 " +
    "failure_rgb=ff0000 failure_ms=900 other_rgb=0000ff other_ms=500\n",
  ));
  await nextTask();

  assert.equal(elements.pairing.getAttribute("aria-hidden"), "false");
  assert.equal(settingsElements.panel.hidden, false);
  assert.equal(settingsElements.installed.textContent, "0.0.4-devkit");

  settings.destroy();
  await monitor.destroy();
});

test("Aliro protocol parses complete status and error lines", () => {
  const line = "ALIRO/1 STATUS firmware=0.0.4-devkit protocol=1 " +
    "auto_relock_seconds=10 success_rgb=00FF00 success_ms=750 " +
    "failure_rgb=ff0000 failure_ms=900 other_rgb=0000ff other_ms=500";
  assert.deepEqual(parseAliroProtocolLine(line), { type: "status", status: VALID_STATUS });
  assert.deepEqual(parseAliroProtocolLine("ALIRO/1 ERROR code=invalid_value"), {
    type: "error",
    code: "invalid_value",
  });
  assert.equal(parseAliroProtocolLine(`log: ${line}`), null);
  assert.equal(parseAliroProtocolLine(line.replace(" protocol=1", "")).type, "invalid-status");
  assert.equal(parseAliroProtocolLine(line.replace(" protocol=1", " protocol=2")).type,
    "invalid-status");
  assert.equal(parseAliroProtocolLine(
    line.replace("auto_relock_seconds=10", "auto_relock_seconds=3601"),
  ).type, "invalid-status");
  assert.equal(parseAliroProtocolLine(
    line.replace("success_ms=750", "success_ms=10001"),
  ).type, "invalid-status");
  assert.equal(parseAliroProtocolLine(`${line} future_field=1  `).type, "status");
});

test("Aliro protocol parses additive variant and transport fields", () => {
  const base = "ALIRO/1 STATUS firmware=0.0.6-devkit protocol=1 " +
    "auto_relock_seconds=10 success_rgb=00FF00 success_ms=750 " +
    "failure_rgb=ff0000 failure_ms=900 other_rgb=0000ff other_ms=500";

  // Legacy firmware (pre-Phase-1) does not emit variant/transport.
  // The parser fills the legacy defaults so the caller can still
  // distinguish variants.
  const legacy = parseAliroProtocolLine(base);
  assert.equal(legacy.type, "status");
  assert.equal(legacy.status.variant, "nanoc6-thread");
  assert.equal(legacy.status.transport, "thread");

  const wifi = parseAliroProtocolLine(`${base} variant=nanoc6-wifi transport=wifi`);
  assert.equal(wifi.type, "status");
  assert.equal(wifi.status.variant, "nanoc6-wifi");
  assert.equal(wifi.status.transport, "wifi");

  const atoms3 = parseAliroProtocolLine(`${base} variant=atoms3-lite-wifi transport=wifi`);
  assert.equal(atoms3.status.variant, "atoms3-lite-wifi");

  // Invalid variant / transport values are rejected so the caller
  // never surfaces a garbage identifier.
  assert.equal(
    parseAliroProtocolLine(`${base} variant=BAD transport=wifi`).type,
    "invalid-status",
  );
  assert.equal(
    parseAliroProtocolLine(`${base} variant=nanoc6-wifi transport=Wi_Fi`).type,
    "invalid-status",
  );
});

test("firmware variants.json shape stays coherent", () => {
  const variants = JSON.parse(
    readFileSync(new URL("../../firmware/variants.json", import.meta.url), "utf8"),
  );
  const required = [
    "id", "project_name", "chip", "chip_family", "transport",
    "base_sdkconfig", "base_sdkconfig_source", "release_overlay",
    "source_patches", "dependency_patches", "board_config_header",
    "nfc_sda_gpio", "nfc_scl_gpio", "rgb_data_gpio", "has_rgb_power_pin",
  ];
  const seenProjectNames = new Set();
  for (const [variantId, entry] of Object.entries(variants.variants || {})) {
    for (const key of required) {
      assert.ok(entry[key] !== undefined,
        `variant ${variantId} is missing required field ${key}`);
    }
    assert.equal(entry.id, variantId, `variant ${variantId} id must match its key`);
    assert.ok(!seenProjectNames.has(entry.project_name),
      `project_name ${entry.project_name} is reused across variants`);
    seenProjectNames.add(entry.project_name);
    if (entry.has_rgb_power_pin) {
      assert.equal(typeof entry.rgb_power_gpio, "number",
        `${variantId} claims a power pin but rgb_power_gpio is not a number`);
    } else {
      assert.equal(entry.rgb_power_gpio, null,
        `${variantId} has no power pin, so rgb_power_gpio must be null`);
    }
    // Both NanoC6 variants share the same NFC unit wiring.
    assert.equal(entry.nfc_sda_gpio, 2, `${variantId} NFC SDA should be GPIO 2`);
    assert.equal(entry.nfc_scl_gpio, 1, `${variantId} NFC SCL should be GPIO 1`);
    // If partition_table_sha256 is set, it must be a 64-character
    // lowercase hex string (SHA-256). This assertion pairs with the
    // packager's fail-closed check that rejects a null hash — an
    // approved hash must be verifiable as a well-formed digest before
    // release.
    if (entry.partition_table_sha256 !== null && entry.partition_table_sha256 !== undefined) {
      assert.match(entry.partition_table_sha256, /^[0-9a-f]{64}$/,
        `${variantId} partition_table_sha256 must be a 64-char lowercase hex SHA-256`);
    }
  }
  // Phase 1A ships exactly these three variants.
  assert.deepEqual(
    Object.keys(variants.variants || {}).sort(),
    ["atoms3-lite-wifi", "nanoc6-thread", "nanoc6-wifi"],
  );
});

test("Aliro protocol builds safe GET and partial SET requests", () => {
  assert.equal(buildGetRequest(), "ALIRO/1 GET");
  assert.equal(buildSetRequest({
    auto_relock_seconds: 0,
    success_rgb: "#12AbEF",
    success_ms: 250,
  }), "ALIRO/1 SET auto_relock_seconds=0 success_rgb=12abef success_ms=250");
  assert.throws(() => buildSetRequest({ success_rgb: "red" }), /six-digit RGB/);
  assert.throws(() => buildSetRequest({ success_ms: -1 }), /whole number|from 0/);
  assert.throws(() => buildSetRequest({ auto_relock_seconds: 3601 }), /from 0 to 3600/);
  assert.throws(() => buildSetRequest({ success_ms: 10001 }), /from 0 to 10000/);
  assert.throws(() => buildSetRequest({ unknown: 1 }), /not supported/);
});

test("devkit versions compare after release-tag normalization", () => {
  assert.equal(compareDevkitVersions("0.0.4-devkit", "aliro-c6-v0.0.4-devkit"), 0);
  assert.equal(compareDevkitVersions("0.0.3-devkit", "v0.0.4-devkit"), -1);
  assert.equal(compareDevkitVersions("0.1.0-devkit", "0.0.4-devkit"), 1);
  assert.equal(compareDevkitVersions("unreleased", "0.0.4-devkit"), null);
});

test("device settings stay hidden until a valid status and confirm one SET line", async () => {
  const elements = fakeSettingsElements();
  const serialMonitor = new FakeProtocolMonitor();
  const fetchCalls = [];
  const settings = createDeviceSettings({
    elements,
    serialMonitor,
    fetchImpl: async (url) => {
      fetchCalls.push(url);
      return { ok: true, json: async () => ({ version: "aliro-c6-v0.0.4-devkit" }) };
    },
  });
  await nextTask();

  assert.equal(elements.panel.hidden, true);
  assert.deepEqual(fetchCalls, [], "no manifest fetch before identity is known");
  serialMonitor.dispatchEvent(new CustomEvent("serial-connected"));
  await nextTask();
  assert.deepEqual(serialMonitor.writes, ["ALIRO/1 GET"]);
  serialMonitor.dispatchEvent(new CustomEvent("aliro-status", { detail: EXPLICIT_STATUS }));
  await nextTask();
  assert.equal(elements.panel.hidden, false);
  assert.equal(elements.installed.textContent, "0.0.4-devkit");
  assert.equal(elements.latest.textContent, "0.0.4-devkit");
  assert.equal(elements.current.hidden, false);
  assert.equal(elements.updateAction.hidden, true);
  assert.deepEqual(fetchCalls, ["manifest-update-nanoc6-thread.json"],
    "device-settings fetches only the eligible variant's manifest");

  elements.autoLock.checked = false;
  elements.autoLock.dispatchEvent(new Event("change"));
  elements.form.dispatchEvent(new Event("submit", { cancelable: true }));
  await nextTask();
  assert.equal(serialMonitor.writes[1], "ALIRO/1 SET auto_relock_seconds=0");
  serialMonitor.dispatchEvent(new CustomEvent("aliro-status", {
    detail: { ...EXPLICIT_STATUS, auto_relock_seconds: 0 },
  }));
  assert.equal(elements.result.textContent, "Settings saved.");
  assert.match(elements.result.className, /success/);
  settings.destroy();
});

test("older or unknown latest firmware keeps the update action visible", async () => {
  const cases = [
    {
      installed: "0.0.3-devkit",
      manifest: { version: "0.0.4-devkit" },
      reason: /available/,
    },
    {
      installed: "0.0.4-devkit",
      manifest: { version: "unreleased" },
      reason: /could not be compared/,
    },
  ];
  for (const testCase of cases) {
    const elements = fakeSettingsElements();
    const serialMonitor = new FakeProtocolMonitor();
    const settings = createDeviceSettings({
      elements,
      serialMonitor,
      fetchImpl: async () => ({ json: async () => testCase.manifest }),
    });
    await nextTask();
    serialMonitor.dispatchEvent(new CustomEvent("aliro-status", {
      detail: { ...EXPLICIT_STATUS, firmware: testCase.installed },
    }));
    await nextTask();
    assert.equal(elements.updateAction.hidden, false, testCase.installed);
    assert.match(elements.updateReason.textContent, testCase.reason, testCase.installed);
    settings.destroy();
  }
});

test("newer installed firmware hides the downgrade action", async () => {
  const elements = fakeSettingsElements();
  const serialMonitor = new FakeProtocolMonitor();
  const settings = createDeviceSettings({
    elements,
    serialMonitor,
    fetchImpl: async () => ({ json: async () => ({ version: "0.0.4-devkit" }) }),
  });
  await nextTask();
  serialMonitor.dispatchEvent(new CustomEvent("aliro-status", {
    detail: { ...EXPLICIT_STATUS, firmware: "0.0.5-devkit" },
  }));
  await nextTask();
  assert.equal(elements.updateAction.hidden, true);
  assert.match(elements.current.textContent, /newer than the latest release/);
  settings.destroy();
});

test("settings writes wait for confirmation and recover from errors", async () => {
  const elements = fakeSettingsElements();
  const serialMonitor = new FakeProtocolMonitor();
  const settings = createDeviceSettings({
    elements,
    serialMonitor,
    confirmationTimeoutMs: 5,
    fetchImpl: async () => ({ json: async () => ({ version: "0.0.4-devkit" }) }),
  });
  await nextTask();
  serialMonitor.dispatchEvent(new CustomEvent("aliro-status", { detail: VALID_STATUS }));
  elements.successMs.value = "751";
  elements.form.dispatchEvent(new Event("submit", { cancelable: true }));
  await nextTask();

  assert.equal(elements.apply.disabled, true);
  assert.equal(elements.form.getAttribute("aria-busy"), "true");
  assert.match(elements.result.textContent, /Waiting for the device/);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(elements.apply.disabled, false);
  assert.equal(elements.form.getAttribute("aria-busy"), "false");
  assert.match(elements.result.textContent, /did not confirm/);

  elements.form.dispatchEvent(new Event("submit", { cancelable: true }));
  await nextTask();
  serialMonitor.dispatchEvent(new CustomEvent("aliro-error", {
    detail: { type: "error", code: "storage" },
  }));
  assert.equal(elements.apply.disabled, false);
  assert.equal(elements.result.textContent, "Settings were not saved: storage.");

  serialMonitor.dispatchEvent(new CustomEvent("serial-disconnected"));
  assert.equal(elements.panel.hidden, true);
  assert.equal(elements.apply.disabled, true);
  settings.destroy();
});

test("applyStatus shows values read-only and refuses submit until reconnect", async () => {
  const elements = fakeSettingsElements();
  const serialMonitor = new FakeProtocolMonitor();
  const settings = createDeviceSettings({
    elements,
    serialMonitor,
    fetchImpl: async () => ({ json: async () => ({ version: "0.0.4-devkit" }) }),
  });
  await nextTask();

  settings.applyStatus(VALID_STATUS);
  assert.equal(elements.panel.hidden, false);
  assert.equal(elements.installed.textContent, "0.0.4-devkit");
  assert.equal(elements.successMs.value, "750");
  assert.equal(elements.apply.disabled, true, "Apply must stay disabled while read-only");
  assert.match(elements.result.textContent, /Values read from the flash callback/);

  elements.form.dispatchEvent(new Event("submit", { cancelable: true }));
  await nextTask();
  assert.match(elements.result.textContent, /Use Connect device above/);
  assert.equal(serialMonitor.writes.length, 0, "no SET line is sent while read-only");

  settings.destroy();
});

test("serial-connected clears the read-only lock and reopens the settings for editing", async () => {
  const elements = fakeSettingsElements();
  const serialMonitor = new FakeProtocolMonitor();
  const settings = createDeviceSettings({
    elements,
    serialMonitor,
    fetchImpl: async () => ({ json: async () => ({ version: "0.0.4-devkit" }) }),
  });
  await nextTask();

  settings.applyStatus(VALID_STATUS);
  assert.equal(elements.apply.disabled, true);

  serialMonitor.dispatchEvent(new CustomEvent("serial-connected"));
  await nextTask();
  assert.equal(elements.apply.disabled, false, "Apply becomes usable after the monitor claims the port");
  assert.equal(elements.result.textContent, "");
  assert.deepEqual(serialMonitor.writes, ["ALIRO/1 GET"]);

  serialMonitor.dispatchEvent(new CustomEvent("aliro-status", {
    detail: { ...VALID_STATUS, success_ms: 751 },
  }));
  elements.successMs.value = "752";
  elements.form.dispatchEvent(new Event("submit", { cancelable: true }));
  await nextTask();
  assert.equal(serialMonitor.writes[1], "ALIRO/1 SET success_ms=752");

  settings.destroy();
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
    { dataTerminalReady: false, requestToSend: true },
    { dataTerminalReady: false, requestToSend: false },
  ]);
  assert.equal(serialPort.closeCalls, 1);
  assert.equal(serialPort.readable.locked, false);
  assert.equal(monitor.isActive(), false);
  assert.equal(monitorElements.status.textContent,
    "Serial monitor disconnected for install. Click the install button again to continue.");
});

test("serial monitor emits protocol events and serializes safe line writes", async () => {
  const serialPort = fakeSerialPort();
  const elements = fakeMonitorElements();
  const monitor = createSerialMonitor({
    elements,
    setupFlow: { showPairing: () => true },
    serial: new FakeSerial([serialPort]),
    secureContext: true,
    resetPulseMs: 0,
  });
  let status;
  monitor.addEventListener("aliro-status", (event) => { status = event.detail; });

  assert.equal(await monitor.connect(), true);
  assert.equal(elements.connected.hidden, false);
  serialPort.streamController.enqueue(new TextEncoder().encode(
    "ALIRO/1 STATUS firmware=0.0.4-devkit protocol=1 " +
    "auto_relock_seconds=10 success_rgb=00ff00 success_ms=750 " +
    "failure_rgb=ff0000 failure_ms=900 other_rgb=0000ff other_ms=500\n",
  ));
  await nextTask();
  await Promise.all([
    monitor.writeLine("ALIRO/1 GET"),
    monitor.writeLine("ALIRO/1 SET success_ms=800"),
  ]);

  assert.deepEqual(status, VALID_STATUS);
  assert.deepEqual(serialPort.writes, [
    "ALIRO/1 GET\n",
    "ALIRO/1 SET success_ms=800\n",
  ]);
  assert.equal(serialPort.readable.locked, true);
  assert.equal(serialPort.writable.locked, false);
  await assert.rejects(monitor.writeLine("ALIRO/1 GET\nALIRO/1 SET success_ms=0"), /unsafe/);
  await monitor.destroy();
  assert.equal(elements.connected.hidden, true);
});

test("serial monitor starts its read loop before the automatic reset", async () => {
  let locked = false;
  let readStarted = false;
  let finishRead;
  const readable = {
    get locked() { return locked; },
    getReader() {
      locked = true;
      return {
        read() {
          readStarted = true;
          return new Promise((resolve) => { finishRead = resolve; });
        },
        async cancel() { finishRead({ done: true }); },
        releaseLock() { locked = false; },
      };
    },
  };
  const serialPort = {
    readable,
    async open() {},
    async close() {},
    async setSignals() {
      assert.equal(readStarted, true);
      assert.equal(readable.locked, true);
    },
  };
  const monitor = createSerialMonitor({
    elements: fakeMonitorElements(),
    setupFlow: { showPairing: () => true },
    serial: new FakeSerial([serialPort]),
    secureContext: true,
    resetPulseMs: 0,
  });

  assert.equal(await monitor.connect(), true);
  assert.equal(readStarted, true);
  await monitor.destroy();
});

test("each successful connection gets one automatic reset", async () => {
  const firstPort = fakeSerialPort();
  const secondPort = fakeSerialPort();
  const monitor = createSerialMonitor({
    elements: fakeMonitorElements(),
    setupFlow: { showPairing: () => true },
    serial: new FakeSerial([firstPort, secondPort]),
    secureContext: true,
    resetPulseMs: 0,
  });

  assert.equal(await monitor.connect(), true);
  assert.equal(await monitor.disconnect(), true);
  assert.equal(await monitor.connect(), true);
  assert.deepEqual(firstPort.signalCalls, [
    { dataTerminalReady: false, requestToSend: true },
    { dataTerminalReady: false, requestToSend: false },
  ]);
  assert.deepEqual(secondPort.signalCalls, firstPort.signalCalls);
  await monitor.destroy();
});

test("an automatic reset failure keeps the serial reader connected", async () => {
  const serialPort = fakeSerialPort();
  serialPort.setSignals = async function setSignals(value) {
    this.signalCalls.push(value);
    throw new Error("reset unavailable");
  };
  const elements = fakeMonitorElements();
  const monitor = createSerialMonitor({
    elements,
    setupFlow: { showPairing: () => true },
    serial: new FakeSerial([serialPort]),
    secureContext: true,
    resetPulseMs: 0,
    logger: { error() {} },
  });

  assert.equal(await monitor.connect(), true);
  assert.equal(monitor.getState().connected, true);
  assert.equal(serialPort.readable.locked, true);
  assert.equal(serialPort.closeCalls, 0);
  assert.equal(serialPort.signalCalls.length, 3);
  assert.equal(elements.status.textContent,
    "Connected, but the lock did not restart: reset unavailable");
  await monitor.destroy();
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
  assert.match(elements.fabricList.innerHTML, /0x0000000000000001/);
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
    resetPulseMs: 0,
  });

  await nextTask();
  await nextTask();

  assert.equal(serial.getPortsCount, 1);
  assert.equal(serial.requestCount, 0);
  assert.deepEqual(serialPort.openCalls, [{ baudRate: 115200, bufferSize: 8192 }]);
  assert.deepEqual(serialPort.signalCalls, [
    { dataTerminalReady: false, requestToSend: true },
    { dataTerminalReady: false, requestToSend: false },
  ]);
  assert.equal(serialPort.readable.locked, true);
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
  const factoryButton = new FakeInstallButton();
  const updateButton = new FakeInstallButton();
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
    "serial-connected",
    "device-settings",
    "settings-apply",
    "installed-version",
    "latest-version",
    "firmware-current",
  ]) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  assert.match(html, /id="serial-connect">Connect device<\/button>/);
  assert.match(html, /id="serial-reset" disabled>Reset device<\/button>/);
  assert.match(html, /id="serial-copy">Copy logs<\/button>/);
  assert.match(html, /<h2>Already commissioned<\/h2>/);
  assert.match(html, /https:\/\/shop\.m5stack\.com\/products\/m5stack-nanoc6-dev-kit/);
  assert.match(html, /https:\/\/shop\.m5stack\.com\/products\/nfc-universal-unit-st25r3916/);
  assert.match(html, /About \$13 total/);
  assert.match(html, /Build a \$13 tap-to-lock or unlock Matter lock/);
  assert.match(html, /Google wallet key is not yet\s+verified/);
  assert.match(html, /<summary>Technical details<\/summary>/);
  assert.match(html, /The original QR cannot start pairing while BLE commissioning is closed/);
  assert.match(html, /If no controllers remain,\s+follow the <a href="#decommission-heading">full reset guidance<\/a>/);
  assert.match(html, /Do not erase the lock while other services use it/);
  assert.match(html, /Remove it from every Matter service and let each removal finish/);
  assert.match(html, /Factory install cannot notify a Matter service/);
  assert.match(html, /id="auto-lock-seconds"[^>]*max="3600"/);
  assert.match(
    html,
    /If auto-lock is on and the lock is locked, a valid tap unlocks it\. If the\s+lock is already unlocked, the tap restarts the timer\. If auto-lock is\s+off, a valid tap unlocks a locked lock or locks an unlocked lock\./,
  );
  for (const id of ["success-ms", "failure-ms", "other-ms"]) {
    assert.match(html, new RegExp(`id="${id}"[^>]*max="10000"`));
  }
});

test("firmware source checks require conditional tap-to-lock behavior", () => {
  const script = readFileSync(new URL("../../scripts/build_release.sh", import.meta.url), "utf8");
  const variants = JSON.parse(
    readFileSync(new URL("../../firmware/variants.json", import.meta.url), "utf8"),
  );

  assert.match(script, /DoorLock::Attributes::LockState::Get\(door_lock_endpoint_id, lock_state\)/);
  assert.match(script, /lock_state\.Value\(\) == DoorLock::DlLockState::kLocked/);
  assert.match(script, /::DoorLockServer::Instance\(\)\.GetAutoRelockTime/);
  assert.doesNotMatch(script, /DoorLock::DoorLockServer::Instance/);
  assert.match(script, /grep -Fq 'DoorLock::DoorLockServer::'/);
  assert.match(script, /auto_relock_seconds != 0/);
  assert.match(script, /BoltLockMgr\(\)\.Lock\(door_lock_endpoint_id/);
  assert.match(script, /BoltLockMgr\(\)\.Unlock\(door_lock_endpoint_id/);
  // Every variant must apply the tap-toggle patch. Read the list from the
  // SSOT so this check tracks the variant matrix instead of a stale literal.
  for (const [variantId, entry] of Object.entries(variants.variants || {})) {
    assert.ok(
      (entry.source_patches || []).includes("firmware/patches/0007-toggle-lock-on-aliro-tap.patch"),
      `variant ${variantId} must include the tap-toggle patch`,
    );
  }
});

test("build_release.sh runs variant-only checks before the source-check early exit", () => {
  const script = readFileSync(new URL("../../scripts/build_release.sh", import.meta.url), "utf8");

  // The new variant-scoped validators must exist as functions in the script.
  assert.match(script, /validate_variant_transport_exclusivity\(\) \{/);
  assert.match(script, /validate_variant_board_map\(\) \{/);

  // They must run BEFORE the SOURCE_CHECK_ONLY==1 early exit. Otherwise
  // --source-check will keep letting a broken overlay or drifted board
  // header through until a full idf.py build.
  const transportCall = script.search(/^validate_variant_transport_exclusivity$/m);
  const boardCall = script.search(/^validate_variant_board_map$/m);
  const exitBlock = script.search(/if \[\[ "\$SOURCE_CHECK_ONLY" == "1" \]\]; then/);
  assert.ok(transportCall > 0, "transport-exclusivity validator must be invoked");
  assert.ok(boardCall > 0, "board-map validator must be invoked");
  assert.ok(exitBlock > 0, "source-check early exit block must exist");
  assert.ok(transportCall < exitBlock,
    "transport-exclusivity validator must run before the --source-check exit");
  assert.ok(boardCall < exitBlock,
    "board-map validator must run before the --source-check exit");

  // Full-build-only operations must stay after the source-check boundary
  // so a source-check does not need idf.py or a network fetch.
  const idfSetTarget = script.search(/^\s*set-target /m);
  const idfBuild = script.search(/echo "=== build ==="/);
  assert.ok(idfSetTarget > exitBlock, "idf.py set-target must stay after --source-check exit");
  assert.ok(idfBuild > exitBlock, "idf.py build must stay after --source-check exit");
});

test("variants.json board pin fields match the selected board header", () => {
  const rootUrl = (rel) => new URL(`../../${rel}`, import.meta.url);
  const variants = JSON.parse(readFileSync(rootUrl("firmware/variants.json"), "utf8"));

  function readMacro(header, name) {
    const match = new RegExp(`^#define\\s+${name}\\s+(\\S+)`, "m").exec(header);
    return match ? match[1] : null;
  }

  for (const [variantId, entry] of Object.entries(variants.variants || {})) {
    const headerPath = entry.board_config_header;
    assert.ok(headerPath, `variant ${variantId} must name a board_config_header`);
    const header = readFileSync(rootUrl(headerPath), "utf8");

    const dataGpio = readMacro(header, "ALIRO_BOARD_RGB_DATA_GPIO");
    const hasPower = readMacro(header, "ALIRO_BOARD_HAS_RGB_POWER");
    const powerGpio = readMacro(header, "ALIRO_BOARD_RGB_POWER_GPIO");

    assert.equal(dataGpio, String(entry.rgb_data_gpio),
      `${variantId}: variants.json rgb_data_gpio must match ${headerPath}`);
    assert.equal(hasPower, entry.has_rgb_power_pin ? "1" : "0",
      `${variantId}: variants.json has_rgb_power_pin must match ${headerPath}`);
    if (entry.has_rgb_power_pin) {
      assert.equal(powerGpio, String(entry.rgb_power_gpio),
        `${variantId}: variants.json rgb_power_gpio must match ${headerPath}`);
    } else {
      assert.equal(powerGpio, null,
        `${variantId}: board without a power pin must not define ALIRO_BOARD_RGB_POWER_GPIO`);
      assert.equal(entry.rgb_power_gpio, null,
        `${variantId}: variants.json rgb_power_gpio must be null when has_rgb_power_pin=false`);
    }
  }
});

test("variant overlays honor transport exclusivity and disable Improv", () => {
  const rootUrl = (rel) => new URL(`../../${rel}`, import.meta.url);
  const variants = JSON.parse(readFileSync(rootUrl("firmware/variants.json"), "utf8"));

  function lastValue(text, key) {
    const re = new RegExp(`^${key}\\s*=\\s*(\\S+)$`, "gm");
    let value = null;
    let match;
    while ((match = re.exec(text)) !== null) value = match[1];
    return value;
  }

  for (const [variantId, entry] of Object.entries(variants.variants || {})) {
    const overlay = readFileSync(rootUrl(entry.release_overlay), "utf8");
    let base;
    if (entry.base_sdkconfig_source === "upstream") {
      // Upstream base ships esp32c6.aliro with Thread on / Wi-Fi off.
      // Encode the two settings the overlay may inherit.
      base = "CONFIG_OPENTHREAD_ENABLED=y\nCONFIG_ENABLE_WIFI_STATION=n\n";
    } else {
      base = readFileSync(rootUrl(entry.base_sdkconfig_source), "utf8");
    }
    const effective = base + "\n" + overlay;
    const wifi = lastValue(effective, "CONFIG_ENABLE_WIFI_STATION");
    const thread = lastValue(effective, "CONFIG_OPENTHREAD_ENABLED");

    if (entry.transport === "thread") {
      assert.equal(thread, "y", `${variantId}: OpenThread must be enabled`);
      assert.notEqual(wifi, "y", `${variantId}: Wi-Fi station must NOT be enabled for thread variant`);
    } else if (entry.transport === "wifi") {
      assert.equal(wifi, "y", `${variantId}: Wi-Fi station must be enabled`);
      assert.notEqual(thread, "y", `${variantId}: OpenThread must NOT be enabled for wifi variant`);
    } else {
      assert.fail(`${variantId}: unknown transport ${entry.transport}`);
    }
    // No overlay may enable Improv. This is a lightweight check for any
    // CONFIG symbol whose name contains IMPROV.
    assert.doesNotMatch(overlay, /^CONFIG_.*IMPROV.*=y/m,
      `${variantId}: overlay must not enable an Improv wire`);
  }
});

test("each variant has a unique CMake project name in variants.json", () => {
  const variants = JSON.parse(
    readFileSync(new URL("../../firmware/variants.json", import.meta.url), "utf8"),
  );
  const expected = {
    "nanoc6-thread": "aliro-nanoc6-thread",
    "nanoc6-wifi": "aliro-nanoc6-wifi",
    "atoms3-lite-wifi": "aliro-atoms3-lite-wifi",
  };
  const seen = new Set();
  for (const [variantId, entry] of Object.entries(variants.variants || {})) {
    assert.equal(entry.project_name, expected[variantId],
      `variant ${variantId} project_name must be ${expected[variantId]}`);
    assert.ok(!seen.has(entry.project_name),
      `project_name ${entry.project_name} is reused across variants`);
    seen.add(entry.project_name);
  }
});

test("patch 0006 wires CLI_ALIRO_PROJECT_NAME into ESP-IDF project()", () => {
  const patch = readFileSync(
    new URL("../../firmware/patches/0006-add-aliro-settings.patch", import.meta.url),
    "utf8",
  );

  // The CMakeLists.txt hunk must gate CLI_ALIRO_PROJECT_NAME on a default,
  // pass it as a compile-time identifier if desired, and rename the
  // ESP-IDF project() call to consume it.
  assert.match(patch, /if\(NOT DEFINED CLI_ALIRO_PROJECT_NAME\)/);
  assert.match(patch, /set\(CLI_ALIRO_PROJECT_NAME "aliro-nanoc6-thread"\)/);
  assert.match(patch, /\+project\(\$\{CLI_ALIRO_PROJECT_NAME\}\)/);
  // And the pristine literal must be removed.
  assert.match(patch, /-project\(door_lock\)/);
});

test("build_release.sh forwards VARIANT_PROJECT_NAME to idf.py and rejects the pristine project name", () => {
  const script = readFileSync(new URL("../../scripts/build_release.sh", import.meta.url), "utf8");
  // Both idf.py invocations (set-target and build) must pass the CLI define.
  const forwards = [...script.matchAll(/-D CLI_ALIRO_PROJECT_NAME="\$VARIANT_PROJECT_NAME"/g)];
  assert.ok(forwards.length >= 2,
    `build_release.sh must pass CLI_ALIRO_PROJECT_NAME to both idf.py calls (found ${forwards.length})`);
  // The source-check validator must fail if the patched tree still has
  // the pristine project(door_lock) literal.
  assert.match(script, /patched CMakeLists\.txt still names project\(door_lock\)/);
  // The validator must require the CMake CLI setup and the project() rewrite.
  assert.match(script, /set\(CLI_ALIRO_PROJECT_NAME "aliro-nanoc6-thread"\)/);
  assert.match(script, /project\(\$\{CLI_ALIRO_PROJECT_NAME\}\)/);
});

// --- prepare_release.sh fixture tests ---
// These build a synthetic ESP-IDF build/ directory (fake
// project_description.json, flasher_args.json, partition table, and app
// binary) and check that the script accepts the valid combination and
// refuses each specific bad case. No real toolchain is invoked; the
// script exits before esptool.py runs for every negative test.

function makeFixtureBuild({
  projectName = "aliro-nanoc6-thread",
  projectVersion = "0.0.6-devkit",
  chip = "esp32c6",
  appBin = "aliro-nanoc6-thread.bin",
  partitionBytes = null, // if null, use 0xC00 zero bytes (will not match approved hash)
  omitProjectDescription = false,
  omitFlasherArgs = false,
} = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "prep-fixture-"));
  const build = path.join(root, "build");
  mkdirSync(path.join(build, "partition_table"), { recursive: true });
  mkdirSync(path.join(build, "bootloader"), { recursive: true });
  writeFileSync(
    path.join(build, "partition_table/partition-table.bin"),
    partitionBytes || Buffer.alloc(0xC00),
  );
  writeFileSync(path.join(build, "bootloader/bootloader.bin"), Buffer.alloc(0x8000, 66));
  writeFileSync(path.join(build, appBin), Buffer.alloc(0x10000, 65));
  if (!omitProjectDescription) {
    writeFileSync(
      path.join(build, "project_description.json"),
      JSON.stringify({
        project_name: projectName,
        project_version: projectVersion,
        app_bin: appBin,
      }),
    );
  }
  if (!omitFlasherArgs) {
    writeFileSync(
      path.join(build, "flasher_args.json"),
      JSON.stringify({
        extra_esptool_args: { chip },
        flash_files: {
          "0x0": "bootloader/bootloader.bin",
          "0xC000": "partition_table/partition-table.bin",
          "0x20000": appBin,
        },
      }),
    );
  }
  return { root, build };
}

// Every fixture test routes the packager's output through a temporary
// artifact root via ALIRO_ARTIFACTS_DIR so a normal host test run
// never creates, replaces, or removes anything inside repo/artifacts.
//
// `extraArgs` and `useMockEsptool` support the atomic-publication
// tests. The mock esptool.py stand-in ships in installer/tests/ and
// mimics `esptool.py merge_bin` well enough to exercise the merged-
// binary checks without a real ESP-IDF toolchain.
const MOCK_ESPTOOL_DIR = new URL("./", import.meta.url).pathname;
const MOCK_ESPTOOL = new URL("./mock-esptool.py", import.meta.url).pathname;
function runPrepare({
  variant,
  tag,
  buildDir,
  artifactsDir,
  extraArgs = [],
  useMockEsptool = false,
  envOverrides = {},
}) {
  const scriptPath = new URL("../../scripts/prepare_release.sh", import.meta.url).pathname;
  if (!artifactsDir) throw new Error("artifactsDir is required (must be a tmp path)");
  const repoRoot = new URL("../../", import.meta.url).pathname;
  if (artifactsDir === path.join(repoRoot, "artifacts")
      || artifactsDir.startsWith(path.join(repoRoot, "artifacts") + "/")) {
    throw new Error("artifactsDir must not point at the repository artifacts tree");
  }
  const env = { ...process.env, ALIRO_ARTIFACTS_DIR: artifactsDir, ...envOverrides };
  if (useMockEsptool) {
    // Prepend a shim dir with an `esptool.py` symlink to the mock. Every
    // subshell that inherits PATH resolves esptool.py to the mock.
    const shim = mkdtempSync(path.join(tmpdir(), "prep-shim-"));
    const shimEsptool = path.join(shim, "esptool.py");
    writeFileSync(
      shimEsptool,
      `#!/bin/sh\nexec ${JSON.stringify("python3")} ${JSON.stringify(MOCK_ESPTOOL)} "$@"\n`,
      { mode: 0o755 },
    );
    env.PATH = shim + path.delimiter + env.PATH;
    env._ALIRO_TEST_SHIM_DIR = shim;
    // Remove IDF_PATH so the script's IDF fallback does not shadow the
    // shim when both are present.
    delete env.IDF_PATH;
  }
  const args = ["bash", scriptPath];
  if (extraArgs.length) {
    args.push(...extraArgs);
  } else {
    args.push("--variant", variant, "--tag", tag, "--build-dir", buildDir);
  }
  try {
    const stdout = execFileSync(args[0], args.slice(1), {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      timeout: 15000,
      env,
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    return {
      status: typeof error.status === "number" ? error.status : -1,
      stdout: error.stdout?.toString() || "",
      stderr: error.stderr?.toString() || String(error),
    };
  } finally {
    if (env._ALIRO_TEST_SHIM_DIR) {
      rmSync(env._ALIRO_TEST_SHIM_DIR, { recursive: true, force: true });
    }
  }
}

function withFixture(setup, callback) {
  const { root, build } = makeFixtureBuild(setup);
  const artifactsDir = mkdtempSync(path.join(tmpdir(), "prep-artifacts-"));
  try {
    return callback({ root, build, artifactsDir });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(artifactsDir, { recursive: true, force: true });
  }
}

test("prepare_release.sh rejects a wrong project_name", () => {
  withFixture({ projectName: "door_lock" }, ({ build, artifactsDir }) => {
    const result = runPrepare({
      variant: "nanoc6-thread",
      tag: "aliro-v0.0.6-devkit",
      buildDir: build,
      artifactsDir,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /project_name is 'door_lock'.*aliro-nanoc6-thread/);
  });
});

test("prepare_release.sh rejects a wrong project_version", () => {
  withFixture({ projectVersion: "0.0.5-devkit" }, ({ build, artifactsDir }) => {
    const result = runPrepare({
      variant: "nanoc6-thread",
      tag: "aliro-v0.0.6-devkit",
      buildDir: build,
      artifactsDir,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /project_version is '0\.0\.5-devkit'.*0\.0\.6-devkit/);
  });
});

test("prepare_release.sh rejects a wrong chip", () => {
  withFixture({ chip: "esp32s3" }, ({ build, artifactsDir }) => {
    const result = runPrepare({
      variant: "nanoc6-thread",
      tag: "aliro-v0.0.6-devkit",
      buildDir: build,
      artifactsDir,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /build chip is 'esp32s3'.*esp32c6/);
  });
});

test("prepare_release.sh fails closed when the approved partition hash is null", () => {
  // Every variant now has an approved partition_table_sha256 stamped.
  // Force the null condition by patching variants.json under
  // atoms3-lite-wifi, then assert the packager still refuses to
  // proceed when the approved hash is missing.
  const variantsPath = new URL("../../firmware/variants.json", import.meta.url);
  const originalVariants = readFileSync(variantsPath, "utf8");
  const patched = JSON.parse(originalVariants);
  patched.variants["atoms3-lite-wifi"].partition_table_sha256 = null;
  writeFileSync(variantsPath, JSON.stringify(patched, null, 2));
  try {
    withFixture({
      projectName: "aliro-atoms3-lite-wifi",
      projectVersion: "0.0.6-devkit",
      chip: "esp32s3",
      appBin: "aliro-atoms3-lite-wifi.bin",
    }, ({ build, artifactsDir }) => {
      const result = runPrepare({
        variant: "atoms3-lite-wifi",
        tag: "aliro-v0.0.6-devkit",
        buildDir: build,
        artifactsDir,
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /no approved partition_table_sha256/);
    });
  } finally {
    writeFileSync(variantsPath, originalVariants);
  }
});

test("prepare_release.sh rejects a partition-table SHA-256 mismatch", () => {
  withFixture({
    partitionBytes: Buffer.alloc(0xC00, 0x00), // hashes to a known non-approved value
  }, ({ build, artifactsDir }) => {
    const result = runPrepare({
      variant: "nanoc6-thread",
      tag: "aliro-v0.0.6-devkit",
      buildDir: build,
      artifactsDir,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not the approved layout for nanoc6-thread/);
  });
});

test("prepare_release.sh valid path passes every fail-closed check before esptool", () => {
  // Construct a partition-table blob whose SHA-256 matches the approved hash for
  // nanoc6-thread. Since we do not have the real partition table available in
  // the repo tree, we forge a placeholder file, patch variants.json to point at
  // its actual hash, package, then restore variants.json. This proves the
  // check is exercised, not that the placeholder is a real ESP32-C6 layout.
  const variantsPath = new URL("../../firmware/variants.json", import.meta.url);
  const originalVariants = readFileSync(variantsPath, "utf8");
  withFixture({}, ({ build, artifactsDir }) => {
    const partitionBytes = Buffer.alloc(0xC00, 0x00);
    writeFileSync(path.join(build, "partition_table/partition-table.bin"), partitionBytes);
    const forgedHash = createHash("sha256").update(partitionBytes).digest("hex");
    const patched = JSON.parse(originalVariants);
    patched.variants["nanoc6-thread"].partition_table_sha256 = forgedHash;
    writeFileSync(variantsPath, JSON.stringify(patched, null, 2));
    try {
      const result = runPrepare({
        variant: "nanoc6-thread",
        tag: "aliro-v0.0.6-devkit",
        buildDir: build,
        artifactsDir,
      });
      // The script gets past every fail-closed check and only fails when it
      // tries to invoke esptool.py (which is not on this test host). That is
      // proof the valid path reached asset assembly.
      if (result.status === 0) {
        // If esptool is present, packaging succeeds.
        assert.match(result.stdout, /Release artifacts for variant nanoc6-thread/);
      } else {
        assert.match(result.stderr, /esptool\.py not on PATH|merge_bin|IDF_PATH/);
      }
    } finally {
      writeFileSync(variantsPath, originalVariants);
    }
  });
});

test("prepare_release.sh rejects a project_description app_bin that is not <project_name>.bin", () => {
  // Patch variants.json to accept the fixture's forged partition hash so
  // the earlier fail-closed checks pass; then declare a bad app_bin and
  // confirm the packager refuses before staging.
  const variantsPath = new URL("../../firmware/variants.json", import.meta.url);
  const originalVariants = readFileSync(variantsPath, "utf8");
  withFixture({}, ({ build, artifactsDir }) => {
    const partitionBytes = Buffer.alloc(0xC00, 0x00);
    writeFileSync(path.join(build, "partition_table/partition-table.bin"), partitionBytes);
    const forgedHash = createHash("sha256").update(partitionBytes).digest("hex");
    const patched = JSON.parse(originalVariants);
    patched.variants["nanoc6-thread"].partition_table_sha256 = forgedHash;
    writeFileSync(variantsPath, JSON.stringify(patched, null, 2));
    try {
      const descPath = path.join(build, "project_description.json");
      const desc = JSON.parse(readFileSync(descPath, "utf8"));
      desc.app_bin = "surprise.bin";
      writeFileSync(descPath, JSON.stringify(desc));
      const result = runPrepare({
        variant: "nanoc6-thread",
        tag: "aliro-v0.0.6-devkit",
        buildDir: build,
        artifactsDir,
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /app_bin is 'surprise\.bin'.*aliro-nanoc6-thread\.bin/);
      // Nothing must be written under the artifacts tmp root when the
      // check fires before staging.
      assert.deepEqual(readdirSync(artifactsDir), [],
        "no staging directory should exist under artifactsDir when app_bin is rejected");
    } finally {
      writeFileSync(variantsPath, originalVariants);
    }
  });
});

test("prepare_release.sh fixture tests never touch the repository artifacts tree", () => {
  const repoArtifactsPath = new URL("../../artifacts/", import.meta.url).pathname;
  const snapshot = () => {
    try {
      return readdirSync(repoArtifactsPath).sort();
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  };
  const before = snapshot();
  // Run every fixture path once with a tmp artifacts root and confirm
  // repo/artifacts is unchanged. This test both proves the sandboxing
  // works and guards against a future regression that hardcodes the
  // repo path back in.
  withFixture({ projectName: "door_lock" }, ({ build, artifactsDir }) => {
    runPrepare({
      variant: "nanoc6-thread",
      tag: "aliro-v0.0.6-devkit",
      buildDir: build,
      artifactsDir,
    });
  });
  withFixture({}, ({ build, artifactsDir }) => {
    runPrepare({
      variant: "nanoc6-thread",
      tag: "aliro-v0.0.6-devkit",
      buildDir: build,
      artifactsDir,
    });
  });
  const after = snapshot();
  assert.deepEqual(after, before,
    "prepare_release.sh must not create, replace, or remove anything under repo/artifacts when ALIRO_ARTIFACTS_DIR points elsewhere");
});

// Helper: patch variants.json so the fixture's forged partition hash is
// accepted, run the callback, then restore the file.
function withForgedPartition(partitionBytes, callback) {
  const variantsPath = new URL("../../firmware/variants.json", import.meta.url);
  const originalVariants = readFileSync(variantsPath, "utf8");
  const forgedHash = createHash("sha256").update(partitionBytes).digest("hex");
  const patched = JSON.parse(originalVariants);
  patched.variants["nanoc6-thread"].partition_table_sha256 = forgedHash;
  patched.variants["nanoc6-wifi"].partition_table_sha256 = forgedHash;
  writeFileSync(variantsPath, JSON.stringify(patched, null, 2));
  try {
    return callback();
  } finally {
    writeFileSync(variantsPath, originalVariants);
  }
}

test("prepare_release.sh publishes the complete five-file set in one atomic directory rename", () => {
  const partitionBytes = Buffer.alloc(0xC00, 0x00);
  withForgedPartition(partitionBytes, () => {
    withFixture({}, ({ build, artifactsDir }) => {
      writeFileSync(path.join(build, "partition_table/partition-table.bin"), partitionBytes);
      const result = runPrepare({
        variant: "nanoc6-thread",
        tag: "aliro-v0.0.6-devkit",
        buildDir: build,
        artifactsDir,
        useMockEsptool: true,
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      const outDir = path.join(artifactsDir, "aliro-v0.0.6-devkit", "nanoc6-thread");
      const files = readdirSync(outDir).sort();
      assert.deepEqual(files, [
        "aliro-v0.0.6-devkit-nanoc6-thread-app.bin",
        "aliro-v0.0.6-devkit-nanoc6-thread-app.bin.sha256",
        "aliro-v0.0.6-devkit-nanoc6-thread-factory.bin",
        "aliro-v0.0.6-devkit-nanoc6-thread-factory.bin.sha256",
        "aliro-v0.0.6-devkit-nanoc6-thread-manifest.txt",
      ], "the published directory must contain exactly the five-file matrix package");
      // No stage-dir leaves should remain under the tag directory.
      const tagDir = path.join(artifactsDir, "aliro-v0.0.6-devkit");
      const tagEntries = readdirSync(tagDir).sort();
      assert.deepEqual(tagEntries, ["nanoc6-thread"],
        "the tag directory must only contain the per-variant subdirectory (no stage leftovers)");
    });
  });
});

test("prepare_release.sh failed publication leaves no partial final directory", () => {
  // Approved-hash mismatch is caught AFTER the mock esptool writes the
  // staged binary. Cleanup must remove the stage dir; no partial final
  // directory may be published.
  withFixture({}, ({ build, artifactsDir }) => {
    const partitionBytes = Buffer.alloc(0xC00, 0x00);
    writeFileSync(path.join(build, "partition_table/partition-table.bin"), partitionBytes);
    const result = runPrepare({
      variant: "nanoc6-thread",
      tag: "aliro-v0.0.6-devkit",
      buildDir: build,
      artifactsDir,
      // No forged partition hash this time, so the pristine variants.json
      // still rejects the partition. That fires BEFORE staging even
      // begins, so no final directory may be created.
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not the approved layout for nanoc6-thread/);
    // No final variant directory, no stage residue, no tag directory
    // beyond what was created for the failed run.
    const tagDir = path.join(artifactsDir, "aliro-v0.0.6-devkit");
    let residue = [];
    try {
      residue = readdirSync(tagDir);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    assert.deepEqual(residue, [],
      `no partial final directory allowed under ${tagDir} after a failed run`);
    // Nothing shall exist at all under artifactsDir either — stage
    // cleanup runs on exit.
    const roots = readdirSync(artifactsDir);
    for (const entry of roots) {
      assert.doesNotMatch(entry, /\.stage\./,
        `no stage-dir residue allowed: found ${entry}`);
    }
  });
});

test("prepare_release.sh refuses to overwrite an existing package and leaves it byte-for-byte unchanged", () => {
  const partitionBytes = Buffer.alloc(0xC00, 0x00);
  withForgedPartition(partitionBytes, () => {
    withFixture({}, ({ build, artifactsDir }) => {
      writeFileSync(path.join(build, "partition_table/partition-table.bin"), partitionBytes);
      // Publish once.
      const first = runPrepare({
        variant: "nanoc6-thread",
        tag: "aliro-v0.0.6-devkit",
        buildDir: build,
        artifactsDir,
        useMockEsptool: true,
      });
      assert.equal(first.status, 0, first.stderr || first.stdout);
      const outDir = path.join(artifactsDir, "aliro-v0.0.6-devkit", "nanoc6-thread");
      const originalDigest = {};
      for (const file of readdirSync(outDir)) {
        originalDigest[file] = createHash("sha256")
          .update(readFileSync(path.join(outDir, file)))
          .digest("hex");
      }
      // Re-publish the same variant + tag: must refuse and touch nothing.
      const second = runPrepare({
        variant: "nanoc6-thread",
        tag: "aliro-v0.0.6-devkit",
        buildDir: build,
        artifactsDir,
        useMockEsptool: true,
      });
      assert.notEqual(second.status, 0);
      assert.match(second.stderr, /refusing to overwrite an existing package/);
      const afterDigest = {};
      for (const file of readdirSync(outDir)) {
        afterDigest[file] = createHash("sha256")
          .update(readFileSync(path.join(outDir, file)))
          .digest("hex");
      }
      assert.deepEqual(afterDigest, originalDigest,
        "existing package must remain byte-for-byte unchanged after a refused republish");
    });
  });
});

test("prepare_release.sh keeps two variants independent under one tag", () => {
  const partitionBytes = Buffer.alloc(0xC00, 0x00);
  withForgedPartition(partitionBytes, () => {
    // First variant: nanoc6-thread
    withFixture({}, ({ build: buildA, artifactsDir }) => {
      writeFileSync(path.join(buildA, "partition_table/partition-table.bin"), partitionBytes);
      const first = runPrepare({
        variant: "nanoc6-thread",
        tag: "aliro-v0.0.6-devkit",
        buildDir: buildA,
        artifactsDir,
        useMockEsptool: true,
      });
      assert.equal(first.status, 0, first.stderr || first.stdout);
      // Second variant under the SAME tag: nanoc6-wifi
      // (uses the same fixture project layout but with the correct
      // variant name).
      const { root: rootB, build: buildB } = makeFixtureBuild({
        projectName: "aliro-nanoc6-wifi",
        appBin: "aliro-nanoc6-wifi.bin",
      });
      writeFileSync(path.join(buildB, "partition_table/partition-table.bin"), partitionBytes);
      try {
        const second = runPrepare({
          variant: "nanoc6-wifi",
          tag: "aliro-v0.0.6-devkit",
          buildDir: buildB,
          artifactsDir,
          useMockEsptool: true,
        });
        assert.equal(second.status, 0, second.stderr || second.stdout);
      } finally {
        rmSync(rootB, { recursive: true, force: true });
      }
      const tagDir = path.join(artifactsDir, "aliro-v0.0.6-devkit");
      const variants = readdirSync(tagDir).sort();
      assert.deepEqual(variants, ["nanoc6-thread", "nanoc6-wifi"],
        "each variant must live in its own subdirectory under the tag");
      for (const variantId of variants) {
        const files = readdirSync(path.join(tagDir, variantId)).sort();
        assert.equal(files.length, 5,
          `variant ${variantId} must publish exactly five files (got ${files.length})`);
        for (const file of files) {
          assert.ok(file.startsWith(`aliro-v0.0.6-devkit-${variantId}-`),
            `variant ${variantId} file must be namespaced: ${file}`);
        }
      }
    });
  });
});

test("prepare_release.sh rejects positional arguments", () => {
  const tmpArtifacts = mkdtempSync(path.join(tmpdir(), "prep-artifacts-"));
  try {
    // Positional call form: <BUILD_DIR> <TAG>
    const result = runPrepare({
      variant: "unused-because-extraargs-overrides",
      tag: "aliro-v0.0.6-devkit",
      buildDir: "/tmp/does-not-matter",
      artifactsDir: tmpArtifacts,
      extraArgs: ["/tmp/build", "aliro-c6-v0.0.5-devkit"],
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /positional arguments are rejected/);
    assert.match(result.stderr, /--variant/);
    assert.match(result.stderr, /--tag/);
  } finally {
    rmSync(tmpArtifacts, { recursive: true, force: true });
  }
});

test("prepare_release.sh rejects a bare -- with no other args", () => {
  const tmpArtifacts = mkdtempSync(path.join(tmpdir(), "prep-artifacts-"));
  try {
    const result = runPrepare({
      variant: "unused",
      tag: "aliro-v0.0.6-devkit",
      buildDir: "/tmp/does-not-matter",
      artifactsDir: tmpArtifacts,
      extraArgs: ["--"],
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /-- is not accepted/);
  } finally {
    rmSync(tmpArtifacts, { recursive: true, force: true });
  }
});

test("prepare_release.sh rejects a trailing '-- /path' after the flags", () => {
  const tmpArtifacts = mkdtempSync(path.join(tmpdir(), "prep-artifacts-"));
  try {
    // Even with all required flags supplied, appending `-- /path` must
    // be rejected outright. The build-dir must never be opened.
    const result = runPrepare({
      variant: "unused",
      tag: "aliro-v0.0.6-devkit",
      buildDir: "/tmp/does-not-matter",
      artifactsDir: tmpArtifacts,
      extraArgs: [
        "--variant", "nanoc6-thread",
        "--tag", "aliro-v0.0.6-devkit",
        "--build-dir", "/nonexistent/build",
        "--", "/tmp/build",
      ],
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /-- is not accepted/);
    // Must fail before touching the (nonexistent) build directory.
    assert.doesNotMatch(result.stderr, /flasher_args\.json not found/);
  } finally {
    rmSync(tmpArtifacts, { recursive: true, force: true });
  }
});

test("prepare_release.sh rejects -- inserted between flags and positional smuggling", () => {
  const tmpArtifacts = mkdtempSync(path.join(tmpdir(), "prep-artifacts-"));
  try {
    // --variant X --tag Y -- extra should reject at -- before extra
    // is ever interpreted as a build-dir.
    const result = runPrepare({
      variant: "unused",
      tag: "aliro-v0.0.6-devkit",
      buildDir: "/tmp/does-not-matter",
      artifactsDir: tmpArtifacts,
      extraArgs: [
        "--variant", "nanoc6-thread",
        "--tag", "aliro-v0.0.6-devkit",
        "--", "extra-positional",
      ],
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /-- is not accepted/);
  } finally {
    rmSync(tmpArtifacts, { recursive: true, force: true });
  }
});

test("prepare_release.sh publication lock blocks a concurrent publisher without touching the winner", () => {
  const partitionBytes = Buffer.alloc(0xC00, 0x00);
  withForgedPartition(partitionBytes, () => {
    withFixture({}, ({ build, artifactsDir }) => {
      writeFileSync(path.join(build, "partition_table/partition-table.bin"), partitionBytes);
      const first = runPrepare({
        variant: "nanoc6-thread",
        tag: "aliro-v0.0.6-devkit",
        buildDir: build,
        artifactsDir,
        useMockEsptool: true,
      });
      assert.equal(first.status, 0, first.stderr || first.stdout);
      const outDir = path.join(artifactsDir, "aliro-v0.0.6-devkit", "nanoc6-thread");
      // Snapshot the winner's published files.
      const winnerFiles = readdirSync(outDir).sort();
      const winnerDigests = {};
      for (const f of winnerFiles) {
        winnerDigests[f] = createHash("sha256").update(readFileSync(path.join(outDir, f))).digest("hex");
      }

      // Simulate a concurrent publisher by pre-creating the lock
      // directory. mkdir is atomic, so this is exactly what a live
      // second publisher would look like from the newcomer's point of
      // view. The lock name uses the same tag+variant pattern the
      // script derives.
      const lockName = `.aliro-v0.0.6-devkit-nanoc6-thread.publish.lock`;
      const lockPath = path.join(artifactsDir, lockName);
      // Remove the winner's package so the lock's presence alone is
      // what blocks the second run (otherwise the existing-package
      // refusal would fire first). Then re-hold the lock.
      rmSync(outDir, { recursive: true, force: true });
      mkdirSync(lockPath);
      try {
        const second = runPrepare({
          variant: "nanoc6-thread",
          tag: "aliro-v0.0.6-devkit",
          buildDir: build,
          artifactsDir,
          useMockEsptool: true,
        });
        assert.notEqual(second.status, 0);
        assert.match(second.stderr, /another publisher holds the lock/);
        // The blocked run must not create any nested stage or final
        // directory, and must not touch the lock (release stays with
        // whoever created it).
        assert.equal(existsSync(outDir), false,
          "blocked publisher must not create a final directory");
        for (const entry of readdirSync(artifactsDir)) {
          if (entry === lockName) continue;
          assert.doesNotMatch(entry, /\.stage\./,
            `blocked publisher must not leave stage residue: found ${entry}`);
        }
      } finally {
        rmSync(lockPath, { recursive: true, force: true });
      }
    });
  });
});

test("prepare_release.sh releases the lock and leaves the package untouched when stage mktemp fails", () => {
  const partitionBytes = Buffer.alloc(0xC00, 0x00);
  withForgedPartition(partitionBytes, () => {
    // First publish nanoc6-thread cleanly so there is an existing
    // package that must survive a later failure on a different variant.
    const artifactsDir = mkdtempSync(path.join(tmpdir(), "prep-artifacts-"));
    const { root: rootA, build: buildA } = makeFixtureBuild({});
    writeFileSync(path.join(buildA, "partition_table/partition-table.bin"), partitionBytes);
    try {
      const first = runPrepare({
        variant: "nanoc6-thread",
        tag: "aliro-v0.0.6-devkit",
        buildDir: buildA,
        artifactsDir,
        useMockEsptool: true,
      });
      assert.equal(first.status, 0, first.stderr || first.stdout);
    } finally {
      rmSync(rootA, { recursive: true, force: true });
    }
    // Snapshot the winner's published bytes.
    const winnerDir = path.join(artifactsDir, "aliro-v0.0.6-devkit", "nanoc6-thread");
    const winnerDigests = {};
    for (const f of readdirSync(winnerDir)) {
      winnerDigests[f] = createHash("sha256")
        .update(readFileSync(path.join(winnerDir, f))).digest("hex");
    }

    // Now try to publish nanoc6-wifi under the same tag with a
    // deterministically failing `mktemp` shim. The pre-existing lock
    // acquisition must succeed (variant differs), then the mktemp
    // failure must fire cleanup, releasing the lock and leaving
    // nanoc6-thread's package byte-for-byte unchanged.
    const shimDir = mkdtempSync(path.join(tmpdir(), "prep-shim-mktemp-"));
    writeFileSync(path.join(shimDir, "mktemp"),
      "#!/bin/sh\necho 'mktemp: forced failure for regression test' >&2\nexit 1\n",
      { mode: 0o755 });
    // Also ship the mock esptool so the earlier PATH resolves it after
    // the shim shadows mktemp.
    writeFileSync(path.join(shimDir, "esptool.py"),
      `#!/bin/sh\nexec python3 ${JSON.stringify(MOCK_ESPTOOL)} "$@"\n`,
      { mode: 0o755 });

    const { root: rootB, build: buildB } = makeFixtureBuild({
      projectName: "aliro-nanoc6-wifi",
      appBin: "aliro-nanoc6-wifi.bin",
    });
    writeFileSync(path.join(buildB, "partition_table/partition-table.bin"), partitionBytes);
    try {
      const env = {
        ...process.env,
        ALIRO_ARTIFACTS_DIR: artifactsDir,
        PATH: shimDir + path.delimiter + process.env.PATH,
      };
      delete env.IDF_PATH;
      const scriptPath = new URL("../../scripts/prepare_release.sh", import.meta.url).pathname;
      let result;
      try {
        const stdout = execFileSync("bash", [
          scriptPath,
          "--variant", "nanoc6-wifi",
          "--tag", "aliro-v0.0.6-devkit",
          "--build-dir", buildB,
        ], { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout: 15000, env });
        result = { status: 0, stdout, stderr: "" };
      } catch (error) {
        result = {
          status: typeof error.status === "number" ? error.status : -1,
          stdout: error.stdout?.toString() || "",
          stderr: error.stderr?.toString() || String(error),
        };
      }
      assert.notEqual(result.status, 0, "forced mktemp failure must fail the run");
      assert.match(result.stderr, /could not create stage directory/);

      // The nanoc6-wifi lock must have been released.
      const wifiLock = path.join(artifactsDir,
        ".aliro-v0.0.6-devkit-nanoc6-wifi.publish.lock");
      assert.equal(existsSync(wifiLock), false,
        "lock directory must be removed after a mktemp failure");
      // No stage directory anywhere under the artifacts root.
      for (const entry of readdirSync(artifactsDir)) {
        assert.doesNotMatch(entry, /\.stage\./,
          `no stage residue allowed after mktemp failure: ${entry}`);
      }
      // No nanoc6-wifi final directory.
      assert.equal(existsSync(path.join(artifactsDir,
        "aliro-v0.0.6-devkit", "nanoc6-wifi")), false,
        "no nanoc6-wifi final directory may be created after mktemp failure");
      // The pre-existing nanoc6-thread package must be byte-for-byte
      // identical.
      const afterDigests = {};
      for (const f of readdirSync(winnerDir)) {
        afterDigests[f] = createHash("sha256")
          .update(readFileSync(path.join(winnerDir, f))).digest("hex");
      }
      assert.deepEqual(afterDigests, winnerDigests,
        "existing package must be untouched when a different-variant publish fails at mktemp");
    } finally {
      rmSync(rootB, { recursive: true, force: true });
      rmSync(shimDir, { recursive: true, force: true });
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });
});

test("runPrepare refuses to point at the repository artifacts tree", () => {
  const repoArtifactsPath = new URL("../../artifacts/", import.meta.url).pathname;
  withFixture({}, ({ build }) => {
    assert.throws(
      () => runPrepare({
        variant: "nanoc6-thread",
        tag: "aliro-v0.0.6-devkit",
        buildDir: build,
        artifactsDir: repoArtifactsPath.replace(/\/$/, ""),
      }),
      /must not point at the repository artifacts tree/,
    );
  });
});

// --- scripts/assemble_release.py fixture tests ---
// These tests build a synthetic three-variant asset tree that matches
// scripts/prepare_release.sh's output layout, run the assembler
// against it, and cover the valid path plus five fail-closed cases.
// Every negative test also asserts that the assembler wrote nothing to
// the output directory.

const ASSEMBLE_SCRIPT = new URL("../../scripts/assemble_release.py", import.meta.url).pathname;
const APPROVED_PARTITION_SHA =
  "22770c7ddd300880cdd3e3344c174122c207fa4fe6a523ef83e6fc4e892c2421";

// Build a synthetic factory image that satisfies every assembler check:
// 4 MiB total, padded with 0xFF, real partition bytes at 0xC000 whose
// SHA-256 matches the approved hash, real app bytes embedded at 0x20000.
function buildFactoryImage(partitionBytes, appBytes, flashSize = 4 * 1024 * 1024) {
  const image = Buffer.alloc(flashSize, 0xff);
  partitionBytes.copy(image, 0xC000);
  appBytes.copy(image, 0x20000);
  return image;
}

// Build a partition-table blob whose SHA-256 matches the approved
// nanoc6 value. Real partition-table bytes are not needed for the
// assembler's checks; only the SHA at 0xC000 matters. We forge a
// blob whose hash equals APPROVED_PARTITION_SHA by cheating: the
// tests patch variants.json to accept whatever bytes we choose. That
// preserves the assembler's real check semantics.
function forgePartitionBytes() {
  return Buffer.alloc(0xC00, 0x00);
}

function forgePartitionSha(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function writePackage(pkgDir, tag, variant, projectName, chip, flashSize,
                      appBytes, partitionBytes) {
  mkdirSync(pkgDir, { recursive: true });
  const stem = `${tag}-${variant}`;
  const factoryName = `${stem}-factory.bin`;
  const appName = `${stem}-app.bin`;
  const factory = buildFactoryImage(partitionBytes, appBytes);
  const factoryPath = path.join(pkgDir, factoryName);
  const appPath = path.join(pkgDir, appName);
  writeFileSync(factoryPath, factory);
  writeFileSync(appPath, appBytes);
  const factorySha = createHash("sha256").update(factory).digest("hex");
  const appSha = createHash("sha256").update(appBytes).digest("hex");
  writeFileSync(`${factoryPath}.sha256`, `${factorySha}  ${factoryName}\n`);
  writeFileSync(`${appPath}.sha256`, `${appSha}  ${appName}\n`);
  const firmwareVersion = tag.replace(/^aliro-v/, "");
  writeFileSync(path.join(pkgDir, `${stem}-manifest.txt`),
`# ${tag} ${variant} factory image manifest
tag: ${tag}
variant: ${variant}
project_name: ${projectName}
project_version: ${firmwareVersion}
chip: ${chip}
flash_size: ${flashSize}
size: ${factory.length} bytes
sha256: ${factorySha}
`);
  return { factoryPath, appPath, factorySha, appSha, factoryName, appName };
}

// Build a full three-variant asset tree. All variants use the same
// forged partition bytes (SHA-256 patched in variants.json by
// withForgedPartitionForAllVariants) so the smoke path can exercise
// every check without three real firmware builds.
function buildMatrixTree(tag, assetsRoot, partitionBytes) {
  const tagRoot = path.join(assetsRoot, tag);
  mkdirSync(tagRoot, { recursive: true });
  const configs = [
    ["nanoc6-thread",    "aliro-nanoc6-thread",    "esp32c6", "4MB"],
    ["nanoc6-wifi",      "aliro-nanoc6-wifi",      "esp32c6", "4MB"],
    ["atoms3-lite-wifi", "aliro-atoms3-lite-wifi", "esp32s3", "4MB"],
  ];
  const packages = {};
  for (const [variant, projectName, chip, flashSize] of configs) {
    const pkg = writePackage(
      path.join(tagRoot, variant),
      tag, variant, projectName, chip, flashSize,
      Buffer.alloc(0x10000, 0x41), // 64 KiB fake app
      partitionBytes,
    );
    packages[variant] = pkg;
  }
  return packages;
}

// Patch variants.json so all three variants accept the forged
// partition SHA-256, then run the callback and restore.
function withForgedPartitionForAllVariants(bytes, callback) {
  const variantsPath = new URL("../../firmware/variants.json", import.meta.url);
  const originalVariants = readFileSync(variantsPath, "utf8");
  const forgedHash = createHash("sha256").update(bytes).digest("hex");
  const patched = JSON.parse(originalVariants);
  for (const variantId of ["nanoc6-thread", "nanoc6-wifi", "atoms3-lite-wifi"]) {
    patched.variants[variantId].partition_table_sha256 = forgedHash;
  }
  writeFileSync(variantsPath, JSON.stringify(patched, null, 2));
  try {
    return callback(variantsPath.pathname, forgedHash);
  } finally {
    writeFileSync(variantsPath, originalVariants);
  }
}

function runAssemble({ tag, variantsPath, assetsRoot, outDir }) {
  try {
    const stdout = execFileSync("python3", [
      ASSEMBLE_SCRIPT,
      "--tag", tag,
      "--variants", variantsPath,
      "--assets", assetsRoot,
      "--out", outDir,
    ], {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      timeout: 15000,
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    return {
      status: typeof error.status === "number" ? error.status : -1,
      stdout: error.stdout?.toString() || "",
      stderr: error.stderr?.toString() || String(error),
    };
  }
}

test("assemble_release.py publishes a full three-variant matrix release", () => {
  const partitionBytes = forgePartitionBytes();
  withForgedPartitionForAllVariants(partitionBytes, (variantsPath) => {
    const assetsRoot = mkdtempSync(path.join(tmpdir(), "assemble-assets-"));
    const outDir = path.join(mkdtempSync(path.join(tmpdir(), "assemble-out-")), "site");
    try {
      buildMatrixTree("aliro-v0.0.6-devkit", assetsRoot, partitionBytes);
      const result = runAssemble({
        tag: "aliro-v0.0.6-devkit",
        variantsPath,
        assetsRoot,
        outDir,
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      const files = readdirSync(outDir).sort();
      const expected = [];
      for (const variant of ["nanoc6-thread", "nanoc6-wifi", "atoms3-lite-wifi"]) {
        expected.push(`aliro-v0.0.6-devkit-${variant}-app.bin`);
        expected.push(`aliro-v0.0.6-devkit-${variant}-app.bin.sha256`);
        expected.push(`aliro-v0.0.6-devkit-${variant}-factory.bin`);
        expected.push(`aliro-v0.0.6-devkit-${variant}-factory.bin.sha256`);
        expected.push(`manifest-${variant}.json`);
        expected.push(`manifest-update-${variant}.json`);
      }
      assert.deepEqual(files, expected.sort(),
        "output must contain exactly the expected per-variant assets and manifests");

      // Factory manifest: auto-erase and one part at offset 0.
      for (const variant of ["nanoc6-thread", "nanoc6-wifi", "atoms3-lite-wifi"]) {
        const factoryManifest = JSON.parse(readFileSync(
          path.join(outDir, `manifest-${variant}.json`), "utf8"));
        assert.equal(factoryManifest.version, "aliro-v0.0.6-devkit");
        assert.equal(factoryManifest.new_install_prompt_erase, false,
          `${variant} factory manifest must auto-erase (new_install_prompt_erase=false)`);
        assert.equal(factoryManifest.builds.length, 1);
        assert.equal(factoryManifest.builds[0].parts.length, 1);
        assert.equal(factoryManifest.builds[0].parts[0].offset, 0);
        assert.match(factoryManifest.builds[0].parts[0].path,
          new RegExp(`^aliro-v0\\.0\\.6-devkit-${variant}-factory\\.bin$`));

        // Update manifest: keep-setup and two parts at approved OTA offsets.
        const updateManifest = JSON.parse(readFileSync(
          path.join(outDir, `manifest-update-${variant}.json`), "utf8"));
        assert.equal(updateManifest.new_install_prompt_erase, true,
          `${variant} update manifest must set new_install_prompt_erase=true so the guard fires`);
        assert.deepEqual(
          updateManifest.builds[0].parts.map((p) => p.offset).sort((a, b) => a - b),
          [0x20000, 0x200000],
          `${variant} update manifest must write app at both approved OTA offsets`,
        );
      }
    } finally {
      rmSync(assetsRoot, { recursive: true, force: true });
      rmSync(path.dirname(outDir), { recursive: true, force: true });
    }
  });
});

test("assemble_release.py fails closed on a missing package", () => {
  const partitionBytes = forgePartitionBytes();
  withForgedPartitionForAllVariants(partitionBytes, (variantsPath) => {
    const assetsRoot = mkdtempSync(path.join(tmpdir(), "assemble-assets-"));
    const outDir = path.join(mkdtempSync(path.join(tmpdir(), "assemble-out-")), "site");
    try {
      buildMatrixTree("aliro-v0.0.6-devkit", assetsRoot, partitionBytes);
      // Remove one required file from nanoc6-thread.
      rmSync(path.join(assetsRoot, "aliro-v0.0.6-devkit", "nanoc6-thread",
        "aliro-v0.0.6-devkit-nanoc6-thread-app.bin"));
      const result = runAssemble({
        tag: "aliro-v0.0.6-devkit",
        variantsPath, assetsRoot, outDir,
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /nanoc6-thread: missing required package file/);
      assert.equal(existsSync(outDir), false, "no output directory may be created");
    } finally {
      rmSync(assetsRoot, { recursive: true, force: true });
      rmSync(path.dirname(outDir), { recursive: true, force: true });
    }
  });
});

test("assemble_release.py fails closed on a bad sidecar", () => {
  const partitionBytes = forgePartitionBytes();
  withForgedPartitionForAllVariants(partitionBytes, (variantsPath) => {
    const assetsRoot = mkdtempSync(path.join(tmpdir(), "assemble-assets-"));
    const outDir = path.join(mkdtempSync(path.join(tmpdir(), "assemble-out-")), "site");
    try {
      buildMatrixTree("aliro-v0.0.6-devkit", assetsRoot, partitionBytes);
      const sidecar = path.join(assetsRoot, "aliro-v0.0.6-devkit", "nanoc6-wifi",
        "aliro-v0.0.6-devkit-nanoc6-wifi-factory.bin.sha256");
      writeFileSync(sidecar, `0000000000000000000000000000000000000000000000000000000000000000  aliro-v0.0.6-devkit-nanoc6-wifi-factory.bin\n`);
      const result = runAssemble({
        tag: "aliro-v0.0.6-devkit",
        variantsPath, assetsRoot, outDir,
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /nanoc6-wifi: factory sidecar/);
      assert.equal(existsSync(outDir), false);
    } finally {
      rmSync(assetsRoot, { recursive: true, force: true });
      rmSync(path.dirname(outDir), { recursive: true, force: true });
    }
  });
});

test("assemble_release.py fails closed on bad identity", () => {
  const partitionBytes = forgePartitionBytes();
  withForgedPartitionForAllVariants(partitionBytes, (variantsPath) => {
    const assetsRoot = mkdtempSync(path.join(tmpdir(), "assemble-assets-"));
    const outDir = path.join(mkdtempSync(path.join(tmpdir(), "assemble-out-")), "site");
    try {
      buildMatrixTree("aliro-v0.0.6-devkit", assetsRoot, partitionBytes);
      const manifest = path.join(assetsRoot, "aliro-v0.0.6-devkit", "atoms3-lite-wifi",
        "aliro-v0.0.6-devkit-atoms3-lite-wifi-manifest.txt");
      const text = readFileSync(manifest, "utf8")
        .replace(/^project_name:.*$/m, "project_name: door_lock");
      writeFileSync(manifest, text);
      const result = runAssemble({
        tag: "aliro-v0.0.6-devkit",
        variantsPath, assetsRoot, outDir,
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /atoms3-lite-wifi: manifest 'project_name' is 'door_lock'/);
      assert.equal(existsSync(outDir), false);
    } finally {
      rmSync(assetsRoot, { recursive: true, force: true });
      rmSync(path.dirname(outDir), { recursive: true, force: true });
    }
  });
});

test("assemble_release.py fails closed on a bad partition slice", () => {
  const partitionBytes = forgePartitionBytes();
  withForgedPartitionForAllVariants(partitionBytes, (variantsPath) => {
    const assetsRoot = mkdtempSync(path.join(tmpdir(), "assemble-assets-"));
    const outDir = path.join(mkdtempSync(path.join(tmpdir(), "assemble-out-")), "site");
    try {
      buildMatrixTree("aliro-v0.0.6-devkit", assetsRoot, partitionBytes);
      // Corrupt bytes at 0xC000 in nanoc6-thread's factory image so its
      // embedded partition SHA no longer matches the approved hash.
      const factory = path.join(assetsRoot, "aliro-v0.0.6-devkit", "nanoc6-thread",
        "aliro-v0.0.6-devkit-nanoc6-thread-factory.bin");
      const buf = Buffer.from(readFileSync(factory));
      buf.fill(0xAA, 0xC000, 0xC000 + 0xC00);
      writeFileSync(factory, buf);
      // Regenerate the factory sidecar so the assembler passes the
      // sidecar check and reaches the partition-slice check.
      const factorySha = createHash("sha256").update(buf).digest("hex");
      writeFileSync(`${factory}.sha256`,
        `${factorySha}  aliro-v0.0.6-devkit-nanoc6-thread-factory.bin\n`);
      const result = runAssemble({
        tag: "aliro-v0.0.6-devkit",
        variantsPath, assetsRoot, outDir,
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /nanoc6-thread: embedded partition SHA .* != approved/);
      assert.equal(existsSync(outDir), false);
    } finally {
      rmSync(assetsRoot, { recursive: true, force: true });
      rmSync(path.dirname(outDir), { recursive: true, force: true });
    }
  });
});

test("assemble_release.py fails closed on a bad embedded app slice", () => {
  const partitionBytes = forgePartitionBytes();
  withForgedPartitionForAllVariants(partitionBytes, (variantsPath) => {
    const assetsRoot = mkdtempSync(path.join(tmpdir(), "assemble-assets-"));
    const outDir = path.join(mkdtempSync(path.join(tmpdir(), "assemble-out-")), "site");
    try {
      buildMatrixTree("aliro-v0.0.6-devkit", assetsRoot, partitionBytes);
      // Corrupt the embedded app at 0x20000 in the factory image
      // without touching the standalone app.bin. Regenerate the
      // factory sidecar so we reach the embedded-app check.
      const factory = path.join(assetsRoot, "aliro-v0.0.6-devkit", "nanoc6-wifi",
        "aliro-v0.0.6-devkit-nanoc6-wifi-factory.bin");
      const buf = Buffer.from(readFileSync(factory));
      buf.fill(0xBB, 0x20000, 0x20000 + 0x100);
      writeFileSync(factory, buf);
      const factorySha = createHash("sha256").update(buf).digest("hex");
      writeFileSync(`${factory}.sha256`,
        `${factorySha}  aliro-v0.0.6-devkit-nanoc6-wifi-factory.bin\n`);
      const result = runAssemble({
        tag: "aliro-v0.0.6-devkit",
        variantsPath, assetsRoot, outDir,
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /nanoc6-wifi: embedded app SHA .* != standalone app SHA/);
      assert.equal(existsSync(outDir), false);
    } finally {
      rmSync(assetsRoot, { recursive: true, force: true });
      rmSync(path.dirname(outDir), { recursive: true, force: true });
    }
  });
});

test("assemble_release.py fails and preserves the destination inode when an empty directory appears at the race point", () => {
  // The blocked parent (f2a7535) had this exact P1 gap: os.rename on
  // POSIX silently replaces an EMPTY destination directory created
  // between the initial existence check and the rename. A test that
  // pre-creates the destination BEFORE _assemble runs would trip the
  // initial existence check on both f2a7535 AND the current head, so
  // it never exercises the race. The scenario script below imports
  // assemble_release and monkeypatches _stage_variant to create the
  // empty destination during staging — the exact race window. On
  // f2a7535 the rename succeeds and the scenario exits non-zero
  // because the assembler did not raise. On the current head the
  // sibling publication lock plus the pre-rename existence check both
  // fire, _assemble raises AssemblyError, and the injected empty
  // directory keeps its inode.
  const partitionBytes = forgePartitionBytes();
  withForgedPartitionForAllVariants(partitionBytes, (variantsPath) => {
    const assetsRoot = mkdtempSync(path.join(tmpdir(), "assemble-assets-"));
    const outParent = mkdtempSync(path.join(tmpdir(), "assemble-out-"));
    const outDir = path.join(outParent, "site");
    try {
      buildMatrixTree("aliro-v0.0.6-devkit", assetsRoot, partitionBytes);
      const scenarioPath = new URL("./assemble_release_race_scenario.py", import.meta.url).pathname;
      const scriptPath = new URL("../../scripts/assemble_release.py", import.meta.url).pathname;
      let result;
      try {
        const stdout = execFileSync("python3", [
          scenarioPath,
          "--script", scriptPath,
          "--tag", "aliro-v0.0.6-devkit",
          "--variants", variantsPath,
          "--assets", assetsRoot,
          "--out", outDir,
        ], { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout: 30000 });
        result = { status: 0, stdout, stderr: "" };
      } catch (error) {
        result = {
          status: typeof error.status === "number" ? error.status : -1,
          stdout: error.stdout?.toString() || "",
          stderr: error.stderr?.toString() || String(error),
        };
      }
      assert.equal(result.status, 0,
        "scenario must exit 0 (assembler raised AND inode preserved). scenario stderr: " + result.stderr);
      assert.match(result.stdout, /assembler raised:/);
      assert.match(result.stdout, /destination inode preserved:/);
      // No stage residue in the parent.
      for (const entry of readdirSync(outParent)) {
        assert.doesNotMatch(entry, /\.stage\./,
          `no stage residue allowed under ${outParent}: found ${entry}`);
      }
    } finally {
      rmSync(assetsRoot, { recursive: true, force: true });
      rmSync(outParent, { recursive: true, force: true });
    }
  });
});

// --- deploy-installer.yml Phase 1B matrix flow assertions ---
// These read the workflow as text and verify the contract expected
// by Phase 1B task 5B: only the matrix flow, no old aliro-c6 flow,
// no placeholder writes, all three packages required from one tag,
// the assembler is called, its per-variant output is copied, and
// the current UI aliases point at the nanoc6-thread manifests.

test("deploy-installer.yml drops the old aliro-c6 single-image flow and every placeholder path", () => {
  const workflow = readFileSync(
    new URL("../../.github/workflows/deploy-installer.yml", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(workflow, /aliro-c6-/,
    "old aliro-c6-* prefix must not appear anywhere in the workflow");
  // Placeholder / empty manifest paths from the old flow.
  for (const pattern of [
    /no firmware yet/i,
    /placeholder manifest/i,
    /"builds": *\[\]/,
    /no_binary\.flag/,
    /publishing empty manifests/i,
  ]) {
    assert.doesNotMatch(workflow, pattern,
      `workflow must not contain placeholder path: ${pattern}`);
  }
});

test("deploy-installer.yml requires every variant's five-file package from one matrix release tag", () => {
  const workflow = readFileSync(
    new URL("../../.github/workflows/deploy-installer.yml", import.meta.url),
    "utf8",
  );
  // Strict matrix tag pattern is used to filter releases.
  assert.match(workflow, /aliro-v\\d\+\\\.\\d\+\\\.\\d\+/);
  // The three required variants are listed as REQUIRED_VARIANT_IDS.
  assert.match(workflow, /REQUIRED_VARIANT_IDS = \("nanoc6-thread", "nanoc6-wifi", "atoms3-lite-wifi"\)/);
  // Each variant requires exactly the five file names.
  for (const suffix of [
    "-factory.bin",
    "-factory.bin.sha256",
    "-app.bin",
    "-app.bin.sha256",
    "-manifest.txt",
  ]) {
    assert.match(workflow, new RegExp(`f"{stem}${suffix}"`),
      `workflow must require every variant to ship ${suffix}`);
  }
  // Every asset must be present exactly once.
  assert.match(workflow, /must have exactly one .* asset \(got \{len\(matches\)\}\)/);
  // Extra assets outside the required matrix set are rejected.
  assert.match(workflow, /carries assets outside the required matrix set/);
});

test("deploy-installer.yml calls scripts/assemble_release.py before Pages upload and copies its output", () => {
  const workflow = readFileSync(
    new URL("../../.github/workflows/deploy-installer.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /python3 scripts\/assemble_release\.py \\/,
    "workflow must invoke scripts/assemble_release.py");
  assert.match(workflow, /--tag "\$\{\{ steps\.matrix\.outputs\.tag \}\}"/);
  assert.match(workflow, /--variants firmware\/variants\.json/);
  assert.match(workflow, /--assets  "\$\{\{ steps\.matrix\.outputs\.assets_dir \}\}"/);
  assert.match(workflow, /--out     work\/assembled/);
  // The verified output gets copied into _site before Pages runs.
  assert.match(workflow, /cp -R work\/assembled\/\. _site\//);
  // Order: the assemble step must appear BEFORE upload-pages-artifact.
  const assemblePos = workflow.indexOf("Assemble the matrix release");
  const uploadPos = workflow.indexOf("upload-pages-artifact");
  const deployPos = workflow.indexOf("deploy-pages");
  assert.ok(assemblePos > 0 && uploadPos > 0 && deployPos > 0);
  assert.ok(assemblePos < uploadPos,
    "assembler must run before Pages upload");
  assert.ok(uploadPos < deployPos,
    "Pages upload must precede deploy");
});

test("deploy-installer.yml aliases manifest.json and manifest-update.json to the nanoc6-thread manifests", () => {
  const workflow = readFileSync(
    new URL("../../.github/workflows/deploy-installer.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /test -f "_site\/manifest-nanoc6-thread\.json"/,
    "alias step must first assert the source manifest exists");
  assert.match(workflow, /test -f "_site\/manifest-update-nanoc6-thread\.json"/);
  assert.match(workflow, /cp "_site\/manifest-nanoc6-thread\.json" "_site\/manifest\.json"/);
  assert.match(workflow,
    /cp "_site\/manifest-update-nanoc6-thread\.json" "_site\/manifest-update\.json"/);
  // No other variant may be aliased to the UI-facing names.
  assert.doesNotMatch(workflow, /manifest-nanoc6-wifi\.json"\s+"_site\/manifest\.json"/);
  assert.doesNotMatch(workflow,
    /manifest-atoms3-lite-wifi\.json"\s+"_site\/manifest\.json"/);
});

test("deploy-installer.yml does not write releases.json until code consumes it", () => {
  const workflow = readFileSync(
    new URL("../../.github/workflows/deploy-installer.yml", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(workflow, /releases\.json/,
    "workflow must not create releases.json unless current code consumes it");
});

// --- firmware-matrix.js safety model tests ---
// The module holds the exact shipped-variant set and two helpers that
// gate what the installer UI is allowed to write. These tests are
// table-driven and cover every documented allow / deny path.

test("firmware-matrix exposes exactly the three shipped variants with the right transports and manifests", () => {
  assert.deepEqual(getSupportedVariantIds().sort(),
    ["atoms3-lite-wifi", "nanoc6-thread", "nanoc6-wifi"]);
  const rows = [
    ["nanoc6-thread",    "thread", "M5Stack NanoC6",
     "manifest-nanoc6-thread.json", "manifest-update-nanoc6-thread.json"],
    ["nanoc6-wifi",      "wifi",   "M5Stack NanoC6",
     "manifest-nanoc6-wifi.json",   "manifest-update-nanoc6-wifi.json"],
    ["atoms3-lite-wifi", "wifi",   "M5Stack AtomS3 Lite",
     "manifest-atoms3-lite-wifi.json", "manifest-update-atoms3-lite-wifi.json"],
  ];
  for (const [id, transport, boardLabel, mfFactory, mfUpdate] of rows) {
    const entry = getVariant(id);
    assert.ok(entry, `variant ${id} must be present`);
    assert.equal(entry.transport, transport);
    assert.equal(entry.boardLabel, boardLabel);
    assert.equal(entry.manifestFactory, mfFactory);
    assert.equal(entry.manifestUpdate, mfUpdate);
  }
  assert.equal(getVariant("does-not-exist"), null);
});

test("firmware-matrix selectFactoryVariant always resolves and exposes the erase-and-recommission requirement", () => {
  for (const id of ["nanoc6-thread", "nanoc6-wifi", "atoms3-lite-wifi"]) {
    const pick = selectFactoryVariant(id);
    assert.equal(pick.variant.id, id);
    assert.equal(pick.manifest, `manifest-${id}.json`);
    assert.equal(pick.mustEraseAndRecommission, true,
      `${id}: factory selection must mark erase-and-recommission as required`);
    assert.match(pick.note, /erases/i);
    assert.match(pick.note, /add the device to your smart home again/i);
  }
  assert.throws(() => selectFactoryVariant("mystery-board"), /unknown variant/);
});

test("firmware-matrix checkPreservingUpdate handles every allow and deny path", () => {
  // A fully-validated status object matches every field
  // parseAliroProtocolLine produces (types and ranges included). The
  // guard must reject anything less.
  const goodStatus = (over = {}) => Object.assign({
    firmware: "0.0.6-devkit",
    protocol: 1,
    variant: "nanoc6-thread",
    transport: "thread",
    variantExplicit: true,
    transportExplicit: true,
    auto_relock_seconds: 5,
    success_rgb: "#00ff00",
    success_ms: 1000,
    failure_rgb: "#ff0000",
    failure_ms: 1000,
    other_rgb: "#0000ff",
    other_ms: 1000,
  }, over);

  const cases = [
    // Three valid statuses — one per shipped variant.
    {
      name: "nanoc6-thread reports its variant and transport",
      status: goodStatus({ variant: "nanoc6-thread", transport: "thread" }),
      expect: { allowed: true, targetVariant: "nanoc6-thread",
                manifest: "manifest-update-nanoc6-thread.json" },
    },
    {
      name: "nanoc6-wifi reports its variant and transport",
      status: goodStatus({ variant: "nanoc6-wifi", transport: "wifi" }),
      expect: { allowed: true, targetVariant: "nanoc6-wifi",
                manifest: "manifest-update-nanoc6-wifi.json" },
    },
    {
      name: "atoms3-lite-wifi reports its variant and transport",
      status: goodStatus({ variant: "atoms3-lite-wifi", transport: "wifi" }),
      expect: { allowed: true, targetVariant: "atoms3-lite-wifi",
                manifest: "manifest-update-atoms3-lite-wifi.json" },
    },
    // Deny paths.
    {
      name: "null status is malformed",
      status: null,
      expect: { allowed: false, reason: matrixInternals.REASON.MALFORMED_STATUS },
    },
    {
      name: "non-object status is malformed",
      status: "not-a-status",
      expect: { allowed: false, reason: matrixInternals.REASON.MALFORMED_STATUS },
    },
    {
      name: "legacy default (variantExplicit=false) is refused",
      status: goodStatus({ variantExplicit: false }),
      expect: { allowed: false, reason: matrixInternals.REASON.NO_VARIANT_REPORTED },
    },
    {
      name: "legacy default (transportExplicit=false) is refused",
      status: goodStatus({ transportExplicit: false }),
      expect: { allowed: false, reason: matrixInternals.REASON.NO_TRANSPORT_REPORTED },
    },
    {
      name: "unknown variant is refused",
      status: goodStatus({ variant: "mystery-board", transport: "thread" }),
      expect: { allowed: false, reason: matrixInternals.REASON.UNKNOWN_VARIANT },
    },
    {
      name: "transport mismatch: nanoc6-wifi shipping thread",
      status: goodStatus({ variant: "nanoc6-wifi", transport: "thread" }),
      expect: { allowed: false, reason: matrixInternals.REASON.TRANSPORT_MISMATCH },
    },
    {
      name: "transport mismatch: nanoc6-thread shipping wifi",
      status: goodStatus({ variant: "nanoc6-thread", transport: "wifi" }),
      expect: { allowed: false, reason: matrixInternals.REASON.TRANSPORT_MISMATCH },
    },
    {
      name: "transport mismatch: atoms3-lite-wifi shipping thread",
      status: goodStatus({ variant: "atoms3-lite-wifi", transport: "thread" }),
      expect: { allowed: false, reason: matrixInternals.REASON.TRANSPORT_MISMATCH },
    },
  ];

  for (const testCase of cases) {
    const result = checkPreservingUpdate(testCase.status);
    for (const [key, value] of Object.entries(testCase.expect)) {
      assert.equal(result[key], value,
        `${testCase.name}: expected ${key}=${value}, got ${result[key]}`);
    }
    if (result.allowed === false) {
      assert.ok(typeof result.note === "string" && result.note.length > 0,
        `${testCase.name}: deny cases must carry a human note`);
    }
  }
});

test("parseDevkitVersion accepts every documented shape and rejects malformed input", () => {
  const good = [
    ["aliro-c6-v0.0.5-devkit", [0, 0, 5]],
    ["aliro-v0.0.6-devkit",    [0, 0, 6]],
    ["v0.0.6-devkit",          [0, 0, 6]],
    ["0.0.6-devkit",           [0, 0, 6]],
    ["aliro-v1.2.3-devkit",    [1, 2, 3]],
  ];
  for (const [text, parts] of good) {
    const parsed = parseDevkitVersion(text);
    assert.ok(parsed, `expected ${JSON.stringify(text)} to parse`);
    assert.deepEqual(parsed.parts, parts, `parts of ${text}`);
    assert.equal(parsed.normalized, `${parts.join(".")}-devkit`,
      `normalized form of ${text}`);
  }
  const bad = [
    null, undefined, 0, {}, "",
    "aliro-c7-v0.0.5-devkit",   // unknown chip prefix
    "aliro-v0.0.6",              // missing -devkit
    "aliro-v0.0.6-release",      // wrong suffix
    "aliro-v0.0-devkit",         // only two version parts
    "aliro-v0.0.6.7-devkit",     // four version parts
    "aliro-v-devkit",            // no version
    "aliro-vabc.def.ghi-devkit", // non-numeric
    "aliro-v0.0.06-devkit-extra",// trailing junk
    // Every aliro- prefix MUST carry `v` before the version.
    "aliro-0.0.6-devkit",        // aliro- prefix without v
    "aliro-c6-0.0.5-devkit",     // legacy aliro-c6- without v
  ];
  for (const value of bad) {
    assert.equal(parseDevkitVersion(value), null,
      `expected ${JSON.stringify(value)} to be rejected`);
  }
});

test("firmware-matrix checkPreservingUpdate refuses the four-field partial status as malformed", () => {
  // Correction 1 regression: the previous guard only checked the four
  // matrix fields (variant, transport, variantExplicit,
  // transportExplicit). A caller could smuggle in a hand-built
  // object with just those fields and the guard would allow the
  // update. The new guard requires the complete validated STATUS
  // shape that parseAliroProtocolLine produces.
  const fourFieldPartial = {
    variant: "nanoc6-thread",
    transport: "thread",
    variantExplicit: true,
    transportExplicit: true,
  };
  const result = checkPreservingUpdate(fourFieldPartial);
  assert.equal(result.allowed, false);
  assert.equal(result.reason, matrixInternals.REASON.MALFORMED_STATUS);
});

test("firmware-matrix rejects every inherited object key on the VARIANTS lookup", () => {
  // Correction 1 regression: without own-property-only lookup, a
  // key like 'constructor', 'toString', or '__proto__' would resolve
  // to an inherited Object.prototype value and slip past every
  // guard. Every inherited key must therefore behave like an unknown
  // variant.
  for (const key of [
    "constructor", "toString", "valueOf", "hasOwnProperty",
    "isPrototypeOf", "propertyIsEnumerable", "__proto__",
  ]) {
    assert.equal(getVariant(key), null,
      `getVariant(${JSON.stringify(key)}) must be null`);
    assert.throws(() => selectFactoryVariant(key), /unknown variant/,
      `selectFactoryVariant(${JSON.stringify(key)}) must throw`);
    const denied = checkPreservingUpdate({
      firmware: "0.0.6-devkit",
      protocol: 1,
      variant: key,
      transport: "thread",
      variantExplicit: true,
      transportExplicit: true,
      auto_relock_seconds: 5,
      success_rgb: "#00ff00", success_ms: 1000,
      failure_rgb: "#ff0000", failure_ms: 1000,
      other_rgb: "#0000ff",  other_ms: 1000,
    });
    // Prototype keys are lowercase kebab-invalid; some fail
    // IDENTIFIER_PATTERN and return MALFORMED_STATUS. `constructor`,
    // `tostring`, `valueof`, `hasownproperty`, `isprototypeof`,
    // `propertyisenumerable`, `__proto__` — the identifier pattern
    // rejects `_` and requires kebab. Both refusal paths are safe
    // and never produce a manifest.
    assert.equal(denied.allowed, false,
      `checkPreservingUpdate variant=${key} must be refused`);
    assert.ok(denied.reason === matrixInternals.REASON.UNKNOWN_VARIANT
      || denied.reason === matrixInternals.REASON.MALFORMED_STATUS,
      `unexpected refusal reason for ${key}: ${denied.reason}`);
  }
});

// Phase 1B task 6B: matrix safety model wired into the installer UI.
// The controller drives one factory variant selector and a preserving-
// update button. The button starts inert without a manifest; only a
// complete, explicit, supported STATUS with a matching transport ever
// gives it a manifest and enables it. Every other STATUS (legacy,
// malformed, unknown, mismatch) and every disconnect must invalidate
// the target and re-inert the button. The dialog guard follows the
// exact dynamic manifest and never leaves a duplicate observer.

function fakeVariantSelector(initial = "nanoc6-thread") {
  const control = new FakeControl();
  control.value = initial;
  return control;
}

function explicitStatusFor(variant, transport, extras = {}) {
  return {
    ...EXPLICIT_STATUS,
    variant,
    transport,
    ...extras,
  };
}

function bootedController({
  attachDialogGuard = () => ({ disconnect() {} }),
  factoryVariantSelector,
  factoryWarning,
} = {}) {
  const factoryButton = new FakeInstallButton();
  const updateButton = new FakeInstallButton();
  const serialMonitor = new FakeProtocolMonitor();
  const setupFlow = {
    begin: () => new AbortController().signal,
    finish() {},
    finishPreservedUpdate() {},
  };
  configureInstallButtons({
    factoryButton,
    updateButton,
    setupFlow,
    serialMonitor,
    factoryVariantSelector,
    factoryWarning,
    attachDialogGuard,
  });
  return { factoryButton, updateButton, serialMonitor, setupFlow };
}

test("factory selector wires each of the three shipped variants to its factory manifest", () => {
  const selector = fakeVariantSelector("nanoc6-thread");
  const warning = new FakeControl();
  const { factoryButton } = bootedController({
    factoryVariantSelector: selector,
    factoryWarning: warning,
  });

  // Default selection is applied at boot.
  assert.equal(factoryButton.manifest, "manifest-nanoc6-thread.json");
  assert.equal(warning.hidden, false, "warning must be visible");
  assert.match(warning.textContent, /erases the whole flash/i);
  assert.match(warning.textContent, /add the device to your smart home again/i);

  const rows = [
    ["nanoc6-thread",    "manifest-nanoc6-thread.json"],
    ["nanoc6-wifi",      "manifest-nanoc6-wifi.json"],
    ["atoms3-lite-wifi", "manifest-atoms3-lite-wifi.json"],
  ];
  for (const [id, expected] of rows) {
    selector.value = id;
    selector.dispatchEvent(new Event("change"));
    assert.equal(factoryButton.manifest, expected,
      `selection ${id} must set factory manifest ${expected}`);
    assert.equal(factoryButton.getAttribute("manifest"), expected,
      `selection ${id} must mirror the manifest attribute for esp-web-tools`);
    assert.match(warning.textContent, /erases the whole flash/i,
      `selection ${id} must keep the erase-and-recommission warning visible`);
    assert.equal(warning.hidden, false, `selection ${id} keeps the warning visible`);
  }
});

test("update button starts inert with no manifest and every deny path re-inerts it", () => {
  const attaches = [];
  const disconnects = [];
  const attachDialogGuard = ({ updateManifestPath }) => {
    attaches.push(updateManifestPath);
    return { disconnect() { disconnects.push(updateManifestPath); } };
  };
  const { updateButton, serialMonitor } = bootedController({ attachDialogGuard });

  // Boot: inert, no manifest, no observer attached.
  assert.equal(updateButton.inert, true);
  assert.equal(updateButton.activator.disabled, true);
  assert.equal(updateButton.manifest ?? null, null);
  assert.equal(updateButton.getAttribute("manifest"), null);
  assert.deepEqual(attaches, []);

  // Enable once so the deny paths can be observed to un-enable.
  const enable = () => serialMonitor.dispatchEvent(new CustomEvent("aliro-status", {
    detail: explicitStatusFor("nanoc6-thread", "thread"),
  }));

  const denyCases = [
    ["legacy (variantExplicit=false)", { ...EXPLICIT_STATUS, variantExplicit: false }],
    ["legacy (transportExplicit=false)", { ...EXPLICIT_STATUS, transportExplicit: false }],
    ["malformed status (four-field partial)", {
      variant: "nanoc6-thread", transport: "thread",
      variantExplicit: true, transportExplicit: true,
    }],
    ["null status", null],
    ["non-object status", "not-a-status"],
    ["unknown variant", explicitStatusFor("mystery-board", "thread")],
    ["transport mismatch", explicitStatusFor("nanoc6-wifi", "thread")],
    ["transport mismatch (thread over wifi)", explicitStatusFor("nanoc6-thread", "wifi")],
    ["atoms3-lite-wifi shipping thread", explicitStatusFor("atoms3-lite-wifi", "thread")],
    ["invalid identifier pattern", explicitStatusFor("Not_Valid", "thread")],
    ["out-of-range setting", explicitStatusFor("nanoc6-thread", "thread",
      { auto_relock_seconds: 999999 })],
    ["missing setting field",
     (() => { const s = explicitStatusFor("nanoc6-thread", "thread"); delete s.success_rgb; return s; })()],
    ["bad rgb", explicitStatusFor("nanoc6-thread", "thread", { success_rgb: "green" })],
    ["wrong protocol", explicitStatusFor("nanoc6-thread", "thread", { protocol: 2 })],
    ["bad firmware string", explicitStatusFor("nanoc6-thread", "thread", { firmware: "1.0" })],
  ];

  for (const [name, status] of denyCases) {
    enable();
    assert.equal(updateButton.inert, false, `precondition failed for ${name}`);
    serialMonitor.dispatchEvent(new CustomEvent("aliro-status", { detail: status }));
    assert.equal(updateButton.inert, true, `${name}: update button must be inert`);
    assert.equal(updateButton.activator.disabled, true,
      `${name}: activator must be disabled`);
    assert.equal(updateButton.manifest ?? null, null,
      `${name}: manifest must be cleared`);
    assert.equal(updateButton.getAttribute("manifest"), null,
      `${name}: manifest attribute must be cleared`);
  }

  // A disconnect from any state must also re-inert.
  enable();
  assert.equal(updateButton.inert, false);
  serialMonitor.dispatchEvent(new CustomEvent("serial-disconnected"));
  assert.equal(updateButton.inert, true, "disconnect must re-inert the update button");
  assert.equal(updateButton.manifest ?? null, null,
    "disconnect must clear the update manifest");
});

test("each explicit supported STATUS sets the exact matching update manifest", () => {
  const rows = [
    ["nanoc6-thread",    "thread", "manifest-update-nanoc6-thread.json"],
    ["nanoc6-wifi",      "wifi",   "manifest-update-nanoc6-wifi.json"],
    ["atoms3-lite-wifi", "wifi",   "manifest-update-atoms3-lite-wifi.json"],
  ];
  for (const [variant, transport, manifest] of rows) {
    const { updateButton, serialMonitor } = bootedController();
    serialMonitor.dispatchEvent(new CustomEvent("aliro-status", {
      detail: explicitStatusFor(variant, transport),
    }));
    assert.equal(updateButton.manifest, manifest,
      `${variant}/${transport} must set update manifest to ${manifest}`);
    assert.equal(updateButton.getAttribute("manifest"), manifest,
      `${variant}/${transport} must mirror the manifest attribute`);
    assert.equal(updateButton.inert, false, `${variant}/${transport} enables the button`);
    assert.equal(updateButton.activator.disabled, false,
      `${variant}/${transport} enables the activator`);
  }
});

test("update-dialog guard follows the dynamic exact manifest without duplicate observers", () => {
  const attaches = [];
  let disconnectedTotal = 0;
  const openHandles = new Set();
  const attachDialogGuard = ({ updateManifestPath }) => {
    attaches.push(updateManifestPath);
    const handle = {
      manifest: updateManifestPath,
      disconnect() {
        if (!openHandles.has(handle)) return;
        openHandles.delete(handle);
        disconnectedTotal += 1;
      },
    };
    openHandles.add(handle);
    return handle;
  };
  const { serialMonitor } = bootedController({ attachDialogGuard });

  // No observer at boot.
  assert.deepEqual(attaches, []);
  assert.equal(openHandles.size, 0);

  // First eligible STATUS attaches one observer for the exact manifest.
  serialMonitor.dispatchEvent(new CustomEvent("aliro-status", {
    detail: explicitStatusFor("nanoc6-thread", "thread"),
  }));
  assert.deepEqual(attaches, ["manifest-update-nanoc6-thread.json"]);
  assert.equal(openHandles.size, 1);

  // Repeated identical STATUS must NOT attach a duplicate observer.
  serialMonitor.dispatchEvent(new CustomEvent("aliro-status", {
    detail: explicitStatusFor("nanoc6-thread", "thread"),
  }));
  assert.deepEqual(attaches, ["manifest-update-nanoc6-thread.json"],
    "same-manifest STATUS must not re-attach the guard");
  assert.equal(openHandles.size, 1, "only one observer stays open");
  assert.equal(disconnectedTotal, 0);

  // A different eligible variant swaps the observer atomically.
  serialMonitor.dispatchEvent(new CustomEvent("aliro-status", {
    detail: explicitStatusFor("nanoc6-wifi", "wifi"),
  }));
  assert.deepEqual(attaches, [
    "manifest-update-nanoc6-thread.json",
    "manifest-update-nanoc6-wifi.json",
  ]);
  assert.equal(openHandles.size, 1, "old observer disconnects, new one attaches");
  assert.equal(disconnectedTotal, 1);
  assert.equal([...openHandles][0].manifest, "manifest-update-nanoc6-wifi.json");

  // A deny path disconnects the current observer and leaves none open.
  serialMonitor.dispatchEvent(new CustomEvent("aliro-status", {
    detail: explicitStatusFor("mystery-board", "thread"),
  }));
  assert.equal(openHandles.size, 0, "unknown variant disconnects the guard");
  assert.equal(disconnectedTotal, 2);

  // A later eligible STATUS attaches a fresh observer without duplicates.
  serialMonitor.dispatchEvent(new CustomEvent("aliro-status", {
    detail: explicitStatusFor("atoms3-lite-wifi", "wifi"),
  }));
  assert.equal(openHandles.size, 1);
  assert.equal([...openHandles][0].manifest, "manifest-update-atoms3-lite-wifi.json");
});

test("factory post-flash STATUS also flows through the preserving-update guard", async () => {
  const attaches = [];
  const attachDialogGuard = ({ updateManifestPath }) => {
    attaches.push(updateManifestPath);
    return { disconnect() {} };
  };
  const factoryButton = new FakeInstallButton();
  const updateButton = new FakeInstallButton();
  const setupFlow = {
    begin: () => new AbortController().signal,
    finish() {},
    finishPreservedUpdate() {},
  };
  const settingsCalls = [];
  const deviceSettings = { applyStatus(status) { settingsCalls.push(status); } };
  const bootLog = new TextEncoder().encode(
    "I chip[SVR]: SetupQRCode: [MT:Y.K9042C00KA0648G00]\n" +
    "I chip[SVR]: Manual pairing code: [34970112332]\n",
  );
  // The post-flash STATUS announces variant + transport explicitly so
  // checkPreservingUpdate must accept it and set the exact manifest.
  const statusLine = new TextEncoder().encode(
    "ALIRO/1 STATUS firmware=0.0.6-devkit protocol=1 " +
    "auto_relock_seconds=10 success_rgb=00FF00 success_ms=750 " +
    "failure_rgb=ff0000 failure_ms=900 other_rgb=0000ff other_ms=500 " +
    "variant=atoms3-lite-wifi transport=wifi\n",
  );
  const port = twoPassSerialPort([bootLog, statusLine]);
  configureInstallButtons({
    factoryButton,
    updateButton,
    setupFlow,
    deviceSettings,
    logger: { log() {}, error() {} },
    attachDialogGuard,
    statusTimeoutMs: 200,
  });

  await factoryButton.onPostFlash(port);

  assert.equal(settingsCalls.length, 1);
  assert.equal(settingsCalls[0].variant, "atoms3-lite-wifi");
  assert.equal(updateButton.manifest, "manifest-update-atoms3-lite-wifi.json",
    "post-flash STATUS must set the exact matching update manifest");
  assert.equal(updateButton.inert, false);
  assert.deepEqual(attaches, ["manifest-update-atoms3-lite-wifi.json"],
    "post-flash STATUS attaches the guard for the exact manifest");
});

test("HTML wires the three-variant selector, warning, and inert update button without a default manifest", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

  // Selector: three options, default nanoc6-thread first.
  assert.match(html, /<select id="factory-variant"[\s\S]*?<\/select>/,
    "factory-variant selector must exist");
  const selector = html.match(/<select id="factory-variant"[\s\S]*?<\/select>/)[0];
  assert.match(selector, /<option value="nanoc6-thread">M5Stack NanoC6 — Matter over Thread<\/option>/);
  assert.match(selector, /<option value="nanoc6-wifi">M5Stack NanoC6 — Matter over Wi-Fi<\/option>/);
  assert.match(selector, /<option value="atoms3-lite-wifi">M5Stack AtomS3 Lite — Matter over Wi-Fi<\/option>/);
  // Only these three options exist.
  const options = [...selector.matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(options, ["nanoc6-thread", "nanoc6-wifi", "atoms3-lite-wifi"],
    "the selector must expose exactly the three shipped variants in order");

  // Erase-and-recommission warning. Allow whitespace between words so the
  // HTML source can wrap freely without breaking the assertion.
  const warning = html.match(/id="factory-warning"[^>]*>[\s\S]*?<\/div>/)[0];
  assert.match(warning, /erases the whole flash/i);
  assert.match(warning, /add the device\s+to your smart home again/i);

  // Update button starts inert with NO usable manifest attribute.
  const updateButton = html.match(/<esp-web-install-button\b[^>]*id="update-button"[\s\S]*?<\/esp-web-install-button>/)[0];
  assert.doesNotMatch(updateButton, /\bmanifest=/,
    "update button must not carry a manifest attribute at boot");
  assert.match(updateButton, /\binert\b/,
    "update button must start inert");

  // Factory button no longer hard-codes a manifest.
  const factoryButton = html.match(/<esp-web-install-button\b[^>]*id="factory-button"[\s\S]*?<\/esp-web-install-button>/)[0];
  assert.doesNotMatch(factoryButton, /\bmanifest=/,
    "factory button must not carry a manifest attribute; the selector wires it");
  assert.match(factoryButton, /\binert\b/,
    "factory button must start inert until the controller resolves the selection");

  // Update-action wrapper starts hidden until eligibility is established.
  assert.match(html, /id="update-action"[^>]*\bhidden\b/,
    "update-action wrapper must start hidden until STATUS proves eligibility");

  // Prerequisites now describe both transports, not Thread only.
  assert.match(html, /Thread border router/);
  assert.match(html, /2\.4 GHz Wi-Fi/);
  assert.match(html, /AtomS3 Lite/);
});

test("README and installer link to each other", () => {
  const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

  assert.match(
    readme,
    /\[[^\]]+\]\(https:\/\/mullender\.github\.io\/aliro-doorlock-esp32\/\)/,
  );
  assert.match(
    html,
    /href=["']https:\/\/github\.com\/mullender\/aliro-doorlock-esp32["']/,
  );
});

test("installer page keeps connection at the top and logs at the bottom", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const connection = html.indexOf('id="connection-heading"');
  const connectButton = html.indexOf('id="serial-connect"');
  const serialStatus = html.indexOf('id="serial-status"');
  const settings = html.indexOf('id="device-settings"');
  const prerequisites = html.indexOf("<h2>Before you start</h2>");
  const update = html.indexOf('id="update-heading"');
  const factory = html.indexOf('id="factory-heading"');
  const logs = html.indexOf('id="serial-heading"');
  const resetButton = html.indexOf('id="serial-reset"');
  const serialLog = html.indexOf('id="serial-log"');
  const footer = html.indexOf("<footer>");

  assert.ok(connection >= 0);
  assert.ok(connection < connectButton);
  assert.ok(connectButton < serialStatus);
  assert.ok(serialStatus < settings);
  assert.ok(settings < prerequisites);
  assert.ok(prerequisites < update);
  assert.ok(update < factory);
  assert.ok(factory < logs);
  assert.ok(logs < resetButton);
  assert.ok(resetButton < serialLog);
  assert.ok(serialLog < footer);
});

// The update-dialog guard reaches into ESP Web Tools' private DOM. It is
// pinned to PR 733 commit cf6936234a6a37a5028bd2e39eca899bed8a0cd9. This
// invariant test locks the vendor source contract (manifestPath forwarding,
// ASK_ERASE state, label.formfield/ew-checkbox in that render, and the
// _startInstall(checkbox.checked) call) so CI fails before deploy if the
// pin or its DOM layout drifts.
test("pinned esp-web-tools source keeps the update-dialog guard's contract", () => {
  const vendorRoot = new URL("../vendor/esp-web-tools/", import.meta.url);
  const installDialog = readFileSync(new URL("src/install-dialog.ts", vendorRoot), "utf8");
  const connectTs = readFileSync(new URL("src/connect.ts", vendorRoot), "utf8");
  const installButton = readFileSync(new URL("src/install-button.ts", vendorRoot), "utf8");
  const postFlash = readFileSync(new URL("src/post-flash.ts", vendorRoot), "utf8");

  assert.match(connectTs,
    /el\.manifestPath\s*=\s*button\.manifest\s*\|\|\s*button\.getAttribute\("manifest"\)!/,
    "connect.ts must forward manifestPath from the button to the dialog");
  assert.match(installDialog, /"ASK_ERASE"/,
    "install-dialog.ts must still declare the ASK_ERASE state");
  assert.match(installDialog, /_renderAskErase\s*\(\)/,
    "install-dialog.ts must still render the ASK_ERASE step");
  assert.match(installDialog, /<label class="formfield">/,
    "the ASK_ERASE render must still emit a label.formfield row");
  assert.match(installDialog, /<ew-checkbox\b/,
    "the ASK_ERASE render must still contain an ew-checkbox");
  assert.match(installDialog,
    /this\._startInstall\(\s*checkbox\.checked\s*\)/,
    "the ASK_ERASE Next handler must still call _startInstall(checkbox.checked)");
  assert.match(installButton,
    /public\s+onPostFlash\?/,
    "install-button.ts must still declare the PR 733 onPostFlash field");
  assert.match(postFlash, /export const runPostFlash\b/,
    "post-flash.ts must still export runPostFlash");
});
