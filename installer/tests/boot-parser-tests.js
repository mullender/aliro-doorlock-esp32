// boot-parser-tests.js
//
// Runs the parser regexes against every fixture without needing a real
// SerialPort. Wire this in from tests/index.html alongside the
// matter-payload tests.

import { parseMatterOnboardingCodes, __internals } from "../js/boot-parser.js";
import { LOG_FIXTURES } from "./boot-log-fixtures.js";

const { RE_MT, RE_MANUAL, RE_MT_URL, RE_ANSI } = __internals;

/**
 * Line-oriented mirror of parseMatterOnboardingCodes minus the port I/O.
 * Kept in sync with boot-parser.js: any regex/logic change there needs
 * a corresponding change here.
 */
function parseLog(log) {
  const cleaned = log.replace(RE_ANSI, "");
  const lines = cleaned.split(/\r?\n/);
  let mt = null;
  let manualCode = null;
  let mtFromUrl = null;
  for (const line of lines) {
    if (!mt) {
      const m = line.match(RE_MT);
      if (m) mt = m[1];
    }
    if (!mt && !mtFromUrl) {
      const u = line.match(RE_MT_URL);
      if (u) {
        const decoded = decodeURIComponent(u[1]);
        if (decoded.startsWith("MT:")) mtFromUrl = decoded;
      }
    }
    if (!manualCode) {
      const c = line.match(RE_MANUAL);
      if (c) manualCode = c[1];
    }
  }
  if (!mt && mtFromUrl) mt = mtFromUrl;
  return { mt, manualCode };
}

export async function runBootParserTests(container) {
  let pass = 0, fail = 0;
  for (const f of LOG_FIXTURES) {
    const result = parseLog(f.log);
    const el = document.createElement("section");
    if (f.expectFail) {
      const ok = !(result.mt && result.manualCode);
      el.className = ok ? "ok" : "fail";
      el.innerHTML =
        `<strong>${ok ? "PASS" : "FAIL"}</strong> — ${f.label}` +
        `<pre>expected fail; got mt=${result.mt || "(none)"}, manual=${result.manualCode || "(none)"}</pre>`;
      if (ok) pass++; else fail++;
    } else {
      const ok = result.mt === f.expect.mt && result.manualCode === f.expect.manualCode;
      el.className = ok ? "ok" : "fail";
      el.innerHTML =
        `<strong>${ok ? "PASS" : "FAIL"}</strong> — ${f.label}` +
        `<pre>` +
        `expected: mt=${f.expect.mt}, manual=${f.expect.manualCode}\n` +
        `got:      mt=${result.mt || "(none)"}, manual=${result.manualCode || "(none)"}` +
        `</pre>`;
      if (ok) pass++; else fail++;
    }
    container.appendChild(el);
  }

  const validLog = [
    "CHIP:SVR: SetupQRCode: [MT:Y.K9042C00KA0648G00]",
    "CHIP:SVR: Manual pairing code: [34970112332]",
    "",
  ].join("\n");
  const encoder = new TextEncoder();

  {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(validLog));
        controller.close();
      },
    });
    let signalChanges = 0;
    const port = {
      readable: stream,
      async setSignals() { signalChanges += 1; },
    };
    const result = await parseMatterOnboardingCodes(port, { timeoutMs: 500 });
    const ok = result.ok && signalChanges === 0 && !stream.locked;
    const el = document.createElement("section");
    el.className = ok ? "ok" : "fail";
    el.innerHTML = `<strong>${ok ? "PASS" : "FAIL"}</strong> — ` +
      "complete boot log does not reset the device";
    container.appendChild(el);
    if (ok) pass++; else fail++;
  }

  {
    let controller;
    const stream = new ReadableStream({
      start(value) { controller = value; },
    });
    const signalChanges = [];
    const port = {
      readable: stream,
      async setSignals(value) {
        signalChanges.push(value.requestToSend);
        if (value.requestToSend === false) {
          controller.enqueue(encoder.encode(validLog));
          controller.close();
        }
      },
    };
    const result = await parseMatterOnboardingCodes(port, { timeoutMs: 300 });
    const ok = result.ok && signalChanges.join(",") === "true,false" &&
      !stream.locked;
    const el = document.createElement("section");
    el.className = ok ? "ok" : "fail";
    el.innerHTML = `<strong>${ok ? "PASS" : "FAIL"}</strong> — ` +
      "midpoint reset captures a new boot log";
    container.appendChild(el);
    if (ok) pass++; else fail++;
  }

  return { pass, fail };
}
