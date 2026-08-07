import { createSerialMonitor } from "../js/serial-monitor.js";

function report(container, label, ok) {
  const element = document.createElement("section");
  element.className = ok ? "ok" : "fail";
  element.innerHTML = `<strong>${ok ? "PASS" : "FAIL"}</strong> — ${label}`;
  container.appendChild(element);
  return ok;
}

function monitorElements() {
  const root = document.createElement("div");
  root.innerHTML = `
    <button id="connect"></button><button id="reset"></button>
    <button id="copy"></button><button id="clear"></button>
    <button id="disconnect"></button>
    <div id="status"></div><pre id="log"></pre>`;
  return {
    connect: root.querySelector("#connect"),
    reset: root.querySelector("#reset"),
    copy: root.querySelector("#copy"),
    clear: root.querySelector("#clear"),
    disconnect: root.querySelector("#disconnect"),
    status: root.querySelector("#status"),
    log: root.querySelector("#log"),
  };
}

function serialPort() {
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
    closeCount: 0,
    signals: [],
    async open() {},
    async close() { this.closeCount += 1; },
    async setSignals(value) { this.signals.push(value); },
  };
}

class FakeSerial extends EventTarget {
  constructor(ports) {
    super();
    this.ports = [...ports];
  }

  async requestPort() {
    const result = this.ports.shift();
    if (result instanceof Error) throw result;
    return result;
  }
}

const nextTask = () => new Promise((resolve) => setTimeout(resolve, 0));

export async function runSerialMonitorTests(container) {
  let pass = 0;
  let fail = 0;
  const count = (ok) => ok ? pass++ : fail++;

  {
    const port = serialPort();
    const elements = monitorElements();
    let found;
    let foundStatus;
    let copiedText;
    const monitor = createSerialMonitor({
      elements,
      setupFlow: {
        showPairing(mt, manualCode, options) {
          found = { mt, manualCode, options };
          return true;
        },
      },
      serial: new FakeSerial([port]),
      clipboard: { writeText: async (text) => { copiedText = text; } },
      secureContext: true,
      resetPulseMs: 0,
    });
    monitor.addEventListener("aliro-status", (event) => { foundStatus = event.detail; });
    const connected = await monitor.connect();
    port.streamController.enqueue(new TextEncoder().encode(
      "I (1110) chip[SVR]: SetupQRCode: [MT:Y.K9042C00KA0648G00]\n" +
      "I (1110) chip[SVR]: Manual pairing code: [34970112332]\n",
    ));
    port.streamController.enqueue(new TextEncoder().encode(
      "ALIRO/1 STATUS firmware=0.0.4-devkit protocol=1 " +
      "auto_relock_seconds=10 success_rgb=00ff00 success_ms=750 " +
      "failure_rgb=ff0000 failure_ms=900 other_rgb=0000ff other_ms=500\n",
    ));
    await nextTask();
    await monitor.writeLine("ALIRO/1 SET auto_relock_seconds=0");
    elements.copy.click();
    await nextTask();
    const released = await monitor.releaseForInstall();
    const ok = connected && released && found?.manualCode === "34970112332" &&
      found?.options.statusMessage === "Live serial setup codes are ready." &&
      copiedText === elements.log.textContent && /SetupQRCode/.test(copiedText) &&
      foundStatus?.firmware === "0.0.4-devkit" &&
      port.writes[0] === "ALIRO/1 SET auto_relock_seconds=0\n" &&
      !port.readable.locked &&
      port.closeCount === 1;
    count(report(container, "live logs copy, find setup codes, and release before install", ok));
  }

  {
    const first = serialPort();
    const second = serialPort();
    const monitor = createSerialMonitor({
      elements: monitorElements(),
      setupFlow: { showPairing: () => true },
      serial: new FakeSerial([first, second]),
      secureContext: true,
    });
    await monitor.connect();
    await monitor.disconnect();
    const reconnected = await monitor.connect();
    await monitor.destroy();
    const ok = reconnected && first.closeCount === 1 && second.closeCount === 1 &&
      !first.readable.locked && !second.readable.locked;
    count(report(container, "disconnect and reconnect clean up each reader", ok));
  }

  {
    const denied = new Error("Permission denied");
    denied.name = "NotAllowedError";
    const elements = monitorElements();
    const monitor = createSerialMonitor({
      elements,
      setupFlow: { showPairing: () => true },
      serial: new FakeSerial([denied]),
      secureContext: true,
    });
    const connected = await monitor.connect();
    count(report(container, "permission errors leave the monitor ready to retry",
      !connected && /permission/i.test(elements.status.textContent) &&
      !elements.connect.disabled));
    await monitor.destroy();
  }

  return { pass, fail };
}
