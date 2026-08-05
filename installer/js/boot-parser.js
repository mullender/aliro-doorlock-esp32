// boot-parser.js
//
// Reads a firmware boot log from an open SerialPort and pulls out the two
// Matter setup lines the flasher's pairing UI needs. Used by the
// onPostFlash callback (Phase 4a fork) that the ESP Web Tools dialog
// invokes after a successful flash.
//
// Contract:
//
//   parseMatterOnboardingCodes(port, {
//     timeoutMs?: number,                    default 12_000
//     signal?: AbortSignal,                  optional external cancel
//     logger?: (msg, level) => void,         default console.log
//     requestReset?: boolean,                default true — reset the
//                                             device once at mid-timeout
//   })
//     -> Promise<{ mt: string, manualCode: string, log: string }>
//
// The caller (the onPostFlash callback) is responsible for having opened
// the port. This function acquires a reader on port.readable, consumes
// bytes until BOTH lines match or the timeout fires, releases the
// reader, and returns.
//
// It NEVER writes to flash. At most, it holds BOOT inactive and toggles
// RTS once to reset the device and request a fresh boot log.
//
// Regexes are tolerant of:
//   - "CHIP:SVR" vs "CHIP: SVR" spacing
//   - the older "CH:" log prefix (Matter SDK 1.0)
//   - trailing whitespace / \r\n / ANSI colour escapes
//   - the two lines appearing in either order (later SDKs interleave logs)

// The MT: character set is Matter's Base38: 0-9, A-Z, "-", ".".
// The manual code is exactly 11 digits.
const RE_MT = /(?:CHIP\s*:\s*SVR|CH\s*:\s*SVR|CH\s*:)[^\[\n\r]*SetupQRCode\s*:\s*\[?(MT:[0-9A-Z\-\.]{16,64})\]?/i;
const RE_MANUAL = /(?:CHIP\s*:\s*SVR|CH\s*:\s*SVR|CH\s*:)[^\[\n\r]*Manual pairing code\s*:\s*\[?(\d{11})\]?/i;

// Fallback that ignores the log tag entirely — a hosted-URL line always
// contains the MT: string in URL-encoded form. Only used if the tagged
// line was missed and the URL line was captured. (See connectedhomeip
// OnboardingCodesUtil.cpp — it prints a helper URL after SetupQRCode.)
const RE_MT_URL = /qrcode\.html\?data=(MT(?:%3A|:)[0-9A-Za-z%\-\.]{16,80})/i;

// Strip ANSI colour escapes that some ESP-IDF configurations emit.
const RE_ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

const DEFAULT_TIMEOUT_MS = 12000;

/**
 * Consume the boot log until we have both codes, then return them.
 *
 * Guarantees:
 *   - Releases the reader before returning (success OR failure).
 *   - Never throws for a normal timeout — resolves to an error object.
 *     (Only throws if the port is not readable or the reader cannot be
 *      acquired at all.)
 */
export async function parseMatterOnboardingCodes(port, opts = {}) {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    signal,
    logger = (msg, level) => (level === "error" ? console.error(msg) : console.log(msg)),
    requestReset = true,
  } = opts;

  if (!port || !port.readable) {
    throw new Error("boot-parser: port has no readable stream");
  }

  const reader = port.readable.getReader();
  const decoder = new TextDecoder();
  const started = performance.now();
  let mt = null;
  let manualCode = null;
  let mtFromUrl = null;
  let buffer = "";
  let rawLog = "";
  let resetTimer = null;
  let resetPromise = Promise.resolve();

  if (requestReset) {
    resetTimer = setTimeout(() => {
      logger("boot-parser: no codes yet, resetting device once");
      resetPromise = (async () => {
        try {
          // DTR controls GPIO9/BOOT on the NanoC6. Keep it false while
          // RTS resets the chip, or the ROM starts in download mode.
          await port.setSignals({
            dataTerminalReady: false,
            requestToSend: true,
          });
          await new Promise((resolve) => setTimeout(resolve, 100));
          await port.setSignals({
            dataTerminalReady: false,
            requestToSend: false,
          });
        } catch (err) {
          logger(`boot-parser: reset failed: ${err.message}`, "error");
        }
      })();
    }, timeoutMs / 2);
  }

  const cleanup = async () => {
    if (resetTimer !== null) clearTimeout(resetTimer);
    await resetPromise;
    try { reader.releaseLock(); } catch { /* already released */ }
  };

  const abortPromise = signal
    ? new Promise((_, reject) =>
        signal.addEventListener("abort", () =>
          reject(new Error("boot-parser: caller aborted"))
        )
      )
    : new Promise(() => {}); // never resolves

  try {
    while (true) {
      // Compute remaining time; race the read against a timeout.
      const elapsed = performance.now() - started;
      const remaining = timeoutMs - elapsed;
      if (remaining <= 0) break;

      const readPromise = reader.read();
      const timeoutPromise = new Promise((resolve) =>
        setTimeout(() => resolve({ __timeout: true }), remaining)
      );

      let result;
      try {
        result = await Promise.race([readPromise, timeoutPromise, abortPromise]);
      } catch (err) {
        logger(`boot-parser: read failed: ${err.message}`, "error");
        break;
      }

      if (result && result.__timeout) break;
      if (result && result.done) break;

      const chunk = decoder.decode(result.value, { stream: true });
      const cleaned = chunk.replace(RE_ANSI, "");
      rawLog += cleaned;
      buffer += cleaned;

      // Line-by-line scan of the buffer. Keep the last partial line for
      // the next iteration.
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";

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
        if (mt && manualCode) break;
      }
      if (mt && manualCode) break;

    }
  } finally {
    await cleanup();
  }

  // Prefer the tagged line's MT: value; fall back to the URL-embedded one.
  if (!mt && mtFromUrl) mt = mtFromUrl;

  if (!mt || !manualCode) {
    return {
      ok: false,
      error:
        `boot-parser: timed out after ${timeoutMs}ms without both codes ` +
        `(mt=${mt ? "yes" : "no"}, manual=${manualCode ? "yes" : "no"})`,
      log: rawLog,
    };
  }

  return { ok: true, mt, manualCode, log: rawLog };
}

// Exported regexes so tests can exercise them directly.
export const __internals = { RE_MT, RE_MANUAL, RE_MT_URL, RE_ANSI };
