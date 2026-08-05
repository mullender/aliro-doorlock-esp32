// boot-parser-tests.js
//
// Runs the parser regexes against every fixture without needing a real
// SerialPort. Wire this in from tests/index.html alongside the
// matter-payload tests.

import { __internals } from "../js/boot-parser.js";
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

export function runBootParserTests(container) {
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
  return { pass, fail };
}
