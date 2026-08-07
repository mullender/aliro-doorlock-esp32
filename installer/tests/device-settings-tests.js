import { createDeviceSettings } from "../js/device-settings.js";
import { parseAliroProtocolLine } from "../js/device-protocol.js";

function report(container, label, ok) {
  const element = document.createElement("section");
  element.className = ok ? "ok" : "fail";
  element.textContent = `${ok ? "PASS" : "FAIL"} — ${label}`;
  container.appendChild(element);
  return ok;
}

function settingsElements() {
  const root = document.createElement("div");
  root.innerHTML = `
    <section id="panel" hidden></section><form id="form"></form>
    <input id="auto" type="checkbox"><input id="delay">
    <input id="success-rgb"><input id="success-ms">
    <input id="failure-rgb"><input id="failure-ms">
    <input id="other-rgb"><input id="other-ms">
    <button id="apply"></button><span id="result"></span>
    <span id="installed"></span><span id="latest"></span>
    <span id="current" hidden></span><span id="reason"></span>
    <div id="update"></div>`;
  const get = (id) => root.querySelector(`#${id}`);
  return {
    panel: get("panel"), form: get("form"), autoLock: get("auto"), delay: get("delay"),
    successRgb: get("success-rgb"), successMs: get("success-ms"),
    failureRgb: get("failure-rgb"), failureMs: get("failure-ms"),
    otherRgb: get("other-rgb"), otherMs: get("other-ms"), apply: get("apply"),
    result: get("result"), installed: get("installed"), latest: get("latest"),
    current: get("current"), updateReason: get("reason"), updateAction: get("update"),
  };
}

class Monitor extends EventTarget {
  constructor() {
    super();
    this.writes = [];
  }

  async writeLine(line) {
    this.writes.push(line);
    return true;
  }
}

const nextTask = () => new Promise((resolve) => setTimeout(resolve, 0));
const statusLine = "ALIRO/1 STATUS firmware=0.0.4-devkit protocol=1 " +
  "auto_relock_seconds=10 success_rgb=00ff00 success_ms=750 " +
  "failure_rgb=ff0000 failure_ms=900 other_rgb=0000ff other_ms=500";

export async function runDeviceSettingsTests(container) {
  let pass = 0;
  let fail = 0;
  const count = (ok) => ok ? pass++ : fail++;

  {
    const parsed = parseAliroProtocolLine(statusLine);
    const invalid = parseAliroProtocolLine(statusLine.replace(" other_ms=500", ""));
    const outOfRange = parseAliroProtocolLine(
      statusLine.replace("auto_relock_seconds=10", "auto_relock_seconds=3601"),
    );
    count(report(container, "strict Aliro status parsing",
      parsed?.type === "status" && parsed.status.success_rgb === "#00ff00" &&
      invalid?.type === "invalid-status" && outOfRange?.type === "invalid-status"));
  }

  {
    const elements = settingsElements();
    const monitor = new Monitor();
    const settings = createDeviceSettings({
      elements,
      serialMonitor: monitor,
      fetchImpl: async () => ({ json: async () => ({ version: "aliro-c6-v0.0.4-devkit" }) }),
    });
    await nextTask();
    monitor.dispatchEvent(new CustomEvent("serial-connected"));
    await nextTask();
    const status = parseAliroProtocolLine(statusLine).status;
    monitor.dispatchEvent(new CustomEvent("aliro-status", { detail: status }));
    elements.autoLock.checked = false;
    elements.form.dispatchEvent(new Event("submit", { cancelable: true }));
    await nextTask();
    monitor.dispatchEvent(new CustomEvent("aliro-status", {
      detail: { ...status, auto_relock_seconds: 0 },
    }));
    const ok = !elements.panel.hidden && !elements.current.hidden &&
      elements.updateAction.hidden && monitor.writes[0] === "ALIRO/1 GET" &&
      monitor.writes[1] === "ALIRO/1 SET auto_relock_seconds=0" &&
      elements.result.textContent === "Settings saved.";
    count(report(container, "settings and current firmware UI", ok));
    settings.destroy();
  }

  return { pass, fail };
}
