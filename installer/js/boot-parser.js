import { validatePair } from "./matter-payload.js";

const RE_MT = /(?:CHIP\s*(?:\[\s*SVR\s*\]|:\s*SVR)|CH\s*:\s*SVR|CH\s*:)[^\n\r]*SetupQRCode\s*:\s*\[?(MT:[0-9A-Z\-.]{16,128})\]?/i;
const RE_MANUAL = /(?:CHIP\s*(?:\[\s*SVR\s*\]|:\s*SVR)|CH\s*:\s*SVR|CH\s*:)[^\n\r]*Manual pairing code\s*:\s*\[?(\d{11})\]?/i;
const RE_FABRIC = /Fabric index\s+(0x[0-9A-F]+)[^\n\r]*\bFabricId\s+(0x[0-9A-F]+)[^\n\r]*\bNodeId\s+(0x[0-9A-F]+)[^\n\r]*\bVendorId\s+(0x[0-9A-F]+)/i;
const COMMISSIONED_MARKER = "Fabric already commissioned";
const RE_ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_REEMIT_TIMEOUT_MS = 5000;

function normalizedHex(value) {
  return value.toLowerCase().replace(/^0x0*/, "0x");
}

function fabricKey(fabric) {
  return [fabric.fabricIndex, fabric.fabricId, fabric.nodeId, fabric.vendorId]
    .map(normalizedHex)
    .join(":");
}

export function parseOnboardingText(text, previous = {}) {
  const state = {
    mt: previous.mt || null,
    manualCode: previous.manualCode || null,
  };
  const fabrics = previous.fabrics
    ? [...previous.fabrics]
    : (previous.fabric ? [previous.fabric] : []);
  if (fabrics.length) {
    state.fabrics = fabrics;
    state.fabric = previous.fabric || fabrics[fabrics.length - 1];
  }
  if (previous.commissioned) state.commissioned = true;
  const cleaned = String(text).replace(RE_ANSI, "");
  for (const line of cleaned.split(/\r?\n/)) {
    if (!state.mt) state.mt = line.match(RE_MT)?.[1] || null;
    if (!state.manualCode) state.manualCode = line.match(RE_MANUAL)?.[1] || null;
    const fabricMatch = line.match(RE_FABRIC);
    if (fabricMatch) {
      const fabric = {
        fabricIndex: fabricMatch[1],
        fabricId: fabricMatch[2],
        nodeId: fabricMatch[3],
        vendorId: fabricMatch[4],
      };
      const existingFabric = fabrics.find((item) => fabricKey(item) === fabricKey(fabric));
      if (!existingFabric) {
        fabrics.push(fabric);
      }
      state.fabrics = fabrics;
      state.fabric = existingFabric || fabric;
    }
    if (line.includes(COMMISSIONED_MARKER)) state.commissioned = true;
  }
  return state;
}

function outcomeFromState(state, source) {
  if (state.commissioned) {
    return {
      ok: true,
      kind: "commissioned",
      fabric: state.fabric || null,
      fabrics: state.fabrics || [],
      source,
    };
  }
  if (!state.mt || !state.manualCode) return null;
  const validation = validatePair(state.mt, state.manualCode);
  if (!validation.valid) {
    return {
      ok: false,
      kind: "parse-failure",
      error: "The device printed setup codes that did not match.",
    };
  }
  return {
    ok: true,
    kind: "success",
    mt: state.mt,
    manualCode: state.manualCode,
    source,
  };
}

function waitForRead(readPromise, timeoutMs, signal) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const timer = setTimeout(() => finish({ type: "timeout" }), Math.max(0, timeoutMs));
    const onAbort = () => finish({ type: "cancel" });
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) return onAbort();
    readPromise.then(
      (value) => finish({ type: "read", value }),
      () => finish({ type: "read-error" }),
    );
  });
}

async function deassertDeviceReset(port) {
  let firstError;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await port.setSignals({ dataTerminalReady: false, requestToSend: false });
      return;
    } catch (error) {
      firstError ||= error;
    }
  }
  throw firstError;
}

async function requestDeviceReset(port, pulseMs = 100) {
  if (typeof port.setSignals !== "function") return false;
  try {
    await port.setSignals({ dataTerminalReady: false, requestToSend: true });
    await new Promise((resolve) => setTimeout(resolve, pulseMs));
  } finally {
    await deassertDeviceReset(port);
  }
  return true;
}

export const resetSerialDevice = requestDeviceReset;

async function requestCodeReemit(port) {
  if (!port.writable) return false;
  const writer = port.writable.getWriter();
  try {
    await writer.write(new TextEncoder().encode("matter onboardingcodes\r\n"));
    return true;
  } finally {
    writer.releaseLock();
  }
}

export async function parseMatterOnboardingCodes(port, opts = {}) {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    reemitTimeoutMs = DEFAULT_REEMIT_TIMEOUT_MS,
    signal,
    logger = () => {},
    requestReset = true,
    requestReemit = false,
    resetAfterMs = timeoutMs / 2,
    resetPulseMs = 100,
  } = opts;

  if (!port?.readable) throw new Error("The serial port has no readable stream.");

  const reader = port.readable.getReader();
  const decoder = new TextDecoder();
  let state = { mt: null, manualCode: null };
  let lineBuffer = "";
  let pendingRead = null;
  let phase = "boot";
  let deadline = Date.now() + timeoutMs;
  let resetTimer = null;
  let resetWork = Promise.resolve();
  let shouldCancelReader = false;

  if (requestReset && typeof port.setSignals === "function") {
    resetTimer = setTimeout(() => {
      logger("No setup codes yet. Resetting the device once.", "info");
      resetWork = requestDeviceReset(port, resetPulseMs).catch(() => {
        logger("The automatic device reset failed.", "error");
      });
    }, resetAfterMs);
  }

  const finishBuffer = () => {
    lineBuffer += decoder.decode();
    state = parseOnboardingText(lineBuffer, state);
    return outcomeFromState(state, phase);
  };

  try {
    while (true) {
      pendingRead ||= reader.read();
      const event = await waitForRead(pendingRead, deadline - Date.now(), signal);

      if (event.type === "cancel") {
        shouldCancelReader = true;
        return { ok: false, kind: "cancel", error: "Pairing code read canceled." };
      }
      if (event.type === "read-error") {
        return { ok: false, kind: "serial-failure", error: "The serial read failed." };
      }
      if (event.type === "read") {
        pendingRead = null;
        if (event.value.done) {
          return finishBuffer() || {
            ok: false,
            kind: "timeout",
            error: "The serial log ended before both setup codes appeared.",
          };
        }
        lineBuffer += decoder.decode(event.value.value, { stream: true }).replace(RE_ANSI, "");
        const completeLines = lineBuffer.split(/\r?\n/);
        lineBuffer = completeLines.pop() || "";
        if (completeLines.length) {
          state = parseOnboardingText(completeLines.join("\n"), state);
        }
        const outcome = outcomeFromState(state, phase);
        if (outcome) return outcome;
        continue;
      }

      if (phase === "boot" && requestReemit) {
        let sent = false;
        try {
          sent = await requestCodeReemit(port);
        } catch {
          logger("The device did not accept the setup-code command.", "error");
        }
        if (sent) {
          logger("Requested the setup codes from the device.", "info");
          phase = "reemit";
          deadline = Date.now() + reemitTimeoutMs;
          continue;
        }
      }

      shouldCancelReader = true;
      return {
        ok: false,
        kind: "timeout",
        error: "The device did not print both Matter setup codes in time.",
      };
    }
  } finally {
    if (resetTimer !== null) clearTimeout(resetTimer);
    await resetWork;
    if (shouldCancelReader && pendingRead) {
      try { await reader.cancel(); } catch { /* The stream is already closed. */ }
      try { await pendingRead; } catch { /* The failed read is already reported. */ }
    }
    try { reader.releaseLock(); } catch { /* The lock is already free. */ }
  }
}

export const __internals = {
  RE_MT,
  RE_MANUAL,
  RE_FABRIC,
  COMMISSIONED_MARKER,
  RE_ANSI,
  requestDeviceReset,
  requestCodeReemit,
};
