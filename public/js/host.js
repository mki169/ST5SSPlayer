import {
  clamp,
  formatBytes,
  formatTime,
  streamRateLabel,
} from "./protocol.js";
import { HostAudio } from "./host-audio.js";
import { LisSocket } from "./ws-client.js";
import {
  $,
  copyText,
  createId,
  on,
  readTokenFromHash,
  safeFileTitle,
  setText,
  show,
  throttle,
  toast,
} from "./ui.js";

const els = {
  serverPill: $("#serverPill"),
  serverPillText: $("#serverPillText"),
  tunnelPill: $("#tunnelPill"),
  tunnelPillText: $("#tunnelPillText"),
  listenerCountPill: $("#listenerCountPill"),
  diagToggle: $("#diagToggle"),
  playerCard: $("#playerCard"),
  trackTitle: $("#trackTitle"),
  trackMeta: $("#trackMeta"),
  levelMeter: $("#levelMeter"),
  cover: $("#cover"),
  coverGlyph: $("#coverGlyph"),
  waveform: $("#waveform"),
  waveEmpty: $("#waveEmpty"),
  currentTime: $("#currentTime"),
  seekSlider: $("#seekSlider"),
  durationTime: $("#durationTime"),
  prevBtn: $("#prevBtn"),
  playBtn: $("#playBtn"),
  playIcon: $("#playIcon"),
  pauseIcon: $("#pauseIcon"),
  playSpinner: $("#playSpinner"),
  stopBtn: $("#stopBtn"),
  nextBtn: $("#nextBtn"),
  muteBtn: $("#muteBtn"),
  volumeIcon: $("#volumeIcon"),
  muteIcon: $("#muteIcon"),
  volumeSlider: $("#volumeSlider"),
  volumeValue: $("#volumeValue"),
  testBtn: $("#testBtn"),
  addFilesBtn: $("#addFilesBtn"),
  decodeStatus: $("#decodeStatus"),
  fileInput: $("#fileInput"),
  dropVeil: $("#dropVeil"),
  queueHeading: $("#queueHeading"),
  queueCount: $("#queueCount"),
  clearQueueBtn: $("#clearQueueBtn"),
  queueList: $("#queueList"),
  linkMode: $("#linkMode"),
  listenerLink: $("#listenerLink"),
  copyListenerBtn: $("#copyListenerBtn"),
  openListenerBtn: $("#openListenerBtn"),
  rotateLinkBtn: $("#rotateLinkBtn"),
  publicUrlEditor: $("#publicUrlEditor"),
  publicUrlInput: $("#publicUrlInput"),
  applyPublicUrlBtn: $("#applyPublicUrlBtn"),
  hostLink: $("#hostLink"),
  copyHostBtn: $("#copyHostBtn"),
  linkNote: $("#linkNote"),
  listenerBadge: $("#listenerBadge"),
  listenerList: $("#listenerList"),
  testSummary: $("#testSummary"),
  dismissTestBtn: $("#dismissTestBtn"),
  testResults: $("#testResults"),
  healthCard: $("#healthCard"),
  healthToggle: $("#healthToggle"),
  healthTitle: $("#healthTitle"),
  healthSummary: $("#healthSummary"),
  healthChecks: $("#healthChecks"),
  runDiagBtn: $("#runDiagBtn"),
  copyDiagBtn: $("#copyDiagBtn"),
  diagUpdated: $("#diagUpdated"),
  fatalOverlay: $("#fatalOverlay"),
  fatalTitle: $("#fatalTitle"),
  fatalMessage: $("#fatalMessage"),
  busyOverlay: $("#busyOverlay"),
  busyText: $("#busyText"),
};

const hostToken = readTokenFromHash();
const levelBars = [...document.querySelectorAll("#levelMeter span")];
const QUEUE_LIMIT = 300;
const AUDIO_EXTENSION = /\.(mp3|wav|m4a|aac|ogg|oga|flac|opus|webm|aiff?|caf)$/i;

let audio = null;
let socket = null;
let queue = [];
let currentId = null;
let loadingId = null;
let loadSerial = 0;
let serverLoaded = false;
let sessionInfo = null;
let listenerToken = "";
let listenerUrl = null;
let publicUrl = null;
let tunnel = null;
let listeners = [];
let lastDiag = null;
let hostAudioDiag = null;
let currentTest = null;
let wavePeaks = [];
let isScrubbing = false;
let dragDepth = 0;
let advanceTimer = null;
let lastVolume = 800;
let fatal = false;
let shuttingDown = false;
let hadWelcome = false;
let visibilityWarned = false;

function init() {
  audio = new HostAudio({
    onState() {
      updateTransportUI();
    },
    onPosition({ position, duration }) {
      if (!isScrubbing) {
        updateSeekUI(position, duration);
        drawWaveform(duration ? position / duration : 0);
      }
    },
    onEnded() {
      handleNaturalEnd();
    },
    onFrame(frame) {
      socket?.sendBinary(frame);
    },
    onDiagnostics(diagnostics) {
      hostAudioDiag = diagnostics;
      renderHealthThrottled();
    },
    onLevel(level) {
      renderLevel(level);
    },
  });

  socket = new LisSocket({
    role: "host",
    token: hostToken,
    onStatus(status) {
      handleSocketStatus(status);
    },
    onMessage(message) {
      if (typeof message === "string") return;
      handleServerMessage(message);
    },
    onFatal() {
      if (fatal) return;
      showFatalOverlay(
        "Host link problem",
        "The host token is invalid or this host session was replaced in another tab.",
      );
    },
  });

  bindEvents();
  updateHostLink();
  renderQueue();
  renderVolume();
  updateTransportUI();
  renderListeners();
  renderHealth();
  renderTunnel();
  socket.connect();
}

function bindEvents() {
  on(els.playBtn, "click", togglePlay);
  on(els.stopBtn, "click", stopPlayback);
  on(els.prevBtn, "click", previousTrack);
  on(els.nextBtn, "click", nextTrack);
  on(els.muteBtn, "click", toggleMute);
  on(els.testBtn, "click", startAudioTest);
  on(els.addFilesBtn, "click", () => els.fileInput.click());
  on(els.fileInput, "change", () => {
    addFiles(els.fileInput.files);
    els.fileInput.value = "";
  });
  on(els.clearQueueBtn, "click", clearQueue);
  on(els.queueList, "click", handleQueueClick);
  on(els.queueList, "keydown", handleQueueKey);
  on(els.copyListenerBtn, "click", () => {
    if (listenerUrl) copyText(listenerUrl, "Listener link copied");
    else toast("The tunnel URL is not ready yet.", "warn");
  });
  on(els.copyHostBtn, "click", () => copyText(els.hostLink.value, "Host link copied"));
  on(els.openListenerBtn, "click", openListenerView);
  on(els.rotateLinkBtn, "click", rotateListenerLink);
  on(els.applyPublicUrlBtn, "click", applyPublicUrl);
  on(els.dismissTestBtn, "click", () => {
    if (currentTest) currentTest.dismissed = true;
    show(els.testSummary, false);
  });
  on(els.healthToggle, "click", toggleHealth);
  on(els.diagToggle, "click", () => {
    setHealthOpen(true);
    els.healthCard.scrollIntoView({ behavior: "smooth", block: "nearest" });
  });
  on(els.runDiagBtn, "click", runDiagnostics);
  on(els.copyDiagBtn, "click", copyDiagnosticReport);
  on(els.seekSlider, "pointerdown", () => {
    if (audio?.loaded) isScrubbing = true;
  });
  on(els.seekSlider, "input", previewSeek);
  on(els.seekSlider, "change", commitSeek);
  on(els.seekSlider, "blur", () => {
    isScrubbing = false;
  });
  on(els.volumeSlider, "input", () => {
    applyVolume(Number(els.volumeSlider.value));
  });
  on(els.waveform, "click", handleWaveformClick);
  on(window, "resize", throttle(() => drawWaveform(currentProgress()), 120));
  on(document, "keydown", handleKeyboard);
  on(window, "dragenter", handleDragEnter);
  on(window, "dragover", handleDragOver);
  on(window, "dragleave", handleDragLeave);
  on(window, "drop", handleDrop);
  on(document, "visibilitychange", () => {
    if (
      document.visibilityState === "hidden" &&
      audio?.playing &&
      !visibilityWarned
    ) {
      visibilityWarned = true;
      toast("Keep this tab visible for uninterrupted streaming.", "warn", 5000);
    }
    if (document.visibilityState === "visible") sendDiagnosticsRequest();
  });
  on(window, "pagehide", shutdown);
}

function handleSocketStatus(status) {
  if (fatal) return;
  updateServerPill(status);
  if (status.status === "disconnected" || status.status === "reconnecting") {
    serverLoaded = false;
    if (audio?.playing) {
      cancelAutoAdvance();
      const position = audio.pause();
      updateTransportUI();
      setText(els.decodeStatus, "Connection lost · playback paused");
      toast("Connection lost. Playback paused; reconnecting…", "warn", 4500);
    }
  }
  if (status.status === "connected" && !hadWelcome) {
    setText(els.decodeStatus, "Connected · waiting for handshake");
  }
}

function updateServerPill(status) {
  const state = status?.status ?? "idle";
  let level = "warn";
  let label = "Connecting";
  if (state === "connected") {
    level = "ok";
    label = "Server connected";
  } else if (state === "connecting") {
    level = "warn";
    label = "Connecting";
  } else if (state === "reconnecting") {
    level = "warn";
    label = "Reconnecting";
  } else if (state === "fatal" || state === "closed") {
    level = "fail";
    label = "Server offline";
  } else if (state === "disconnected") {
    level = "fail";
    label = "Disconnected";
  }
  els.serverPill.dataset.level = level;
  setText(els.serverPillText, label);
}

function handleServerMessage(message) {
  switch (message.type) {
    case "welcome": {
      const reconnected = hadWelcome;
      hadWelcome = true;
      sessionInfo = message.session ?? null;
      listenerToken = sessionInfo?.listenerToken ?? listenerToken;
      publicUrl = sessionInfo?.publicUrl ?? publicUrl;
      listenerUrl = sessionInfo?.listenerUrl ?? listenerUrl;
      applyTunnel(message.tunnel, publicUrl, listenerUrl);
      renderListeners(message.listeners ?? []);
      serverLoaded = false;
      if (audio?.loaded) syncLoadedTrackToServer();
      if (reconnected) {
        toast("Reconnected to the room. Press play to resume.", "success", 4200);
      } else {
        setText(els.decodeStatus, "Ready when you are");
      }
      return;
    }
    case "listeners": {
      renderListeners(message.listeners ?? []);
      return;
    }
    case "diag": {
      lastDiag = message;
      if (message.tunnel) tunnel = message.tunnel;
      if (message.publicUrl !== undefined) publicUrl = message.publicUrl;
      if (message.listenerUrl !== undefined) listenerUrl = message.listenerUrl;
      renderTunnel();
      renderInviteUI();
      renderListeners(message.listeners ?? listeners);
      renderHealth();
      return;
    }
    case "tunnel": {
      applyTunnel(message.tunnel, message.publicUrl, message.listenerUrl);
      return;
    }
    case "tokens": {
      listenerToken = message.listenerToken ?? listenerToken;
      publicUrl = message.publicUrl ?? publicUrl;
      listenerUrl = message.listenerUrl ?? listenerUrl;
      if (!listenerUrl && publicUrl && listenerToken) {
        listenerUrl = `${publicUrl}/l#${listenerToken}`;
      }
      renderInviteUI();
      renderTunnel();
      toast("New listener link ready. Existing listeners stay connected.", "success");
      return;
    }
    case "loaded": {
      serverLoaded = true;
      return;
    }
    case "test-started": {
      currentTest = {
        id: message.id,
        results: new Map(),
        ended: false,
        dismissed: false,
      };
      show(els.testSummary, true);
      renderTestResults();
      return;
    }
    case "test-result": {
      if (!currentTest || currentTest.id !== message.testId) return;
      currentTest.results.set(message.listenerId, {
        listenerId: message.listenerId,
        label: message.label,
        heard: message.heard,
        detected: message.detected,
        at: message.at,
      });
      renderTestResults();
      return;
    }
    case "test-end": {
      if (!currentTest || currentTest.id !== message.id) {
        currentTest = {
          id: message.id,
          results: new Map(),
          ended: true,
          dismissed: false,
        };
      }
      for (const result of message.results ?? []) {
        currentTest.results.set(result.listenerId, result);
      }
      currentTest.ended = true;
      show(els.testSummary, true);
      renderTestResults();
      const count = currentTest.results.size;
      toast(
        count
          ? `Audio test finished · ${count} listener${count === 1 ? "" : "s"} replied`
          : "Audio test finished with no listener replies.",
        count ? "success" : "warn",
        4200,
      );
      return;
    }
    case "error": {
      handleServerError(message);
      return;
    }
    default:
      return;
  }
}

function handleServerError(message) {
  if (message.code === "replaced") {
    showFatalOverlay(
      "Host session replaced",
      message.message || "This room was opened in another host tab.",
    );
    return;
  }
  if (message.code === "bad_public_url") {
    toast(message.message || "Enter a valid public URL.", "error");
    return;
  }
  if (message.code === "bad_load") {
    toast(message.message || "The server rejected the track metadata.", "error");
    return;
  }
  if (message.code === "bad_token") return;
  toast(message.message || "The server reported an error.", "warn");
}

function addFiles(fileList) {
  if (!fileList || fatal) return;
  const incoming = [...fileList].filter(
    (file) => file.size > 0 && (file.type.startsWith("audio/") || AUDIO_EXTENSION.test(file.name)),
  );
  if (incoming.length === 0) {
    toast("No playable audio files were found.", "warn");
    return;
  }
  const room = Math.max(0, QUEUE_LIMIT - queue.length);
  const accepted = incoming.slice(0, room);
  for (const file of accepted) {
    queue.push({
      id: createId("track"),
      file,
      name: file.name || "Untitled track",
      title: safeFileTitle(file.name),
      size: file.size,
      duration: null,
      error: null,
    });
  }
  if (accepted.length < incoming.length) {
    toast(`Queue limit reached. Added ${accepted.length} of ${incoming.length} files.`, "warn");
  }
  renderQueue();
  setText(
    els.decodeStatus,
    queue.length === 1 ? "1 track ready" : `${queue.length} tracks ready`,
  );
  if (!currentId && !loadingId && queue.length > 0) {
    selectTrack(queue[0].id, { autoplay: false });
  }
  toast(
    `Added ${accepted.length} track${accepted.length === 1 ? "" : "s"} to the queue.`,
    "success",
  );
}

function isAudioFile(file) {
  return Boolean(
    file && (file.type.startsWith("audio/") || AUDIO_EXTENSION.test(file.name || "")),
  );
}

function currentItem() {
  return queue.find((item) => item.id === currentId) ?? null;
}

function currentIndex() {
  return queue.findIndex((item) => item.id === currentId);
}

async function selectTrack(id, { autoplay = false, auto = false } = {}) {
  if (fatal) return;
  const item = queue.find((entry) => entry.id === id);
  if (!item) return;
  if (loadingId === id) return;
  if (id === currentId && audio?.loaded) {
    cancelAutoAdvance();
    updateTransportUI();
    if (autoplay) await beginPlayback();
    return;
  }

  const serial = ++loadSerial;
  cancelAutoAdvance();
  if (audio?.playing) {
    const position = audio.pause();
    if (socket?.connected) socket.send({ type: "pause", position });
  }
  loadingId = id;
  renderQueue();
  updateTransportUI();
  showBusy(true, `Decoding ${item.name}…`);
  setText(els.decodeStatus, "Decoding locally…");

  try {
    try {
      await audio.resumeContext();
    } catch {}
    const info = await audio.loadFile(item.file);
    if (serial !== loadSerial) return;
    item.duration = info.duration;
    item.error = null;
    currentId = id;
    buildWaveform();
    updateTransportUI();
    if (socket?.connected) {
      serverLoaded = Boolean(
        socket.send({
          type: "load",
          ...info,
          title: item.title,
        }),
      );
    } else {
      serverLoaded = false;
    }
    setText(
      els.decodeStatus,
      `${formatTime(info.duration)} · decoded in ${info.decodeMs ?? audio.decodeMs ?? 0} ms`,
    );
    renderQueue();
    drawWaveform(0);
    if (autoplay) await beginPlayback();
  } catch (err) {
    if (err?.name === "AbortError" || serial !== loadSerial) return;
    item.error = err?.message || "Could not decode this file.";
    setText(els.decodeStatus, "Could not decode this file");
    toast(item.error, "error", 5000);
    renderQueue();
    if (auto) scheduleNextAfterError(id);
  } finally {
    if (serial === loadSerial) {
      loadingId = null;
      showBusy(false);
      renderQueue();
      updateTransportUI();
    }
  }
}

function scheduleNextAfterError(id) {
  const index = queue.findIndex((item) => item.id === id);
  const next = index >= 0 ? queue[index + 1] : null;
  if (!next) {
    setText(els.decodeStatus, "Queue finished");
    return;
  }
  cancelAutoAdvance();
  advanceTimer = setTimeout(() => {
    advanceTimer = null;
    selectTrack(next.id, { autoplay: true, auto: true });
  }, 500);
}

async function beginPlayback() {
  if (!audio?.loaded) return false;
  if (!socket?.connected) {
    toast("Not connected to the server yet. Try again in a moment.", "warn");
    return false;
  }
  cancelAutoAdvance();
  try {
    await audio.resumeContext();
  } catch (err) {
    toast(err?.message || "Audio output is blocked.", "error");
    return false;
  }
  if (!serverLoaded) {
    const resumePosition = audio.currentPosition();
    if (!sendLoadForCurrent()) {
      toast("Could not send the track to the server.", "error");
      return false;
    }
    audio.seek(resumePosition);
    if (resumePosition > 0.01) {
      socket.send({ type: "seek", position: resumePosition, playing: false });
    }
  }
  let position = audio.currentPosition();
  if (!Number.isFinite(position) || position < 0) position = 0;
  if (position >= audio.duration - 0.04) {
    position = 0;
    socket.send({ type: "seek", position: 0, playing: false });
    audio.seek(0);
  }
  socket.send({ type: "play", position });
  try {
    audio.playNow();
  } catch (err) {
    toast(err?.message || "Could not start playback.", "error");
    return false;
  }
  updateTransportUI();
  return true;
}

function syncLoadedTrackToServer() {
  if (!sendLoadForCurrent()) return;
  const position = audio.currentPosition();
  audio.seek(position);
  if (position > 0.01) {
    socket.send({ type: "seek", position, playing: false });
  }
  socket.send({ type: "volume", value: Math.round(audio.volume * 1000) });
}

function sendLoadForCurrent() {
  if (!socket?.connected || !audio?.loaded) return false;
  const item = currentItem();
  const info = audio.streamInfo();
  const ok = socket.send({
    type: "load",
    ...info,
    title: item?.title || audio.fileName,
  });
  if (ok) serverLoaded = true;
  return ok;
}

async function togglePlay() {
  if (fatal) return;
  if (loadingId) {
    toast("Still decoding the selected track.", "info");
    return;
  }
  cancelAutoAdvance();
  if (!audio?.loaded) {
    const item = currentItem() ?? queue[0] ?? null;
    if (item) {
      await selectTrack(item.id, { autoplay: true });
    } else {
      els.fileInput.click();
    }
    return;
  }
  if (audio.playing) {
    const position = audio.pause();
    if (socket?.connected) socket.send({ type: "pause", position });
    updateTransportUI();
    return;
  }
  await beginPlayback();
}

function stopPlayback() {
  if (!audio?.loaded || fatal) return;
  cancelAutoAdvance();
  audio.stop();
  if (socket?.connected) socket.send({ type: "stop" });
  setText(els.decodeStatus, "Stopped");
  updateTransportUI();
  drawWaveform(0);
}

function previousTrack() {
  if (fatal) return;
  if (!audio?.loaded) {
    if (queue.length) selectTrack(queue[0].id, { autoplay: true });
    return;
  }
  if (audio.currentPosition() > 3) {
    performSeek(0);
    return;
  }
  const index = currentIndex();
  if (index > 0) selectTrack(queue[index - 1].id, { autoplay: true });
  else performSeek(0);
}

function nextTrack() {
  if (fatal) return;
  const index = currentIndex();
  const next = index >= 0 ? queue[index + 1] : queue[0];
  if (!next) {
    toast("End of the queue.", "info");
    return;
  }
  selectTrack(next.id, { autoplay: true });
}

function handleNaturalEnd() {
  if (fatal) return;
  const item = currentItem();
  if (!item) return;
  if (socket?.connected) {
    socket.send({ type: "end-of-track", endPts: audio.duration });
  }
  updateTransportUI();
  cancelAutoAdvance();
  const index = currentIndex();
  const next = index >= 0 ? queue[index + 1] : null;
  if (!next) {
    setText(els.decodeStatus, "Queue finished");
    return;
  }
  const waitMs = listenerDrainWaitMs();
  setText(
    els.decodeStatus,
    `Track ended · next in ${Math.max(1, Math.round(waitMs / 1000))}s`,
  );
  advanceTimer = setTimeout(() => {
    advanceTimer = null;
    const freshIndex = currentIndex();
    const nextItem = freshIndex >= 0 ? queue[freshIndex + 1] : null;
    if (nextItem) selectTrack(nextItem.id, { autoplay: true, auto: true });
  }, waitMs);
}

function listenerDrainWaitMs() {
  if (!listeners.length) return 500;
  let maxBuffer = 0;
  for (const listener of listeners) {
    const reportedAge = Number(listener.diagAgeMs);
    const directAge = listener.lastDiagAt ? Date.now() - listener.lastDiagAt : Infinity;
    const age = Number.isFinite(reportedAge) ? reportedAge : directAge;
    const fresh = age < 3500;
    const buffer = Number(listener.buffer);
    const fallback = Number(listener.bufferTarget) || 8;
    const value = fresh && Number.isFinite(buffer) ? Math.max(0, buffer) : fallback;
    maxBuffer = Math.max(maxBuffer, value);
  }
  return clamp(Math.round((maxBuffer + 0.9) * 1000), 900, 12000);
}

function cancelAutoAdvance() {
  if (advanceTimer) {
    clearTimeout(advanceTimer);
    advanceTimer = null;
  }
}

function previewSeek() {
  if (!audio?.loaded) return;
  isScrubbing = true;
  const ratio = clamp(Number(els.seekSlider.value) / 1000, 0, 1);
  setRangeFill(els.seekSlider, ratio * 100);
  setText(els.currentTime, formatTime(audio.duration * ratio));
  drawWaveform(ratio);
}

function commitSeek() {
  if (!audio?.loaded) return;
  const ratio = clamp(Number(els.seekSlider.value) / 1000, 0, 1);
  isScrubbing = false;
  performSeek(audio.duration * ratio);
}

function performSeek(position) {
  if (!audio?.loaded || fatal) return;
  cancelAutoAdvance();
  const target = clamp(Number(position) || 0, 0, Math.max(0, audio.duration - 0.01));
  const playing = audio.playing;
  if (socket?.connected) {
    if (!serverLoaded) sendLoadForCurrent();
    socket.send({ type: "seek", position: target, playing });
  }
  audio.seek(target);
  updateTransportUI();
  drawWaveform(audio.duration ? target / audio.duration : 0);
}

function handleWaveformClick(event) {
  if (!audio?.loaded) return;
  const rect = els.waveform.getBoundingClientRect();
  if (rect.width <= 0) return;
  const ratio = clamp((event.clientX - rect.left) / rect.width, 0, 1);
  performSeek(audio.duration * ratio);
}

function applyVolume(value, { send = true } = {}) {
  if (!audio) return;
  const next = clamp(Math.round(Number(value) || 0), 0, 1000);
  if (next > 0) lastVolume = next;
  audio.setVolume(next / 1000);
  if (send) sendVolumeThrottled(next);
  renderVolume(next);
}

const sendVolumeThrottled = throttle((value) => {
  socket?.send({ type: "volume", value });
}, 80);

function toggleMute() {
  if (!audio) return;
  const current = Math.round(audio.volume * 1000);
  applyVolume(current > 0 ? 0 : lastVolume || 800);
}

function renderVolume(value = Math.round((audio?.volume ?? 0.8) * 1000)) {
  const next = clamp(Number(value) || 0, 0, 1000);
  els.volumeSlider.value = String(next);
  els.volumeValue.textContent = String(next);
  setRangeFill(els.volumeSlider, next / 10);
  const muted = next === 0;
  show(els.volumeIcon, !muted);
  show(els.muteIcon, muted);
  els.muteBtn.title = muted ? "Unmute (M)" : "Mute (M)";
  els.muteBtn.setAttribute("aria-label", muted ? "Unmute" : "Mute");
}

function updateTransportUI() {
  if (!audio) return;
  const loaded = audio.loaded;
  const playing = audio.playing;
  const busy = Boolean(loadingId);
  show(els.playIcon, !playing && !busy);
  show(els.pauseIcon, playing && !busy);
  show(els.playSpinner, busy);
  els.playBtn.disabled = busy;
  els.playBtn.setAttribute("aria-label", playing ? "Pause" : "Play");
  els.playBtn.title = playing ? "Pause (Space)" : "Play (Space)";
  els.cover.classList.toggle("is-playing", playing);
  els.seekSlider.disabled = !loaded;
  els.stopBtn.disabled = !loaded;
  els.prevBtn.disabled = !loaded && queue.length === 0;
  els.nextBtn.disabled = !loaded && queue.length === 0;
  els.muteBtn.disabled = !audio.ctx;
  updateTrackUI();
  updateSeekUI(audio.currentPosition(), audio.duration);
  renderVolume();
}

function updateTrackUI() {
  const loaded = Boolean(audio?.loaded);
  const item = currentItem();
  if (loaded) {
    setText(els.trackTitle, item?.title || safeFileTitle(audio.fileName) || "Untitled track");
    const rate = streamRateLabel(audio.sampleRate, audio.channels);
    const parts = [formatTime(audio.duration), rate];
    if (audio.decodeMs != null) parts.push(`decoded locally in ${audio.decodeMs} ms`);
    setText(els.trackMeta, parts.join(" · "));
  } else {
    setText(els.trackTitle, "Drop an audio file to begin");
    setText(
      els.trackMeta,
      "MP3, WAV, M4A, OGG, FLAC. Decoded locally, never uploaded.",
    );
  }
  show(els.waveEmpty, !loaded);
  if (!loaded) {
    setText(els.durationTime, "0:00");
    setText(els.currentTime, "0:00");
    els.seekSlider.value = "0";
    setRangeFill(els.seekSlider, 0);
  }
}

function updateSeekUI(position = 0, duration = audio?.duration ?? 0) {
  if (!audio) return;
  const safeDuration = Number.isFinite(duration) ? Math.max(0, duration) : 0;
  const safePosition = clamp(Number(position) || 0, 0, safeDuration || 0);
  setText(els.durationTime, formatTime(safeDuration));
  if (isScrubbing) return;
  setText(els.currentTime, formatTime(safePosition));
  const ratio = safeDuration > 0 ? safePosition / safeDuration : 0;
  els.seekSlider.value = String(Math.round(ratio * 1000));
  setRangeFill(els.seekSlider, ratio * 100);
}

function setRangeFill(element, percent) {
  element.style.setProperty("--fill", `${clamp(percent, 0, 100)}%`);
}

function renderLevel(level) {
  const value = clamp(Number(level) || 0, 0, 1);
  const weights = [0.55, 0.9, 0.68, 1, 0.74, 0.95, 0.52];
  levelBars.forEach((bar, index) => {
    const jitter = Math.sin(performance.now() / 110 + index * 1.7) * 0.05;
    const scale = Math.max(0.08, clamp(value * weights[index] + jitter, 0, 1));
    bar.style.transform = `scaleY(${scale.toFixed(3)})`;
  });
}

function buildWaveform() {
  const data = audio?.channelData?.[0];
  if (!data || data.length === 0) {
    wavePeaks = [];
    return;
  }
  const bars = 900;
  const bucket = Math.max(1, Math.floor(data.length / bars));
  const step = Math.max(1, Math.floor(bucket / 48));
  const peaks = new Array(bars).fill(0);
  let max = 0;
  for (let bar = 0; bar < bars; bar += 1) {
    const start = bar * bucket;
    const end = Math.min(data.length, start + bucket);
    let peak = 0;
    for (let i = start; i < end; i += step) {
      const value = Math.abs(data[i]);
      if (value > peak) peak = value;
    }
    peaks[bar] = peak;
    if (peak > max) max = peak;
  }
  wavePeaks = max > 0 ? peaks.map((peak) => peak / max) : peaks;
}

function drawWaveform(progress = 0) {
  const canvas = els.waveform;
  const rect = canvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.round(rect.width * dpr);
  const height = Math.round(rect.height * dpr);
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);
  if (wavePeaks.length === 0 || !audio?.loaded) return;

  const barWidth = 2;
  const gap = 2;
  const barCount = Math.max(1, Math.floor(rect.width / (barWidth + gap)));
  const center = rect.height / 2;
  const progressX = clamp(progress, 0, 1) * rect.width;
  for (let index = 0; index < barCount; index += 1) {
    const start = Math.floor((index / barCount) * wavePeaks.length);
    const end = Math.max(start + 1, Math.floor(((index + 1) / barCount) * wavePeaks.length));
    let peak = 0;
    for (let i = start; i < end; i += 1) peak = Math.max(peak, wavePeaks[i] ?? 0);
    const amplitude = Math.max(1.4, peak * rect.height * 0.4);
    const x = index * (barWidth + gap);
    ctx.fillStyle =
      x + barWidth <= progressX ? "rgba(201, 255, 99, 0.82)" : "rgba(237, 243, 234, 0.2)";
    ctx.fillRect(x, center - amplitude, barWidth, amplitude * 2);
  }
  if (progress > 0 && progress < 1) {
    ctx.fillStyle = "rgba(201, 255, 99, 0.8)";
    ctx.fillRect(progressX, 0, 1, rect.height);
  }
}

function currentProgress() {
  if (!audio?.duration) return 0;
  return clamp(audio.currentPosition() / audio.duration, 0, 1);
}

function handleQueueClick(event) {
  const remove = event.target.closest("[data-remove]");
  if (remove) {
    event.stopPropagation();
    removeTrack(remove.dataset.remove);
    return;
  }
  const row = event.target.closest(".queue-item");
  if (row?.dataset.id) selectTrack(row.dataset.id, { autoplay: true });
}

function handleQueueKey(event) {
  if (event.key !== "Enter" && event.key !== " ") return;
  const remove = event.target.closest("[data-remove]");
  if (remove) return;
  const row = event.target.closest(".queue-item");
  if (!row?.dataset.id) return;
  event.preventDefault();
  selectTrack(row.dataset.id, { autoplay: true });
}

function removeTrack(id) {
  const index = queue.findIndex((item) => item.id === id);
  if (index < 0) return;
  const wasCurrent = id === currentId;
  const wasPlaying = Boolean(audio?.playing);
  if (id === loadingId) {
    audio.cancelPendingLoad();
    loadingId = null;
    showBusy(false);
  }
  if (wasCurrent) {
    cancelAutoAdvance();
    if (audio?.loaded) {
      audio.unload();
      if (socket?.connected) socket.send({ type: "stop" });
    }
    currentId = null;
    serverLoaded = false;
  }
  queue.splice(index, 1);
  if (wasCurrent) {
    const next = queue[Math.min(index, queue.length - 1)] ?? null;
    if (next) {
      selectTrack(next.id, { autoplay: wasPlaying, auto: false });
    } else {
      setText(els.decodeStatus, "Queue empty");
      updateTransportUI();
    }
  }
  renderQueue();
  updateTransportUI();
}

function clearQueue() {
  if (!queue.length) return;
  cancelAutoAdvance();
  if (loadingId) {
    audio?.cancelPendingLoad();
    loadingId = null;
    showBusy(false);
  }
  const hadTrack = Boolean(audio?.loaded) || Boolean(currentId);
  queue = [];
  currentId = null;
  serverLoaded = false;
  if (audio?.loaded) audio.unload();
  if (socket?.connected && hadTrack) socket.send({ type: "stop" });
  renderQueue();
  updateTransportUI();
  drawWaveform(0);
  setText(els.decodeStatus, "Queue cleared");
  toast("Queue cleared.", "info");
}

function renderQueue() {
  const count = queue.length;
  setText(els.queueCount, String(count));
  setText(els.queueHeading, count === 0 ? "No files yet" : count === 1 ? "1 track" : `${count} tracks`);
  els.clearQueueBtn.disabled = count === 0;
  els.queueList.replaceChildren();

  if (count === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    const icon = document.createElement("span");
    icon.className = "empty-icon";
    icon.textContent = "＋";
    const copy = document.createElement("p");
    copy.textContent = "Add a few songs, then press play. The host tab is the only place your library lives.";
    empty.append(icon, copy);
    els.queueList.append(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  queue.forEach((item, index) => {
    const row = document.createElement("div");
    row.className = "queue-item";
    if (item.id === currentId) row.classList.add("is-active");
    if (item.id === loadingId) row.classList.add("is-loading");
    row.dataset.id = item.id;
    row.tabIndex = 0;
    row.setAttribute("role", "button");
    row.setAttribute("aria-label", `Play ${item.title}`);

    const number = document.createElement("span");
    number.className = "queue-index";
    number.textContent = String(index + 1);

    const copy = document.createElement("div");
    copy.className = "queue-copy";
    const title = document.createElement("span");
    title.className = "queue-title";
    title.textContent = item.title;
    const meta = document.createElement("span");
    meta.className = "queue-meta";
    const type = item.file.type || (item.name.split(".").pop() || "audio").toUpperCase();
    meta.textContent = item.error
      ? item.error
      : `${type} · ${formatBytes(item.size)}`;
    copy.append(title, meta);

    const duration = document.createElement("span");
    duration.className = "queue-duration";
    if (item.id === loadingId) duration.textContent = "decoding";
    else if (item.duration != null) duration.textContent = formatTime(item.duration);
    else duration.textContent = "-";

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "queue-remove";
    remove.dataset.remove = item.id;
    remove.title = "Remove from queue";
    remove.setAttribute("aria-label", `Remove ${item.title} from queue`);
    remove.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';

    row.append(number, copy, duration, remove);
    fragment.append(row);
  });
  els.queueList.append(fragment);
}

function updateHostLink() {
  els.hostLink.value = `${location.origin}/h#${hostToken}`;
}

function openListenerView() {
  if (!listenerToken) return;
  const target = listenerUrl || `${location.origin}/l#${listenerToken}`;
  window.open(target, "_blank", "noopener,noreferrer");
}

function rotateListenerLink() {
  if (!socket?.connected) {
    toast("The server is not connected yet.", "warn");
    return;
  }
  socket.send({ type: "rotate-listener" });
  toast("Rotating the listener link…", "info");
}

function applyPublicUrl() {
  if (!socket?.connected) {
    toast("The server is not connected yet.", "warn");
    return;
  }
  let origin = "";
  try {
    const url = new URL(els.publicUrlInput.value.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("bad protocol");
    origin = url.origin;
  } catch {
    toast("Enter a valid http or https tunnel URL.", "error");
    return;
  }
  socket.send({ type: "public-url", url: origin });
  els.publicUrlInput.value = origin;
  toast("Applying the public URL…", "info");
}

function applyTunnel(nextTunnel, nextPublicUrl, nextListenerUrl) {
  if (nextTunnel) tunnel = nextTunnel;
  if (nextPublicUrl !== undefined) publicUrl = nextPublicUrl;
  if (nextListenerUrl !== undefined) listenerUrl = nextListenerUrl;
  if (!listenerUrl && publicUrl && listenerToken) {
    listenerUrl = `${publicUrl}/l#${listenerToken}`;
  }
  renderInviteUI();
  renderTunnel();
}

function renderInviteUI() {
  if (!listenerToken) return;
  if (!listenerUrl && publicUrl && listenerToken) {
    listenerUrl = `${publicUrl}/l#${listenerToken}`;
  }
  els.listenerLink.value = listenerUrl || "";
  els.listenerLink.placeholder = listenerUrl
    ? ""
    : "Waiting for the quick tunnel URL…";
  els.copyListenerBtn.disabled = !listenerUrl;
  els.openListenerBtn.disabled = !listenerToken;

  const status = tunnel?.status ?? (publicUrl ? "custom" : "disabled");
  let mode = "Local only";
  let level = "warn";
  if (status === "online" && tunnel?.url) {
    mode = "Tunnel";
    level = "ok";
  } else if (status === "custom" || publicUrl) {
    mode = "Custom URL";
    level = "ok";
  } else if (status === "starting" || status === "connecting") {
    mode = "Starting";
    level = "warn";
  } else if (status === "error" || status === "offline" || status === "degraded") {
    mode = "Tunnel issue";
    level = "fail";
  }
  els.linkMode.textContent = mode;
  els.linkMode.dataset.level = level;

  const needsEditor =
    !listenerUrl || status === "error" || status === "offline" || status === "degraded";
  show(els.publicUrlEditor, needsEditor);
  if (needsEditor && tunnel?.url && !els.publicUrlInput.value) {
    els.publicUrlInput.value = tunnel.url;
  }

  setText(
    els.linkNote,
    listenerUrl
      ? "The listener can play audio but cannot control anything."
      : "The public URL appears when the quick tunnel is ready. You can also paste a tunnel URL above.",
  );
}

function renderTunnel() {
  const status = tunnel?.status ?? (publicUrl ? "custom" : "disabled");
  let level = "info";
  let label = "Tunnel";
  if (status === "online") {
    level = "ok";
    label = "Tunnel online";
  } else if (status === "custom") {
    level = "ok";
    label = "Custom URL";
  } else if (status === "starting" || status === "connecting") {
    level = "warn";
    label = "Tunnel starting";
  } else if (status === "degraded") {
    level = "warn";
    label = "Tunnel slow";
  } else if (status === "error" || status === "offline") {
    level = "fail";
    label = "Tunnel offline";
  } else if (status === "disabled") {
    level = "info";
    label = "Local only";
  }
  els.tunnelPill.dataset.level = level;
  setText(els.tunnelPillText, label);
}

function renderListeners(list = listeners) {
  listeners = Array.isArray(list) ? list : [];
  const count = listeners.length;
  setText(els.listenerCountPill, `${count} listening`);
  setText(els.listenerBadge, String(count));
  els.listenerList.replaceChildren();

  if (count === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state compact";
    const icon = document.createElement("span");
    icon.className = "empty-icon";
    icon.textContent = "◌";
    const copy = document.createElement("p");
    copy.textContent = "No one connected. Share the listener link when you’re ready.";
    empty.append(icon, copy);
    els.listenerList.append(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const listener of listeners) {
    const row = document.createElement("div");
    row.className = "listener-row";
    const stale = Number(listener.diagAgeMs) > 9000 || !listener.lastDiagAt;
    if (listener.context === "suspended") row.dataset.context = "suspended";

    const dot = document.createElement("span");
    dot.className = "listener-dot";
    dot.dataset.stale = stale ? "true" : "false";

    const copy = document.createElement("div");
    copy.className = "listener-copy";
    const name = document.createElement("span");
    name.className = "listener-name";
    name.textContent = listener.label || "Listener";
    const meta = document.createElement("span");
    meta.className = "listener-meta";
    const rtt = Number.isFinite(listener.rtt) ? `${Math.round(listener.rtt)} ms` : "rtt unknown";
    const buffer = Number.isFinite(listener.buffer) ? `${listener.buffer.toFixed(1)}s` : "buffer unknown";
    const target = Number.isFinite(listener.bufferTarget)
      ? ` / ${listener.bufferTarget.toFixed(1)}s`
      : "";
    const rttPart = document.createElement("span");
    rttPart.textContent = rtt;
    const bufferPart = document.createElement("span");
    bufferPart.textContent = `${buffer}${target}`;
    if (listener.underruns > 0) bufferPart.classList.add("warn");
    const statePart = document.createElement("span");
    statePart.textContent =
      listener.context === "suspended"
        ? "tap to resume"
        : stale
          ? "no signal"
          : `${listener.underruns || 0} underrun${listener.underruns === 1 ? "" : "s"}`;
    if (listener.context === "suspended" || stale || listener.underruns > 0) {
      statePart.classList.add(listener.underruns > 0 ? "bad" : "warn");
    }
    meta.append(rttPart, bufferPart, statePart);
    copy.append(name, meta);

    const bufferLabel = document.createElement("span");
    bufferLabel.className = "listener-buffer";
    bufferLabel.textContent = Number.isFinite(listener.buffer)
      ? `${listener.buffer.toFixed(1)}s`
      : "-";

    row.append(dot, copy, bufferLabel);
    fragment.append(row);
  }
  els.listenerList.append(fragment);
}

function startAudioTest() {
  if (fatal) return;
  if (!listeners.length) {
    toast("No listeners are connected yet.", "warn");
    return;
  }
  if (!socket?.connected) {
    toast("The server is not connected yet.", "warn");
    return;
  }
  const testId = createId("test");
  currentTest = {
    id: testId,
    results: new Map(),
    ended: false,
    dismissed: false,
  };
  show(els.testSummary, true);
  renderTestResults();
  socket.send({ type: "test", testId, durationMs: 1800 });
  toast(`Test tone sent to ${listeners.length} listener${listeners.length === 1 ? "" : "s"}.`, "info");
}

function renderTestResults() {
  if (!currentTest || currentTest.dismissed) {
    show(els.testSummary, false);
    return;
  }
  show(els.testSummary, true);
  els.testResults.replaceChildren();
  const results = [...currentTest.results.values()];
  if (results.length === 0) {
    const waiting = document.createElement("div");
    waiting.className = "test-result-row";
    waiting.textContent = currentTest.ended
      ? "No listener replies. Ask them to check audio and try again."
      : "Waiting for listener replies…";
    els.testResults.append(waiting);
    return;
  }
  for (const result of results) {
    const row = document.createElement("div");
    row.className = "test-result-row";
    const label = document.createElement("strong");
    label.textContent = result.label || "Listener";
    const detail = document.createElement("span");
    const heard = result.heard;
    if (heard === true) detail.textContent = "heard it";
    else if (heard === false) detail.textContent = "did not hear it";
    else if (result.detected) detail.textContent = "tone detected";
    else detail.textContent = "waiting for reply";
    const verdict = document.createElement("span");
    verdict.className = "test-verdict";
    if (heard === true) {
      verdict.textContent = result.detected ? "clear" : "check output";
      verdict.classList.add(result.detected ? "ok" : "warn");
    } else if (heard === false) {
      verdict.textContent = result.detected ? "device muted" : "no audio";
      verdict.classList.add(result.detected ? "warn" : "bad");
    } else {
      verdict.textContent = result.detected ? "tone detected" : "pending";
      verdict.classList.add(result.detected ? "ok" : "warn");
    }
    row.append(label, detail, verdict);
    els.testResults.append(row);
  }
}

function toggleHealth() {
  const open = els.healthCard.dataset.open !== "false";
  setHealthOpen(!open);
}

function setHealthOpen(open) {
  els.healthCard.dataset.open = open ? "true" : "false";
  els.healthToggle.setAttribute("aria-expanded", open ? "true" : "false");
}

const renderHealthThrottled = throttle(renderHealth, 1000);

function renderHealth() {
  const checks = [...(lastDiag?.checks ?? []), ...localChecks()];
  els.healthChecks.replaceChildren();
  for (const check of checks) {
    const row = document.createElement("div");
    row.className = "check-row";
    row.dataset.level = check.level || "info";
    const dot = document.createElement("span");
    dot.className = "check-dot";
    const label = document.createElement("span");
    label.className = "check-label";
    label.textContent = check.label || check.id || "Check";
    const value = document.createElement("span");
    value.className = "check-value";
    value.textContent = check.detail || "";
    value.title = check.detail || "";
    row.append(dot, label, value);
    els.healthChecks.append(row);
  }

  const levels = checks.map((check) => check.level);
  const fails = levels.filter((level) => level === "fail").length;
  const warns = levels.filter((level) => level === "warn").length;
  const oks = levels.filter((level) => level === "ok").length;
  let level = "info";
  let title = "Checking the room…";
  let summary = "No data yet";
  if (fails > 0) {
    level = "fail";
    title = "Needs attention";
    summary = `${fails} issue${fails === 1 ? "" : "s"}${warns ? ` · ${warns} warning${warns === 1 ? "" : "s"}` : ""}`;
  } else if (warns > 0) {
    level = "warn";
    title = "Mostly healthy";
    summary = `${warns} warning${warns === 1 ? "" : "s"}${oks ? ` · ${oks} ok` : ""}`;
  } else if (oks > 0) {
    level = "ok";
    title = "All systems go";
    summary = `${oks} check${oks === 1 ? "" : "s"} passing`;
  }
  setText(els.healthTitle, title);
  els.healthSummary.dataset.level = level;
  setText(els.healthSummary, summary);
  if (lastDiag?.now) {
    const time = new Date(lastDiag.now).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    setText(els.diagUpdated, `Updated ${time} · server checks refresh every 2s`);
  } else {
    setText(els.diagUpdated, "Waiting for the first server check…");
  }
}

function localChecks() {
  const checks = [];
  const connected = Boolean(socket?.connected);
  checks.push({
    id: "local-ws",
    level: connected ? "ok" : "fail",
    label: "Host WebSocket",
    detail: connected
      ? Number.isFinite(socket.rttMs)
        ? `RTT ${Math.round(socket.rttMs)} ms`
        : "Connected"
      : "Not connected",
  });
  const context = audio?.ctx?.state ?? "uninitialized";
  checks.push({
    id: "local-audio",
    level: !audio?.loaded ? "info" : context === "running" ? "ok" : "warn",
    label: "Host audio engine",
    detail: !audio?.loaded
      ? "No track loaded"
      : `${context}${audio.playing ? " · playing" : ""}${audio.muted ? " · muted" : ""}`,
  });
  if (audio?.playing && hostAudioDiag) {
    const ahead = Number(hostAudioDiag.ahead) || 0;
    checks.push({
      id: "local-pacing",
      level: ahead >= 5 ? "ok" : "warn",
      label: "Stream pacing",
      detail: `${ahead.toFixed(1)}s ahead of the host playhead`,
    });
    const sendAge = hostAudioDiag.lastSendAgeMs;
    if (Number.isFinite(sendAge) && sendAge > 2000) {
      checks.push({
        id: "local-send",
        level: "warn",
        label: "Audio pump",
        detail: `Last frame sent ${Math.round(sendAge / 1000)}s ago`,
      });
    }
  }
  if (listeners.length > 0) {
    const stale = listeners.filter(
      (listener) => !listener.lastDiagAt || Number(listener.diagAgeMs) > 9000,
    ).length;
    const suspended = listeners.filter((listener) => listener.context === "suspended").length;
    const underruns = listeners.reduce(
      (total, listener) => total + (Number(listener.underruns) || 0),
      0,
    );
    let level = "ok";
    const notes = [];
    if (stale > 0) {
      level = "warn";
      notes.push(`${stale} stale`);
    }
    if (suspended > 0) {
      level = "warn";
      notes.push(`${suspended} tap-to-resume`);
    }
    if (underruns > 0) {
      level = "warn";
      notes.push(`${underruns} underruns`);
    }
    checks.push({
      id: "local-listeners",
      level,
      label: "Listener playback",
      detail: notes.length ? notes.join(" · ") : `${listeners.length} listening cleanly`,
    });
  }
  return checks;
}

function runDiagnostics() {
  if (!socket?.connected) {
    toast("The server is not connected yet.", "warn");
    return;
  }
  sendDiagnosticsRequest();
  setText(els.diagUpdated, "Running a fresh check…");
}

function sendDiagnosticsRequest() {
  socket?.send({ type: "diag-request" });
}

async function copyDiagnosticReport() {
  const checks = [...(lastDiag?.checks ?? []), ...localChecks()];
  const lines = [
    "ST5SSPlayer host diagnostic report",
    `Generated: ${new Date().toISOString()}`,
    `App: ${lastDiag?.server?.app ?? sessionInfo?.appVersion ?? "unknown"}`,
    `Node: ${lastDiag?.server?.node ?? "unknown"}`,
    `Uptime: ${lastDiag?.server?.uptimeSec ?? "?"}s`,
    `Tunnel: ${lastDiag?.tunnel?.status ?? tunnel?.status ?? "unknown"}`,
    `Public origin: ${publicUrl || "not set"}`,
    `Listeners: ${listeners.length}`,
    "",
    "Server:",
    `  memory RSS: ${formatBytes(lastDiag?.server?.memoryRss ?? 0)}`,
    `  heap: ${formatBytes(lastDiag?.server?.memoryHeap ?? 0)}`,
    `  event loop lag: ${lastDiag?.server?.eventLoopLagMs ?? "?"} ms`,
    `  audio rate: ${formatBytes(lastDiag?.server?.audioBps ?? 0)}/s`,
    `  relay rate: ${formatBytes(lastDiag?.server?.relayBps ?? 0)}/s`,
    `  history: ${Number(lastDiag?.server?.historySeconds ?? 0).toFixed(1)}s / ${formatBytes(lastDiag?.server?.historyBytes ?? 0)}`,
    "",
    "Host:",
    `  WebSocket: ${socket?.connected ? "connected" : "disconnected"}`,
    `  RTT: ${Number.isFinite(socket?.rttMs) ? `${Math.round(socket.rttMs)} ms` : "unknown"}`,
    `  audio context: ${audio?.ctx?.state ?? "uninitialized"}`,
    `  playback: ${audio?.playing ? "playing" : "paused"}`,
    `  output: ${audio?.sampleRate ?? 0} Hz ${audio?.channels ?? 0} ch`,
    `  stream ahead: ${hostAudioDiag ? Number(hostAudioDiag.ahead).toFixed(1) : "?"}s`,
    `  last frame age: ${hostAudioDiag?.lastSendAgeMs != null ? `${Math.round(hostAudioDiag.lastSendAgeMs)} ms` : "n/a"}`,
    "",
    "Checks:",
    ...checks.map(
      (check) => `  [${String(check.level || "info").toUpperCase()}] ${check.label}: ${check.detail || ""}`,
    ),
    "",
    "Listeners:",
    ...(listeners.length
      ? listeners.map(
          (listener) =>
            `  ${listener.label}: rtt ${Number.isFinite(listener.rtt) ? `${Math.round(listener.rtt)}ms` : "?"}, buffer ${Number.isFinite(listener.buffer) ? `${listener.buffer.toFixed(1)}s/${listener.bufferTarget ?? "?"}s` : "?"}, underruns ${listener.underruns ?? 0}, context ${listener.context ?? "?"}, signal ${Number(listener.diagAgeMs) > 9000 ? "stale" : "fresh"}`,
        )
      : ["  none"]),
    "",
    `Browser: ${navigator.userAgent}`,
  ];
  await copyText(lines.join("\n"), "Diagnostic report copied");
}

function showBusy(visible, text = "Decoding audio…") {
  setText(els.busyText, text);
  show(els.busyOverlay, visible);
}

function handleKeyboard(event) {
  if (fatal) return;
  const target = event.target;
  if (
    target instanceof HTMLElement &&
    (target.closest("input, textarea, select, button, [contenteditable='true']") ||
      target.isContentEditable)
  ) {
    return;
  }
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  switch (event.key) {
    case " ":
      event.preventDefault();
      togglePlay();
      break;
    case "ArrowLeft":
      event.preventDefault();
      seekBy(-5);
      break;
    case "ArrowRight":
      event.preventDefault();
      seekBy(5);
      break;
    case "ArrowUp":
      event.preventDefault();
      applyVolume(Math.round((audio?.volume ?? 0.8) * 1000) + 25);
      break;
    case "ArrowDown":
      event.preventDefault();
      applyVolume(Math.round((audio?.volume ?? 0.8) * 1000) - 25);
      break;
    case "m":
    case "M":
      event.preventDefault();
      toggleMute();
      break;
    case "s":
    case "S":
      event.preventDefault();
      stopPlayback();
      break;
    case "n":
    case "N":
      event.preventDefault();
      nextTrack();
      break;
    case "b":
    case "B":
      event.preventDefault();
      previousTrack();
      break;
    default:
      break;
  }
}

function seekBy(delta) {
  if (!audio?.loaded) return;
  performSeek(audio.currentPosition() + delta);
}

function handleDragEnter(event) {
  if (!event.dataTransfer || ![...event.dataTransfer.types].includes("Files")) return;
  dragDepth += 1;
  show(els.dropVeil, true);
  els.dropVeil.classList.add("is-active");
}

function handleDragOver(event) {
  if (event.dataTransfer && [...event.dataTransfer.types].includes("Files")) {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }
}

function handleDragLeave() {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) {
    els.dropVeil.classList.remove("is-active");
    show(els.dropVeil, false);
  }
}

function handleDrop(event) {
  event.preventDefault();
  dragDepth = 0;
  els.dropVeil.classList.remove("is-active");
  show(els.dropVeil, false);
  if (event.dataTransfer?.files?.length) addFiles(event.dataTransfer.files);
}

function showFatalOverlay(title, message) {
  if (fatal) return;
  fatal = true;
  cancelAutoAdvance();
  showBusy(false);
  try {
    audio?.stop();
    audio?.unload();
  } catch {}
  try {
    socket?.close();
  } catch {}
  setText(els.serverPillText, "Server offline");
  els.serverPill.dataset.level = "fail";
  setText(els.fatalTitle, title);
  setText(els.fatalMessage, message);
  show(els.fatalOverlay, true);
}

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  cancelAutoAdvance();
  clearTimeout(advanceTimer);
  socket?.close();
  audio?.destroy();
}

function boot() {
  if (!hostToken) {
    showFatalOverlay(
      "Host link problem",
      "This host link is missing its private token. Open the host link printed in your terminal.",
    );
    return;
  }
  init();
}

boot();
