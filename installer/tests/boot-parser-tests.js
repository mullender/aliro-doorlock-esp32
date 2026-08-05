import { parseMatterOnboardingCodes, parseOnboardingText } from "../js/boot-parser.js";
import { validatePair } from "../js/matter-payload.js";
import { LOG_FIXTURES } from "./boot-log-fixtures.js";

function report(container, label, ok, details = "") {
  const el = document.createElement("section");
  el.className = ok ? "ok" : "fail";
  el.innerHTML = `<strong>${ok ? "PASS" : "FAIL"}</strong> — ${label}` +
    (details ? `<pre>${details}</pre>` : "");
  container.appendChild(el);
  return ok;
}

function streamFromText(text) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

export async function runBootParserTests(container) {
  let pass = 0;
  let fail = 0;
  const count = (ok) => ok ? pass++ : fail++;

  for (const fixture of LOG_FIXTURES) {
    const parsed = parseOnboardingText(fixture.log);
    let ok;
    if (fixture.expectFail) {
      ok = !(parsed.mt && parsed.manualCode);
    } else if (fixture.expectParseFailure) {
      ok = Boolean(parsed.mt && parsed.manualCode && !validatePair(parsed.mt, parsed.manualCode).valid);
    } else {
      ok = parsed.mt === fixture.expect.mt && parsed.manualCode === fixture.expect.manualCode;
    }
    count(report(
      container,
      fixture.label,
      ok,
      `mt=${parsed.mt || "(none)"}, manual=${parsed.manualCode || "(none)"}`,
    ));
  }

  const validLog = [
    "I (1110) chip[SVR]: SetupQRCode: [MT:Y.K9042C00KA0648G00]",
    "I (1110) chip[SVR]: Manual pairing code: [34970112332]",
  ].join("\n");

  {
    const stream = streamFromText(validLog);
    const result = await parseMatterOnboardingCodes(
      { readable: stream },
      { timeoutMs: 200, requestReset: false },
    );
    const ok = result.ok && result.kind === "success" && result.source === "boot" && !stream.locked;
    count(report(container, "serial stream returns a validated setup pair", ok));
  }

  {
    let streamController;
    const stream = new ReadableStream({ start(controller) { streamController = controller; } });
    const signalChanges = [];
    const port = {
      readable: stream,
      async setSignals(value) {
        signalChanges.push(value);
        if (value.requestToSend === false) {
          streamController.enqueue(new TextEncoder().encode(validLog));
          streamController.close();
        }
      },
    };
    const result = await parseMatterOnboardingCodes(port, {
      timeoutMs: 100,
      resetAfterMs: 0,
      resetPulseMs: 0,
    });
    const ok = result.ok && signalChanges.length === 2 && !stream.locked;
    count(report(container, "one reset recovers a missed boot log", ok));
  }

  {
    let streamController;
    let command = "";
    const stream = new ReadableStream({ start(controller) { streamController = controller; } });
    const writable = new WritableStream({
      write(chunk) {
        command += new TextDecoder().decode(chunk);
        streamController.enqueue(new TextEncoder().encode(validLog));
        streamController.close();
      },
    });
    const result = await parseMatterOnboardingCodes(
      { readable: stream, writable },
      { timeoutMs: 20, reemitTimeoutMs: 200, requestReset: false, requestReemit: true },
    );
    const ok = result.ok && result.source === "reemit" &&
      command === "matter onboardingcodes\r\n" && !stream.locked && !writable.locked;
    count(report(container, "serial command can recover codes when firmware supports it", ok));
  }

  {
    const stream = streamFromText([
      "I (1110) chip[SVR]: SetupQRCode: [MT:Y.K9042C00KA0648G00]",
      "I (1110) chip[SVR]: Manual pairing code: [00054912336]",
    ].join("\n"));
    const result = await parseMatterOnboardingCodes(
      { readable: stream },
      { timeoutMs: 200, requestReset: false },
    );
    const ok = !result.ok && result.kind === "parse-failure" && !("log" in result) && !stream.locked;
    count(report(container, "mismatched codes return parse-failure without raw logs", ok));
  }

  {
    const stream = new ReadableStream({ start() {} });
    const result = await parseMatterOnboardingCodes(
      { readable: stream },
      { timeoutMs: 20, requestReset: false },
    );
    const ok = !result.ok && result.kind === "timeout" && !("mt" in result) && !stream.locked;
    count(report(container, "timeout releases the reader and returns no setup data", ok));
  }

  {
    const stream = new ReadableStream({ start() {} });
    const controller = new AbortController();
    const pending = parseMatterOnboardingCodes(
      { readable: stream },
      { timeoutMs: 500, requestReset: false, signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 10);
    const result = await pending;
    const ok = !result.ok && result.kind === "cancel" && !stream.locked;
    count(report(container, "cancel releases the reader and returns a public cancel result", ok));
  }

  return { pass, fail };
}
