import { parseAudioFrame } from "./protocol.js";
import { ListenerAudio } from "./listener-audio.js";
import { LisSocket } from "./ws-client.js";
import { $, on, readTokenFromHash, setText, show } from "./ui.js";

const els = {
  connectionPill: $("#connectionPill"),
  connectionText: $("#connectionText"),
  statusOrb: $("#statusOrb"),
  statusTitle: $("#statusTitle"),
  statusDetail: $("#statusDetail"),
  unlockPanel: $("#unlockPanel"),
  enableAudioBtn: $("#enableAudioBtn"),
  resumePanel: $("#resumePanel"),
  resumeAudioBtn: $("#resumeAudioBtn"),
  testCard: $("#testCard"),
  testHint: $("#testHint"),
  testYesBtn: $("#testYesBtn"),
  testNoBtn: $("#testNoBtn"),
  testAutoNote: $("#testAutoNote"),
  fatalPanel: $("#fatalPanel"),
  fatalMessage: $("#fatalMessage"),
};

const token = readTokenFromHash();
let socket = null;
let audio = null;
let hostOnline = false;
let hostPlaying = false;
let audioAttempted = false;
let needsResync = false;
let fatal = false;
let activeTest = null;
let lastDetected = null;
let testFallbackTimer = null;
let testHideTimer = null;
let lastDiagSent = 0;
let localDiagnostics = null;
let diagTimer = null;

if (!token) {
  showFatal(
    "This listener link is missing its invite token. Ask the host for a fresh link.",
    "Link incomplete",
  );
} else {
  audio = createAudio();
  socket = createSocket();
  socket.connect();
  diagTimer = setInterval(() => sendDiagnostics(), 3000);
}

bindEvents();
applyStatus();

function createAudio() {
  return new ListenerAudio({
    onStatus(status) {
      if (status.context === "suspended" && audioAttempted && !fatal) {
        show(els.resumePanel, document.visibilityState === "visible");
      } else if (status.context === "running") {
        show(els.resumePanel, false);
      }
      applyStatus();
    },
    onDiagnostics(diagnostics) {
      localDiagnostics = diagnostics;
    },
    onTestDetected({ testId, detected }) {
      if (!activeTest || activeTest.id !== testId) return;
      lastDetected = Boolean(detected);
      activeTest.autoReported = true;
      if (activeTest.answered) return;
      sendTestResult(null, lastDetected);
      setText(
        els.testAutoNote,
        detected
          ? "Tone detected on this device. Confirm what you heard below."
          : "No tone detected on this device. Check the output volume and device.",
      );
      els.testAutoNote.classList.toggle("is-ok", Boolean(detected));
      els.testAutoNote.classList.toggle("is-warn", !detected);
    },
    onUnderrun() {
      sendDiagnostics(true);
    },
  });
}

function createSocket() {
  return new LisSocket({
    role: "listener",
    token,
    onStatus(status) {
      updateConnectionPill(status);
      if (status.status === "connected" && needsResync) requestResync();
      applyStatus();
    },
    onMessage(message) {
      if (message instanceof ArrayBuffer) {
        const frame = parseAudioFrame(message);
        if (frame) audio?.enqueue(frame);
        return;
      }
      if (typeof message === "string") return;
      handleMessage(message);
    },
    onFatal() {
      if (fatal) return;
      showFatal("This invite link is invalid, expired, or the room is full.", "Invite problem");
    },
  });
}

function bindEvents() {
  on(els.enableAudioBtn, "click", async () => {
    if (!audio || audioAttempted) return;
    audioAttempted = true;
    els.enableAudioBtn.disabled = true;
    const firstInit = !audio.ctx;
    let ready = false;
    try {
      ready = await audio.init();
    } catch {
      ready = false;
    }
    els.enableAudioBtn.disabled = false;
    show(els.unlockPanel, false);
    if (ready) {
      show(els.resumePanel, false);
      if (firstInit) requestResync();
      maybeStartTest();
    } else {
      show(els.resumePanel, true);
      setText(
        els.statusDetail,
        "Your browser blocked or does not support audio. Tap Resume audio to try again.",
      );
    }
    applyStatus();
  });

  on(els.resumeAudioBtn, "click", async () => {
    if (!audio) return;
    audioAttempted = true;
    els.resumeAudioBtn.disabled = true;
    const firstInit = !audio.ctx;
    let ready = false;
    try {
      ready = await audio.init();
    } catch {
      ready = false;
    }
    els.resumeAudioBtn.disabled = false;
    show(els.resumePanel, !ready);
    if (ready) {
      if (firstInit || needsResync) requestResync();
      maybeStartTest();
    }
    applyStatus();
  });

  on(els.testYesBtn, "click", () => answerTest(true));
  on(els.testNoBtn, "click", () => answerTest(false));

  document.addEventListener("visibilitychange", () => {
    applyStatus();
    if (document.visibilityState === "visible" && audioAttempted && audio?.ctx?.state === "suspended") {
      show(els.resumePanel, true);
    }
    sendDiagnostics(true);
  });

  addEventListener("pagehide", () => {
    clearInterval(diagTimer);
    clearTimeout(testFallbackTimer);
    socket?.close();
    audio?.destroy();
  });
}

function handleMessage(message) {
  switch (message.type) {
    case "welcome": {
      hostOnline = Boolean(message.hostOnline);
      if (typeof message.bufferTarget === "number") {
        audio.bufferTarget = message.bufferTarget;
      }
      if (needsResync && audio?.ready) requestResync();
      applyStatus();
      return;
    }
    case "host-online": {
      hostOnline = true;
      needsResync = false;
      applyStatus();
      return;
    }
    case "host-offline": {
      hostOnline = false;
      hostPlaying = false;
      audio?.stop();
      applyStatus();
      return;
    }
    case "track": {
      hostOnline = true;
      hostPlaying = false;
      audio?.configure({
        streamId: message.streamId,
        sampleRate: message.sampleRate,
        channels: message.channels,
        volume: message.volume,
        bufferTarget: message.bufferTarget,
      });
      applyStatus();
      return;
    }
    case "stream-sync": {
      hostOnline = true;
      if (message.hasAudio) {
        audio?.applyStreamSync(message);
      }
      applyStatus();
      return;
    }
    case "play": {
      hostPlaying = true;
      audio?.resumePlayback();
      applyStatus();
      return;
    }
    case "pause": {
      hostPlaying = false;
      audio?.pause();
      applyStatus();
      return;
    }
    case "flush": {
      hostPlaying = Boolean(message.playing);
      audio?.flush(message.position, hostPlaying);
      applyStatus();
      return;
    }
    case "stop": {
      hostPlaying = false;
      audio?.stop();
      applyStatus();
      return;
    }
    case "volume": {
      audio?.setVolume(Number(message.value) / 1000);
      return;
    }
    case "end-of-track": {
      hostPlaying = false;
      audio?.markEndOfTrack(
        Number.isFinite(message.endPts) ? message.endPts : message.position,
      );
      applyStatus();
      return;
    }
    case "test": {
      startTest(message);
      return;
    }
    case "test-end": {
      endTest();
      return;
    }
    case "error": {
      if (
        message.code === "bad_token" ||
        message.code === "room_full" ||
        message.code === "bad_role"
      ) {
        showFatal(
          message.code === "room_full"
            ? "The listening room is full. Ask the host for a new room."
            : "This invite link is invalid or has expired. Ask the host for a fresh link.",
          message.code === "room_full" ? "Room full" : "Invite problem",
        );
      }
      return;
    }
    default:
      return;
  }
}

function requestResync() {
  needsResync = false;
  if (!audio?.ready) {
    needsResync = true;
    return;
  }
  if (socket?.connected) {
    socket.send({ type: "resync" });
  } else {
    needsResync = true;
  }
}

function updateConnectionPill(status) {
  if (fatal) return;
  const state = status?.status ?? "idle";
  const connected = state === "connected";
  els.connectionPill.dataset.state = connected
    ? "online"
    : state === "connecting" || state === "reconnecting"
      ? "connecting"
      : "offline";
  setText(
    els.connectionText,
    connected
      ? "Connected"
      : state === "connecting"
        ? "Connecting"
        : state === "reconnecting"
          ? "Reconnecting"
          : "Disconnected",
  );
}

function applyStatus() {
  if (fatal) return;
  const socketConnected = Boolean(socket?.connected);
  const state = socket?.status ?? "idle";
  let title = "Disconnected";
  let detail = "Enable audio to join the room.";
  let orb = "offline";

  if (!socketConnected) {
    if (state === "connecting" || state === "reconnecting") {
      title = "Connecting";
      detail = "Joining the listening room…";
    } else if (state === "closed" || state === "fatal") {
      title = "Disconnected";
      detail = "The invite link is no longer connected.";
    } else {
      title = "Disconnected";
      detail = "Reconnecting to the listening room…";
    }
  } else if (!hostOnline) {
    title = "Waiting for the host";
    detail = "You’re connected. Audio will start when the host opens the room.";
  } else if (!audioAttempted) {
    title = "Enable audio";
    detail = hostPlaying
      ? "The room is live. Tap below once to start listening."
      : "You’re connected. Tap below once to allow audio.";
    orb = "buffering";
  } else if (!audio?.ready) {
    title = "Audio unavailable";
    detail = "This browser could not start audio playback.";
  } else if (audio.ctx?.state === "suspended") {
    title = "Audio paused";
    detail = "Tap Resume audio to continue listening.";
    orb = "buffering";
  } else {
    const audioState = audio.state;
    orb = "online";
    if (audioState === "playing") {
      title = "Listening";
      detail = "Live from the host.";
    } else if (audioState === "buffering") {
      title = "Buffering";
      detail = "Catching up to the live audio…";
      orb = "buffering";
    } else if (audioState === "paused") {
      title = "Paused";
      detail = "The host paused playback.";
    } else if (audioState === "ended") {
      title = "Track ended";
      detail = "Waiting for the host to play the next track.";
    } else if (hostPlaying) {
      title = "Buffering";
      detail = "Waiting for the first few seconds of audio…";
      orb = "buffering";
    } else {
      title = "Connected";
      detail = "Waiting for the host to start playing.";
    }
  }

  setText(els.statusTitle, title);
  setText(els.statusDetail, detail);
  els.statusOrb.dataset.state = orb;
}

function startTest(message) {
  clearTimeout(testFallbackTimer);
  clearTimeout(testHideTimer);
  activeTest = {
    id: message.id,
    durationMs: Number(message.durationMs) || 1800,
    receivedAt: performance.now(),
    played: false,
    autoReported: false,
    answered: false,
  };
  lastDetected = null;
  show(els.testCard, true);
  els.testYesBtn.disabled = false;
  els.testNoBtn.disabled = false;
  setText(els.testHint, "Listen for three short beeps.");
  els.testAutoNote.classList.remove("is-ok", "is-warn");
  setText(
    els.testAutoNote,
    audio?.ready && audio.ctx?.state === "running"
      ? "Checking this device…"
      : "Enable or resume audio to hear the test tone.",
  );

  if (!audio || !audioAttempted) {
    show(els.unlockPanel, true);
    show(els.resumePanel, false);
  } else if (audio.ctx?.state === "suspended") {
    show(els.resumePanel, true);
  }

  maybeStartTest();
  testFallbackTimer = setTimeout(() => {
    if (!activeTest || activeTest.id !== message.id || activeTest.autoReported) return;
    activeTest.autoReported = true;
    sendTestResult(null, false);
    if (!activeTest.answered) {
      setText(els.testAutoNote, "No tone was detected on this device.");
      els.testAutoNote.classList.add("is-warn");
    }
  }, activeTest.durationMs + 1200);
}

function maybeStartTest() {
  if (!activeTest || activeTest.played || activeTest.answered) return;
  if (!audio?.ready || audio.ctx?.state !== "running") return;
  if (performance.now() - activeTest.receivedAt > activeTest.durationMs + 5000) return;
  activeTest.played = true;
  audio.playTest(activeTest.id, activeTest.durationMs);
}

function answerTest(heard) {
  if (!activeTest || activeTest.answered) return;
  activeTest.answered = true;
  els.testYesBtn.disabled = true;
  els.testNoBtn.disabled = true;
  sendTestResult(heard, lastDetected);
  setText(els.testAutoNote, "Thanks. The host can see your result.");
  els.testAutoNote.classList.remove("is-warn");
  els.testAutoNote.classList.add("is-ok");
  testHideTimer = setTimeout(() => {
    show(els.testCard, false);
  }, 1600);
}

function sendTestResult(heard, detected) {
  if (!activeTest || !socket?.connected) return;
  socket.send({
    type: "test-result",
    testId: activeTest.id,
    heard: heard === true ? true : heard === false ? false : null,
    detected: Boolean(detected),
  });
}

function endTest() {
  clearTimeout(testFallbackTimer);
  clearTimeout(testHideTimer);
  if (activeTest && !activeTest.answered && !activeTest.autoReported) {
    sendTestResult(null, lastDetected);
  }
  activeTest = null;
  testHideTimer = setTimeout(() => show(els.testCard, false), 900);
}

function sendDiagnostics(force = false) {
  if (!socket?.connected) return;
  const now = performance.now();
  if (!force && now - lastDiagSent < 2500) return;
  lastDiagSent = now;
  const diagnostics = localDiagnostics ?? audio?.diagnostics?.() ?? {};
  socket.send({
    type: "diag",
    rtt: Number.isFinite(socket.rttMs) ? socket.rttMs : 0,
    buffer: Number(diagnostics.buffer) || 0,
    bufferTarget: Number(diagnostics.bufferTarget) || 8,
    underruns: Number(diagnostics.underruns) || 0,
    dropped: Number(diagnostics.dropped) || 0,
    context: diagnostics.context || "uninitialized",
    received: Number(diagnostics.received) || 0,
    lastSeq: Number.isFinite(diagnostics.lastSeq) ? diagnostics.lastSeq : 0,
    hidden: document.visibilityState === "hidden",
    detail: audioAttempted ? (audio?.ready ? "ready" : "blocked") : "not-enabled",
  });
}

function showFatal(message, title = "Invite problem") {
  fatal = true;
  clearInterval(diagTimer);
  clearTimeout(testFallbackTimer);
  clearTimeout(testHideTimer);
  els.connectionPill.dataset.state = "offline";
  setText(els.connectionText, "Disconnected");
  setText(els.statusTitle, title);
  setText(els.statusDetail, "Ask the host for a fresh listener link.");
  setText(els.fatalMessage, message);
  show(els.fatalPanel, true);
  show(els.unlockPanel, false);
  show(els.resumePanel, false);
  show(els.testCard, false);
  try {
    audio?.stop();
  } catch {}
}
