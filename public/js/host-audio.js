import { clamp, encodeAudioFrame } from "./protocol.js";

const CHUNK_SECONDS = 0.1;

export class HostAudio {
  constructor({
    onState,
    onPosition,
    onEnded,
    onFrame,
    onDiagnostics,
    onLevel,
    lookahead = 9.5,
  } = {}) {
    this.onState = onState ?? (() => {});
    this.onPosition = onPosition ?? (() => {});
    this.onEnded = onEnded ?? (() => {});
    this.onFrame = onFrame ?? (() => {});
    this.onDiagnostics = onDiagnostics ?? (() => {});
    this.onLevel = onLevel ?? (() => {});
    this.lookahead = lookahead;
    this.ctx = null;
    this.gain = null;
    this.analyser = null;
    this.levelData = null;
    this.buffer = null;
    this.channelData = null;
    this.streamChannels = 0;
    this.duration = 0;
    this.playing = false;
    this.position = 0;
    this.startOffset = 0;
    this.startCtxTime = 0;
    this.source = null;
    this.volume = 0.8;
    this.muted = false;
    this.streamId = 1;
    this.sentUntilFrames = 0;
    this.sendSeq = 0;
    this.sentFrames = 0;
    this.sentBytes = 0;
    this.pumpTimer = null;
    this.tickTimer = null;
    this.lastEndedAt = 0;
    this.fileName = "";
    this.decodeMs = null;
    this.lastSendAt = 0;
    this.pumping = false;
    this.loadToken = 0;
  }

  get loaded() {
    return Boolean(this.buffer);
  }

  get sampleRate() {
    return this.ctx?.sampleRate || 0;
  }

  get channels() {
    return this.streamChannels;
  }

  ensureContext() {
    if (this.ctx) return this.ctx;
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) throw new Error("This browser does not support the Web Audio API.");
    this.ctx = new AudioContextClass({ latencyHint: "interactive" });
    this.gain = this.ctx.createGain();
    this.gain.gain.value = this.volume;
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 512;
    this.analyser.smoothingTimeConstant = 0.7;
    this.levelData = new Float32Array(this.analyser.fftSize);
    this.gain.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);
    this.ctx.addEventListener("statechange", () => this.emitState());
    this.tickTimer = setInterval(() => this.tick(), 250);
    return this.ctx;
  }

  async resumeContext() {
    const ctx = this.ensureContext();
    if (ctx.state === "suspended") {
      try {
        await ctx.resume();
      } catch {
        throw new Error("Audio is blocked. Click Play again to allow sound.");
      }
    }
    if (ctx.state !== "running") {
      throw new Error("Audio output is unavailable. Check your system audio.");
    }
    return ctx;
  }

  cancelPendingLoad() {
    this.loadToken += 1;
  }

  async loadFile(file) {
    if (!file) throw new Error("No file selected.");
    if (file.size > 1.5 * 1024 * 1024 * 1024) {
      throw new Error("That file is too large to decode safely.");
    }
    const token = ++this.loadToken;
    const ctx = this.ensureContext();
    const started = performance.now();
    let arrayBuffer;
    try {
      arrayBuffer = await file.arrayBuffer();
    } catch (err) {
      throw new Error(`Could not read the file: ${err.message}`);
    }

    let decoded;
    try {
      decoded = await ctx.decodeAudioData(arrayBuffer);
    } catch {
      throw new Error(
        "This browser could not decode that audio file. Try MP3, WAV, M4A/AAC, OGG, or FLAC.",
      );
    } finally {
      arrayBuffer = null;
    }

    if (token !== this.loadToken) {
      throw new DOMException("Load superseded by a newer file.", "AbortError");
    }
    if (!decoded || decoded.duration <= 0 || decoded.length === 0) {
      throw new Error("The audio file is empty or has no playable audio.");
    }

    this.stopSource();
    this.stopPump();
    this.releaseBuffer();
    this.buffer = decoded;
    this.channelData = [];
    for (let channel = 0; channel < decoded.numberOfChannels; channel += 1) {
      this.channelData.push(decoded.getChannelData(channel));
    }
    this.streamChannels = decoded.numberOfChannels > 1 ? 2 : 1;
    this.duration = decoded.duration;
    this.position = 0;
    this.playing = false;
    this.sentUntilFrames = 0;
    this.sentFrames = 0;
    this.sentBytes = 0;
    this.sendSeq = 0;
    this.streamId = (this.streamId + 1) >>> 0 || 1;
    this.fileName = file.name || "Untitled track";
    this.decodeMs = Math.round(performance.now() - started);
    this.emitState();
    this.emitPosition();
    return this.streamInfo();
  }

  streamInfo() {
    return {
      streamId: this.streamId,
      sampleRate: this.ctx?.sampleRate || 0,
      channels: this.streamChannels,
      duration: this.duration,
      title: this.fileName,
    };
  }

  playNow() {
    if (!this.buffer) throw new Error("Choose an audio file first.");
    if (!this.ctx || this.ctx.state !== "running") {
      throw new Error("Audio is not ready. Click Play again.");
    }
    if (this.playing) return;
    if (this.position >= this.duration - 0.03) {
      this.position = 0;
      this.sentUntilFrames = 0;
    }
    this.startPlaybackAt(this.position);
    this.startPump();
    this.emitState();
    this.emitPosition();
  }

  startPlaybackAt(position) {
    const ctx = this.ctx;
    this.stopSource();
    const source = ctx.createBufferSource();
    source.buffer = this.buffer;
    source.connect(this.gain);
    const startTime = ctx.currentTime + 0.045;
    source.start(startTime, position);
    this.source = source;
    source.onended = () => {
      if (this.source !== source) return;
      this.source = null;
      this.handleNaturalEnd();
    };
    this.startOffset = position;
    this.startCtxTime = startTime;
    this.playing = true;
    this.lastEndedAt = 0;
  }

  unload() {
    this.playing = false;
    this.position = 0;
    this.sentUntilFrames = 0;
    this.sendSeq = 0;
    this.stopSource();
    this.stopPump();
    this.releaseBuffer();
    this.streamChannels = 0;
    this.fileName = "";
    this.decodeMs = null;
    this.emitState();
    this.emitPosition();
  }

  pause() {
    if (!this.playing) return this.position;
    const current = this.currentPosition();
    this.position = current;
    this.playing = false;
    this.stopSource();
    this.stopPump();
    this.emitState();
    this.emitPosition();
    return current;
  }

  stop() {
    this.playing = false;
    this.position = 0;
    this.sentUntilFrames = 0;
    this.sendSeq = 0;
    this.stopSource();
    this.stopPump();
    this.emitState();
    this.emitPosition();
  }

  seek(position) {
    if (!this.buffer) return 0;
    const target = clamp(Number(position) || 0, 0, Math.max(0, this.duration - 0.01));
    this.position = target;
    this.sentUntilFrames = Math.min(
      this.buffer.length,
      Math.round(target * this.sampleRate),
    );
    if (this.playing) {
      this.startPlaybackAt(target);
      this.startPump();
    }
    this.emitState();
    this.emitPosition();
    return target;
  }

  setVolume(value, { silent = false } = {}) {
    this.volume = clamp(Number(value) || 0, 0, 1);
    if (this.ctx && this.gain) {
      this.gain.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.025);
    }
    this.muted = this.volume === 0;
    if (!silent) this.emitState();
  }

  currentPosition() {
    if (!this.playing || !this.ctx) return this.position;
    const position = this.startOffset + Math.max(0, this.ctx.currentTime - this.startCtxTime);
    return clamp(position, 0, this.duration);
  }

  startPump() {
    clearInterval(this.pumpTimer);
    this.pumpTimer = setInterval(() => this.pump(), 40);
    this.pump();
  }

  stopPump() {
    clearInterval(this.pumpTimer);
    this.pumpTimer = null;
  }

  pump() {
    if (!this.playing || !this.buffer || this.pumping) return;
    this.pumping = true;
    try {
      const targetFrames = Math.min(
        this.buffer.length,
        Math.round((this.currentPosition() + this.lookahead) * this.sampleRate),
      );
      while (this.sentUntilFrames < targetFrames) {
        const remaining = targetFrames - this.sentUntilFrames;
        const frames = Math.min(
          remaining,
          Math.round(CHUNK_SECONDS * this.sampleRate),
          this.buffer.length - this.sentUntilFrames,
        );
        if (frames <= 0) break;
        const pts = this.sentUntilFrames / this.sampleRate;
        const payload = this.buildPcmChunk(this.sentUntilFrames, frames);
        const frame = encodeAudioFrame({
          channels: this.streamChannels,
          sampleRate: this.sampleRate,
          frames,
          pts,
          seq: this.sendSeq >>> 0,
          streamId: this.streamId,
          payload,
        });
        this.sendSeq = (this.sendSeq + 1) >>> 0;
        this.sentUntilFrames += frames;
        this.sentFrames += frames;
        this.sentBytes += frame.byteLength;
        this.lastSendAt = performance.now();
        this.onFrame(frame);
      }
    } finally {
      this.pumping = false;
    }
  }

  buildPcmChunk(startFrame, frames) {
    const channels = this.streamChannels;
    const output = new Int16Array(frames * channels);
    const channelCount = this.channelData.length;
    const ch0 = this.channelData[0];
    const ch1 = channelCount > 1 ? this.channelData[1] : null;
    let out = 0;

    if (channels === 1) {
      if (channelCount === 1) {
        for (let i = 0; i < frames; i += 1) {
          output[out++] = floatToInt16(ch0[startFrame + i]);
        }
      } else {
        for (let i = 0; i < frames; i += 1) {
          let sample = 0;
          for (let channel = 0; channel < channelCount; channel += 1) {
            sample += this.channelData[channel][startFrame + i];
          }
          output[out++] = floatToInt16(sample / channelCount);
        }
      }
      return output;
    }

    if (channelCount === 2) {
      for (let i = 0; i < frames; i += 1) {
        output[out++] = floatToInt16(ch0[startFrame + i]);
        output[out++] = floatToInt16(ch1[startFrame + i]);
      }
      return output;
    }

    for (let i = 0; i < frames; i += 1) {
      let left = ch0[startFrame + i];
      let right = ch1[startFrame + i];
      for (let channel = 2; channel < channelCount; channel += 1) {
        const sample = this.channelData[channel][startFrame + i] * 0.707;
        if (channel % 2 === 0) left += sample;
        else right += sample;
      }
      output[out++] = floatToInt16(left);
      output[out++] = floatToInt16(right);
    }
    return output;
  }

  tick() {
    if (!this.buffer) {
      this.onDiagnostics(this.diagnostics());
      return;
    }
    if (this.playing) {
      const position = this.currentPosition();
      if (position >= this.duration - 0.02) {
        this.handleNaturalEnd();
      } else {
        this.emitPosition();
      }
    }
    this.updateLevel();
    this.onDiagnostics(this.diagnostics());
  }

  handleNaturalEnd() {
    if (!this.buffer) return;
    const now = performance.now();
    if (now - this.lastEndedAt < 200) return;
    this.lastEndedAt = now;
    this.playing = false;
    this.position = this.duration;
    this.stopSource();
    this.stopPump();
    this.emitState();
    this.emitPosition();
    this.onEnded({ duration: this.duration });
  }

  updateLevel() {
    if (!this.analyser || !this.levelData) return;
    if (!this.playing) {
      this.onLevel(0);
      return;
    }
    this.analyser.getFloatTimeDomainData(this.levelData);
    let sum = 0;
    for (let i = 0; i < this.levelData.length; i += 1) {
      sum += this.levelData[i] * this.levelData[i];
    }
    const rms = Math.sqrt(sum / this.levelData.length);
    this.onLevel(clamp(rms * 3.2, 0, 1));
  }

  emitState() {
    this.onState({
      loaded: this.loaded,
      playing: this.playing,
      position: this.currentPosition(),
      duration: this.duration,
      sampleRate: this.sampleRate,
      channels: this.streamChannels,
      volume: this.volume,
      muted: this.muted,
      context: this.ctx?.state ?? "uninitialized",
      fileName: this.fileName,
    });
  }

  emitPosition() {
    this.onPosition({
      position: this.currentPosition(),
      duration: this.duration,
      playing: this.playing,
    });
  }

  streamCursor() {
    return {
      sentUntil: this.sentUntilFrames / (this.sampleRate || 1),
      ahead: this.sentUntilFrames / (this.sampleRate || 1) - this.currentPosition(),
    };
  }

  diagnostics() {
    return {
      loaded: this.loaded,
      playing: this.playing,
      context: this.ctx?.state ?? "uninitialized",
      sampleRate: this.sampleRate,
      channels: this.streamChannels,
      duration: this.duration,
      position: this.currentPosition(),
      sentFrames: this.sentFrames,
      sentBytes: this.sentBytes,
      seq: this.sendSeq,
      ...this.streamCursor(),
      decodeMs: this.decodeMs,
      lastSendAgeMs: this.lastSendAt ? performance.now() - this.lastSendAt : null,
    };
  }

  stopSource() {
    if (!this.source) return;
    const source = this.source;
    this.source = null;
    try {
      source.stop();
    } catch {}
    try {
      source.disconnect();
    } catch {}
  }

  releaseBuffer() {
    if (!this.buffer) return;
    this.buffer = null;
    this.channelData = null;
    this.duration = 0;
  }

  async destroy() {
    clearInterval(this.tickTimer);
    this.tickTimer = null;
    this.stopPump();
    this.stopSource();
    this.releaseBuffer();
    const ctx = this.ctx;
    this.ctx = null;
    this.gain = null;
    this.analyser = null;
    this.levelData = null;
    if (ctx && ctx.state !== "closed") {
      try {
        await ctx.close();
      } catch {}
    }
  }
}

function floatToInt16(sample) {
  const clamped = sample < -1 ? -1 : sample > 1 ? 1 : sample;
  return clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
}
