import { parseOnboardingText, resetSerialDevice } from "./boot-parser.js";

const DEFAULT_BAUD_RATE = 115200;
const DEFAULT_BUFFER_SIZE = 8192;
const DEFAULT_MAX_LOG_CHARS = 200000;
const RE_ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

function errorName(error) {
  return error && typeof error === "object" ? error.name : "";
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export function createSerialMonitor({
  elements,
  setupFlow,
  serial = globalThis.navigator?.serial,
  clipboard = globalThis.navigator?.clipboard,
  secureContext = globalThis.isSecureContext === true,
  baudRate = DEFAULT_BAUD_RATE,
  bufferSize = DEFAULT_BUFFER_SIZE,
  maxLogChars = DEFAULT_MAX_LOG_CHARS,
  resetPulseMs = 100,
  logger = console,
}) {
  let port = null;
  let reader = null;
  let readTask = null;
  let connectTask = null;
  let authorizedConnectTask = null;
  let disconnectTask = null;
  let resetTask = null;
  let session = 0;
  let destroyed = false;
  let parseBuffer = "";
  let codeState = { mt: null, manualCode: null };
  let lastPair = null;
  let lastCommissioned = null;

  function setStatus(message) {
    elements.status.textContent = message;
  }

  function setControls(state) {
    const supported = Boolean(serial && secureContext && !destroyed);
    elements.connect.disabled = !supported || state !== "idle";
    elements.reset.disabled = state !== "connected";
    elements.disconnect.disabled = !["connected", "blocked"].includes(state);
    elements.copy.disabled = destroyed;
    elements.clear.disabled = destroyed;
  }

  function appendLog(text) {
    if (!text) return;
    const clean = text.replace(RE_ANSI, "");
    const next = `${elements.log.textContent}${clean}`;
    elements.log.textContent = next.length > maxLogChars
      ? `[Earlier output was removed.]\n${next.slice(-maxLogChars)}`
      : next;
    if (typeof elements.log.scrollTo === "function") {
      elements.log.scrollTo({ top: elements.log.scrollHeight });
    } else {
      elements.log.scrollTop = elements.log.scrollHeight;
    }
  }

  function handleCodeState() {
    if (codeState.commissioned) {
      const fabrics = codeState.fabrics?.length
        ? codeState.fabrics
        : (codeState.fabric ? [codeState.fabric] : []);
      const stateKey = JSON.stringify(fabrics);
      if (stateKey !== lastCommissioned) {
        setupFlow.showCommissioned(fabrics, {
          statusMessage: "Live serial log shows that this device is already commissioned.",
        });
        lastCommissioned = stateKey;
        setStatus("Connected. Device is already commissioned.");
      }
      return;
    }
    if (!codeState.mt || !codeState.manualCode) return;
    const pairKey = `${codeState.mt}\n${codeState.manualCode}`;
    if (pairKey !== lastPair) {
      const shown = setupFlow.showPairing(codeState.mt, codeState.manualCode, {
        statusMessage: "Live serial setup codes are ready.",
      });
      if (shown) {
        lastPair = pairKey;
        setStatus("Connected. Matter setup codes found.");
      } else {
        setStatus("Connected, but the live setup codes are invalid or do not match.");
      }
    }
    codeState = {
      mt: null,
      manualCode: null,
      ...(codeState.fabric ? { fabric: codeState.fabric } : {}),
      ...(codeState.fabrics ? { fabrics: codeState.fabrics } : {}),
    };
  }

  function parseCompleteLines(text, flush = false) {
    parseBuffer += text.replace(RE_ANSI, "");
    const lines = parseBuffer.split(/\r\n|\r|\n/);
    const tail = lines.pop() || "";
    parseBuffer = flush ? "" : tail;
    if (parseBuffer.length > 8192) parseBuffer = parseBuffer.slice(-8192);
    for (const line of lines) {
      codeState = parseOnboardingText(line, codeState);
      handleCodeState();
    }
    if (flush && tail) {
      codeState = parseOnboardingText(tail, codeState);
      handleCodeState();
    }
  }

  async function closePort(target) {
    try {
      await target.close();
      return true;
    } catch (error) {
      logger.error("[serial-monitor] The serial port did not close.", error);
      setStatus(`The serial port did not close: ${errorMessage(error)}`);
      return false;
    }
  }

  async function readLoop(targetPort, targetReader, targetSession) {
    const decoder = new TextDecoder();
    let ended = false;
    try {
      while (targetSession === session) {
        const result = await targetReader.read();
        if (result.done) {
          ended = true;
          break;
        }
        const text = decoder.decode(result.value, { stream: true });
        appendLog(text);
        parseCompleteLines(text);
      }
      const finalText = decoder.decode();
      appendLog(finalText);
      parseCompleteLines(finalText, true);
    } catch (error) {
      if (targetSession === session) {
        logger.error("[serial-monitor] The serial read failed.", error);
        setStatus(`The serial read failed: ${errorMessage(error)}`);
      }
    } finally {
      try { targetReader.releaseLock(); } catch { /* The reader is already free. */ }
      if (reader === targetReader) reader = null;
      if (targetSession === session && port === targetPort) {
        const closed = await closePort(targetPort);
        if (closed) port = null;
        readTask = null;
        setControls(closed ? "idle" : "blocked");
        if (ended && closed) {
          setStatus("The device ended the serial connection. You can reconnect.");
        }
      }
    }
  }

  function requestPortMessage(error) {
    if (errorName(error) === "NotFoundError") return "No serial port was selected.";
    if (["NotAllowedError", "SecurityError"].includes(errorName(error))) {
      return "Serial access was not allowed. Check the site permission and try again.";
    }
    return `The serial port could not be selected: ${errorMessage(error)}`;
  }

  async function connectNow(authorizedPort = null) {
    if (destroyed || !serial || !secureContext) return false;
    if (port) return true;
    if (disconnectTask) await disconnectTask;

    setControls("connecting");
    setStatus(authorizedPort
      ? "Connecting to the authorized serial device."
      : "Choose the USB serial port for the device.");

    let selectedPort = authorizedPort;
    if (!selectedPort) {
      try {
        selectedPort = await serial.requestPort();
      } catch (error) {
        setStatus(requestPortMessage(error));
        setControls("idle");
        return false;
      }
    }
    if (destroyed) return false;

    try {
      await selectedPort.open({ baudRate, bufferSize });
    } catch (error) {
      const inUse = errorName(error) === "InvalidStateError";
      setStatus(inUse
        ? "The serial port is already in use. Close its other monitor and try again."
        : `The serial port could not open: ${errorMessage(error)}`);
      setControls("idle");
      return false;
    }

    if (!selectedPort.readable) {
      setStatus("The serial port has no readable stream.");
      await closePort(selectedPort);
      setControls("idle");
      return false;
    }
    if (selectedPort.readable.locked) {
      port = selectedPort;
      setStatus("The serial port already has an active reader. Close it, then select Disconnect.");
      setControls("blocked");
      return false;
    }

    let selectedReader;
    try {
      selectedReader = selectedPort.readable.getReader();
    } catch (error) {
      setStatus(`The serial reader could not start: ${errorMessage(error)}`);
      if (selectedPort.readable.locked) {
        port = selectedPort;
        setControls("blocked");
      } else {
        await closePort(selectedPort);
        setControls("idle");
      }
      return false;
    }

    session += 1;
    parseBuffer = "";
    codeState = { mt: null, manualCode: null };
    lastPair = null;
    lastCommissioned = null;
    port = selectedPort;
    reader = selectedReader;
    setControls("connected");
    setStatus("Connected. Live logs stay in this browser page.");
    const targetSession = session;
    readTask = readLoop(selectedPort, selectedReader, targetSession);
    await reset();
    return true;
  }

  function connect(selectedPort = null) {
    if (connectTask) return connectTask;
    connectTask = connectNow(selectedPort).finally(() => { connectTask = null; });
    return connectTask;
  }

  async function connectPreviouslyAuthorizedPort() {
    if (destroyed || !serial?.getPorts || !secureContext) return false;
    let authorizedPorts;
    try {
      authorizedPorts = await serial.getPorts();
    } catch (error) {
      logger.error("[serial-monitor] Authorized serial ports could not be listed.", error);
      return false;
    }
    if (destroyed || connectTask || authorizedPorts.length !== 1) return false;
    return connect(authorizedPorts[0]);
  }

  async function disconnectNow(message, allowCloseFailure = false) {
    if (connectTask) await connectTask;
    if (resetTask) await resetTask;
    if (!port && !reader && !readTask) {
      setControls("idle");
      if (message) setStatus(message);
      return true;
    }

    setControls("disconnecting");
    setStatus("Disconnecting the serial monitor...");
    session += 1;
    const targetPort = port;
    const targetReader = reader;
    const targetTask = readTask;

    if (targetReader) {
      try { await targetReader.cancel(); } catch (error) {
        logger.error("[serial-monitor] The serial reader did not cancel.", error);
      }
    }
    if (targetTask) await targetTask;

    const closeResult = targetPort ? await closePort(targetPort) : true;
    const closed = closeResult || allowCloseFailure;
    if (closed) {
      if (port === targetPort) port = null;
      if (reader === targetReader) reader = null;
      if (readTask === targetTask) readTask = null;
      setControls("idle");
      setStatus(message || "Serial monitor disconnected. You can reconnect.");
    } else {
      setControls("blocked");
    }
    return closed;
  }

  function disconnect(message, allowCloseFailure = false) {
    if (disconnectTask) return disconnectTask;
    disconnectTask = disconnectNow(message, allowCloseFailure)
      .finally(() => { disconnectTask = null; });
    return disconnectTask;
  }

  async function resetNow() {
    if (!port || !reader) return false;
    elements.reset.disabled = true;
    setStatus("Resetting the device...");
    try {
      const supported = await resetSerialDevice(port, resetPulseMs);
      setStatus(supported
        ? "Connected. The lock restarted. Reading its boot status."
        : "Connected, but this serial port cannot restart the lock.");
      return supported;
    } catch (error) {
      logger.error("[serial-monitor] The device reset failed.", error);
      setStatus(`Connected, but the lock did not restart: ${errorMessage(error)}`);
      return false;
    } finally {
      elements.reset.disabled = !port || !reader;
    }
  }

  function reset() {
    if (resetTask) return resetTask;
    resetTask = resetNow().finally(() => { resetTask = null; });
    return resetTask;
  }

  function clear() {
    elements.log.textContent = "";
    parseBuffer = "";
    codeState = { mt: null, manualCode: null };
    lastPair = null;
    lastCommissioned = null;
    setStatus(port ? "Live log cleared. The serial monitor is connected." : "Live log cleared.");
  }

  async function copy() {
    const text = elements.log.textContent;
    if (!text) {
      setStatus("There are no live logs to copy.");
      return false;
    }
    if (!clipboard?.writeText) {
      setStatus("Clipboard access is not available. Select the log and copy it manually.");
      return false;
    }
    try {
      await clipboard.writeText(text);
      setStatus("Live logs copied to the clipboard.");
      return true;
    } catch {
      setStatus("The live logs could not be copied. Select the log and copy it manually.");
      return false;
    }
  }

  function isActive() {
    return Boolean(
      port || reader || readTask || connectTask || authorizedConnectTask || disconnectTask || resetTask
    );
  }

  async function releaseForInstall() {
    if (!isActive()) return true;
    if (authorizedConnectTask) await authorizedConnectTask;
    return disconnect(
      "Serial monitor disconnected for install. Click the install button again to continue.",
    );
  }

  const onConnect = () => { void connect(); };
  const onReset = () => { void reset(); };
  const onCopy = () => { void copy(); };
  const onClear = () => clear();
  const onDisconnect = () => { void disconnect(); };
  const onPortDisconnect = (event) => {
    const disconnectedPort = event.port || event.target;
    if (disconnectedPort === port) {
      void disconnect("Device disconnected. You can reconnect.", true);
    }
  };

  elements.connect.addEventListener("click", onConnect);
  elements.reset.addEventListener("click", onReset);
  elements.copy.addEventListener("click", onCopy);
  elements.clear.addEventListener("click", onClear);
  elements.disconnect.addEventListener("click", onDisconnect);
  serial?.addEventListener?.("disconnect", onPortDisconnect);

  if (!serial) {
    setControls("unsupported");
    setStatus("Web Serial is not available. Use Chrome or Edge on desktop.");
  } else if (!secureContext) {
    setControls("unsupported");
    setStatus("Web Serial requires HTTPS or localhost.");
  } else {
    setControls("idle");
    setStatus("Connect a device to read its status.");
    authorizedConnectTask = connectPreviouslyAuthorizedPort()
      .finally(() => { authorizedConnectTask = null; });
  }

  async function destroy() {
    destroyed = true;
    elements.connect.removeEventListener("click", onConnect);
    elements.reset.removeEventListener("click", onReset);
    elements.copy.removeEventListener("click", onCopy);
    elements.clear.removeEventListener("click", onClear);
    elements.disconnect.removeEventListener("click", onDisconnect);
    serial?.removeEventListener?.("disconnect", onPortDisconnect);
    if (authorizedConnectTask) await authorizedConnectTask;
    if (disconnectTask) await disconnectTask;
    else await disconnectNow("");
    setControls("destroyed");
  }

  return {
    connect,
    reset,
    clear,
    disconnect,
    destroy,
    isActive,
    releaseForInstall,
    getState: () => ({
      connected: Boolean(port && reader),
      connecting: Boolean(connectTask),
      disconnecting: Boolean(disconnectTask),
      resetting: Boolean(resetTask),
    }),
  };
}
