import { clamp, pcm16ToFloat32Channels } from "./protocol.js";

const FADE_SECONDS = 0.02;
const START_DELAY = 0.1;
const TEST_LEVEL = 0.24;

export class ListenerAudio {
  constructor({ onStatus, onDiagnostics, onTestDetected, onUnderrun } = {}) {
    this.onStatus = onStatus ?? (() => {});
    this.onDiagnostics = onDiagnostics ?? (() => {});
    this.onTestDetected = onTestDetected ?? (() => {});
    this.onUnderrun = onUnderrun ?? (() => {});
    this.ctx = null;
    this.masterGain = null;
    this.analyser = null;
    this.testGain = null;
    this.volume = 0.8;
    this.bufferTarget = 8;
    this.sampleRate = 0;
    this.channels = 0;
    this.streamId = 0;
    this.hostPlaying = false;
    this.state = "idle";
    this.pending = [];
    this.scheduled = [];
    this.timelineStartTime = null;
    this.timelineStartPts = null;
    this.nextStartTime = null;
    this.pausedPts = null;
    this.bufferedEndPts = null;
    this.expectedEndPts = null;
    this.draining = false;
    this.lastSeq = null;
    this.receivedChunks = 0;
    this.receivedBytes = 0;
    this.underruns = 0;
    this.dropped = 0;
    this.gaps = 0;
    this.test = null;
    this.testDucking = false;
    this.testRestoreTimer = null;
    this.testDetectTimer = null;
    this.monitorTimer = null;
    this.monitorData = null;
    this.lastStateEmit = 0;
  }

  get ready() {
    return Boolean(this.ctx && this.ctx.state !== "closed");
  }

  async init() {
    if (this.ctx) {
      if (this.ctx.state === "suspended") {
        try {
          await this.ctx.resume();
        } catch {}
      }
      this.emitStatus();
      return this.ctx.state === "running";
    }

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) {
      this.state = "unsupported";
      this.emitStatus(true);
      return false;
    }

    this.ctx = new AudioContextClass({ latencyHint: "interactive" });
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = this.volume;
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0;
    this.testGain = this.ctx.createGain();
    this.testGain.gain.value = TEST_LEVEL;
    this.masterGain.connect(this.analyser);
    this.testGain.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);
    this.monitorData = new Float32Array(this.analyser.fftSize);
    this.ctx.addEventListener("statechange", () => this.emitStatus(true));

    if (this.ctx.state === "suspended") {
      try {
        await this.ctx.resume();
      } catch {}
    }

    this.monitorTimer = setInterval(() => this.monitor(), 400);
    this.emitStatus(true);
    return this.ctx.state === "running";
  }

  emitStatus(force = false) {
    const now = performance.now();
    if (!force && now - this.lastStateEmit < 250) return;
    this.lastStateEmit = now;
    this.onStatus({
      state: this.state,
      context: this.ctx?.state ?? "uninitialized",
      buffer: this.bufferedLead(),
      bufferTarget: this.bufferTarget,
    });
  }

  configure({ streamId, sampleRate, channels, volume, bufferTarget }) {
    if (Number.isFinite(volume)) this.setVolume(volume / 1000);
    if (Number.isFinite(bufferTarget)) {
      this.bufferTarget = clamp(bufferTarget, 3, 15);
    }
    const nextSampleRate = Number(sampleRate) || 0;
    const nextChannels = Number(channels) || 0;
    const changed =
      nextSampleRate !== this.sampleRate ||
      nextChannels !== this.channels ||
      (streamId !== undefined && streamId !== this.streamId);
    if (changed) {
      this.reset({ silent: true });
      this.sampleRate = nextSampleRate;
      this.channels = nextChannels;
      this.streamId = Number(streamId) || 0;
    } else if (Number.isFinite(streamId)) {
      this.streamId = streamId;
    }
  }

  applyStreamSync(message) {
    if (!this.ctx) return;
    this.reset({ silent: true });
    this.configure({
      streamId: message.streamId,
      sampleRate: message.sampleRate,
      channels: message.channels,
      volume: message.volume,
      bufferTarget: message.bufferTarget,
    });
    this.hostPlaying = Boolean(message.playing);
    this.pausedPts = null;
    this.emitStatus(true);
    if (this.hostPlaying) this.pump();
  }

  setVolume(value) {
    this.volume = clamp(Number(value) || 0, 0, 1);
    if (this.ctx && !this.testDucking) {
      this.masterGain.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.03);
    }
  }

  enqueue(frame) {
    if (!this.ctx) {
      this.dropped += 1;
      return;
    }
    if (
      !this.sampleRate ||
      frame.streamId !== this.streamId ||
      frame.sampleRate !== this.sampleRate ||
      frame.channels !== this.channels
    ) {
      this.dropped += 1;
      return;
    }

    if (this.bufferedEndPts != null) {
      if (frame.pts + frame.duration <= this.bufferedEndPts + 0.005) {
        this.dropped += 1;
        return;
      }
      if (frame.pts > this.bufferedEndPts + 0.3) this.gaps += 1;
      if (frame.pts < this.bufferedEndPts - 0.005) {
        this.dropped += 1;
        return;
      }
    }

    const floatChannels = pcm16ToFloat32Channels(frame.payload, frame.channels, frame.frames);
    const buffer = this.ctx.createBuffer(frame.channels, frame.frames, frame.sampleRate);
    for (let channel = 0; channel < frame.channels; channel += 1) {
      buffer.copyToChannel(floatChannels[channel], channel);
    }

    this.pending.push({
      pts: frame.pts,
      duration: frame.duration,
      buffer,
      channels: frame.channels,
      sampleRate: frame.sampleRate,
    });
    this.pending.sort((a, b) => a.pts - b.pts);
    this.bufferedEndPts = Math.max(this.bufferedEndPts ?? 0, frame.pts + frame.duration);
    this.lastSeq = frame.seq;
    this.receivedChunks += 1;
    this.receivedBytes += frame.payload.byteLength;

    if (this.hostPlaying) this.pump();
    this.emitStatus();
  }

  currentPts() {
    if (!this.ctx) return this.pausedPts;
    if (this.state === "playing" && this.timelineStartTime != null) {
      const elapsed = Math.max(0, this.ctx.currentTime - this.timelineStartTime);
      return Math.min(
        this.bufferedEndPts ?? this.timelineStartPts + elapsed,
        this.timelineStartPts + elapsed,
      );
    }
    if (this.state === "paused" && this.pausedPts != null) return this.pausedPts;
    if (this.pending.length > 0) return this.pending[0].pts;
    return this.pausedPts;
  }

  bufferedLead() {
    if (this.bufferedEndPts == null) return 0;
    const current = this.currentPts();
    if (current == null) return 0;
    return Math.max(0, this.bufferedEndPts - current);
  }

  pump() {
    if (!this.ctx || (!this.hostPlaying && !this.draining) || this.ctx.state !== "running") {
      return;
    }
    if (this.state === "playing") {
      this.schedulePending(this.nextStartTime ?? this.ctx.currentTime + START_DELAY);
      return;
    }
    if (this.state === "paused" && this.pausedPts != null && this.pending.length > 0) {
      this.startFrom(this.pausedPts);
      return;
    }
    if (this.pending.length === 0) return;
    if (this.draining || this.bufferedLead() >= this.bufferTarget) {
      this.startFrom(this.pending[0].pts);
    }
  }

  markEndOfTrack(endPts) {
    const end = Number(endPts);
    if (!this.ctx) {
      this.expectedEndPts = Number.isFinite(end) && end > 0 ? end : this.bufferedEndPts;
      return;
    }
    this.expectedEndPts = Number.isFinite(end) && end > 0 ? end : this.bufferedEndPts;
    this.draining = this.state !== "paused";
    this.hostPlaying = false;
    this.emitStatus(true);
    this.pump();
  }

  finishTrack() {
    if (!this.ctx) return;
    if (this.state === "ended") return;
    this.state = "ended";
    this.hostPlaying = false;
    this.draining = false;
    this.pausedPts = this.expectedEndPts ?? this.bufferedEndPts;
    this.timelineStartTime = null;
    this.timelineStartPts = null;
    this.nextStartTime = null;
    this.scheduled = [];
    this.emitStatus(true);
  }

  flush(position, playing = false) {
    this.reset({ silent: true });
    this.pausedPts = Number.isFinite(Number(position)) ? Number(position) : null;
    this.hostPlaying = Boolean(playing);
    if (this.hostPlaying) this.pump();
    this.emitStatus(true);
  }

  startFrom(startPts) {
    if (!this.ctx || this.pending.length === 0) return;
    const first = this.pending[0];
    const effectiveStart = Math.max(startPts, first.pts);
    if (first.pts + first.duration <= effectiveStart + 0.001) {
      this.pending.shift();
      this.zeroChunk(first);
      return this.startFrom(startPts);
    }
    this.timelineStartPts = effectiveStart;
    this.timelineStartTime = this.ctx.currentTime + START_DELAY;
    this.nextStartTime = this.timelineStartTime;
    this.pausedPts = null;
    this.state = "playing";
    this.masterGain.gain.cancelScheduledValues(this.ctx.currentTime);
    this.masterGain.gain.setTargetAtTime(
      this.testDucking ? 0 : this.volume,
      this.ctx.currentTime,
      0.02,
    );
    this.schedulePending(this.nextStartTime);
    this.emitStatus(true);
  }

  schedulePending(startTime) {
    if (!this.ctx) return;
    let nextTime = startTime ?? this.ctx.currentTime + START_DELAY;
    const chunks = this.pending;
    this.pending = [];
    for (const chunk of chunks) {
      if (chunk.pts + chunk.duration <= this.timelineStartPts + 0.001) {
        this.zeroChunk(chunk);
        continue;
      }
      let offset = 0;
      if (chunk.pts < this.timelineStartPts) {
        offset = this.timelineStartPts - chunk.pts;
      }
      const remaining = chunk.duration - offset;
      if (remaining <= 0.002) {
        this.zeroChunk(chunk);
        continue;
      }
      const expectedTime =
        this.timelineStartTime + (chunk.pts + offset - this.timelineStartPts);
      if (expectedTime > nextTime) nextTime = expectedTime;
      const source = this.ctx.createBufferSource();
      source.buffer = chunk.buffer;
      source.connect(this.masterGain);
      source.start(nextTime, offset);
      const record = {
        node: source,
        buffer: chunk.buffer,
        pts: chunk.pts + offset,
        duration: remaining,
        startTime: nextTime,
        endTime: nextTime + remaining,
      };
      this.scheduled.push(record);
      try {
        source.onended = () => {
          record.ended = true;
          record.buffer = null;
          record.node = null;
        };
      } catch {}
      nextTime += remaining;
    }
    this.nextStartTime = nextTime;
    if (this.scheduled.length > 500) {
      this.scheduled = this.scheduled.filter(
        (record) => record.endTime > this.ctx.currentTime - 0.5,
      );
    }
  }

  pause() {
    this.hostPlaying = false;
    if (!this.ctx || this.state !== "playing") {
      this.state = this.pending.length ? "paused" : "idle";
      this.emitStatus(true);
      return;
    }

    const pausePts = this.currentPts() ?? this.pending[0]?.pts ?? 0;
    this.fadeOutAndStop();
    const keep = [];
    for (const record of this.scheduled) {
      const endPts = record.pts + record.duration;
      if (endPts <= pausePts + 0.001) {
        this.zeroBuffer(record.buffer);
        continue;
      }
      keep.push({
        pts: record.pts,
        duration: record.duration,
        buffer: record.buffer,
        channels: this.channels,
        sampleRate: this.sampleRate,
      });
    }
    keep.push(...this.pending);
    keep.sort((a, b) => a.pts - b.pts);
    this.pending = keep;
    this.scheduled = [];
    this.nextStartTime = null;
    this.timelineStartTime = null;
    this.timelineStartPts = null;
    this.pausedPts = pausePts;
    this.state = "paused";
    this.emitStatus(true);
  }

  resumePlayback() {
    this.hostPlaying = true;
    if (!this.ctx) return;
    if (this.ctx.state === "suspended") {
      this.emitStatus(true);
      return;
    }
    if (this.state === "paused" && this.pausedPts != null) {
      this.pump();
    } else if (this.state !== "playing") {
      this.pump();
    }
  }

  fadeOutAndStop() {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const gain = this.masterGain.gain;
    gain.cancelScheduledValues(now);
    gain.setValueAtTime(gain.value, now);
    gain.linearRampToValueAtTime(0, now + FADE_SECONDS);
    for (const record of this.scheduled) {
      try {
        record.node?.stop(now + FADE_SECONDS + 0.005);
      } catch {}
    }
    const ctx = this.ctx;
    setTimeout(() => {
      if (!ctx || ctx.state === "closed") return;
      gain.cancelScheduledValues(ctx.currentTime);
      gain.setValueAtTime(this.testDucking ? 0 : this.volume, ctx.currentTime);
    }, 60);
  }

  handleUnderrun() {
    if (this.state !== "playing" || !this.ctx) return;
    this.underruns += 1;
    this.onUnderrun();
    const resumeAt = this.currentPts() ?? this.pausedPts;
    this.fadeOutAndStop();
    for (const record of this.scheduled) this.zeroBuffer(record.buffer);
    this.scheduled = [];
    this.nextStartTime = null;
    this.timelineStartTime = null;
    this.timelineStartPts = null;
    this.pausedPts = resumeAt ?? this.bufferedEndPts;
    this.state = "buffering";
    this.emitStatus(true);
  }

  monitor() {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    if (this.state === "playing" && this.nextStartTime != null) {
      if (now > this.nextStartTime + 0.12) {
        if (
          this.expectedEndPts != null &&
          this.pending.length === 0 &&
          now >= this.nextStartTime - 0.1
        ) {
          this.finishTrack();
        } else {
          this.handleUnderrun();
        }
      }
    } else if (
      this.state === "buffering" &&
      this.expectedEndPts != null &&
      this.pending.length === 0
    ) {
      this.finishTrack();
    }
    if (this.scheduled.length > 300) {
      this.scheduled = this.scheduled.filter((record) => record.endTime > now - 0.5);
    }
    this.onDiagnostics(this.diagnostics());
    this.emitStatus();
  }

  reset({ silent = false } = {}) {
    this.stopTest();
    if (!this.ctx) {
      this.pending = [];
      this.scheduled = [];
      return;
    }
    if (!silent) this.fadeOutAndStop();
    for (const chunk of this.pending) this.zeroChunk(chunk);
    for (const record of this.scheduled) {
      this.zeroBuffer(record.buffer);
      try {
        record.node?.stop();
      } catch {}
    }
    this.pending = [];
    this.scheduled = [];
    this.timelineStartTime = null;
    this.timelineStartPts = null;
    this.nextStartTime = null;
    this.pausedPts = null;
    this.bufferedEndPts = null;
    this.expectedEndPts = null;
    this.draining = false;
    this.lastSeq = null;
    this.hostPlaying = false;
    this.state = "idle";
    this.emitStatus(true);
  }

  stop() {
    this.reset();
    this.state = "stopped";
    this.emitStatus(true);
  }

  zeroChunk(chunk) {
    this.zeroBuffer(chunk?.buffer);
  }

  zeroBuffer(buffer) {
    if (!buffer) return;
    try {
      for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
        buffer.getChannelData(channel).fill(0);
      }
    } catch {}
  }

  playTest(testId, durationMs = 1800) {
    if (!this.ctx) return;
    this.stopTest({ silent: true });
    this.test = {
      id: testId,
      startedAt: performance.now(),
      maxEnergy: 0,
      detected: false,
    };
    this.testDucking = true;
    const now = this.ctx.currentTime;
    this.masterGain.gain.cancelScheduledValues(now);
    this.masterGain.gain.setValueAtTime(this.masterGain.gain.value, now);
    this.masterGain.gain.linearRampToValueAtTime(0, now + 0.12);

    const beepPattern = [
      { at: 0.14, duration: 0.3, frequency: 880 },
      { at: 0.54, duration: 0.2, frequency: 660 },
      { at: 0.84, duration: 0.32, frequency: 990 },
    ];
    const test = this.test;
    test.nodes = [];
    for (const beep of beepPattern) {
      const oscillator = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = beep.frequency;
      const start = now + beep.at;
      const end = start + beep.duration;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(1, start + 0.02);
      gain.gain.setValueAtTime(1, Math.max(start + 0.021, end - 0.04));
      gain.gain.linearRampToValueAtTime(0, end);
      oscillator.connect(gain);
      gain.connect(this.testGain);
      oscillator.start(start);
      oscillator.stop(end + 0.02);
      test.nodes.push(oscillator);
    }

    const detectMs = Math.max(1200, Math.min(5000, durationMs));
    this.testDetectTimer = setInterval(() => {
      if (!this.test || !this.analyser) return;
      if (performance.now() - this.test.startedAt < 300) return;
      this.analyser.getFloatTimeDomainData(this.monitorData);
      let sum = 0;
      for (let i = 0; i < this.monitorData.length; i += 1) {
        sum += this.monitorData[i] * this.monitorData[i];
      }
      const rms = Math.sqrt(sum / this.monitorData.length);
      this.test.maxEnergy = Math.max(this.test.maxEnergy, rms);
    }, 50);

    this.testRestoreTimer = setTimeout(() => {
      if (!this.test || this.test.id !== testId) return;
      const detected = this.test.maxEnergy > 0.006 && this.ctx?.state === "running";
      const energy = this.test.maxEnergy;
      this.onTestDetected({ testId, detected, energy });
      this.stopTest();
    }, detectMs + 120);
  }

  stopTest({ silent = false } = {}) {
    clearInterval(this.testDetectTimer);
    clearTimeout(this.testRestoreTimer);
    this.testDetectTimer = null;
    this.testRestoreTimer = null;
    if (this.test?.nodes) {
      for (const node of this.test.nodes) {
        try {
          node.stop();
        } catch {}
      }
    }
    this.test = null;
    if (!this.testDucking) return;
    this.testDucking = false;
    if (this.ctx && !silent) {
      const now = this.ctx.currentTime;
      this.masterGain.gain.cancelScheduledValues(now);
      this.masterGain.gain.setValueAtTime(this.masterGain.gain.value, now);
      this.masterGain.gain.linearRampToValueAtTime(this.volume, now + 0.18);
    }
  }

  diagnostics() {
    return {
      context: this.ctx?.state ?? "uninitialized",
      buffer: Math.round(this.bufferedLead() * 100) / 100,
      bufferTarget: this.bufferTarget,
      underruns: this.underruns,
      dropped: this.dropped,
      gaps: this.gaps,
      received: this.receivedChunks,
      bytes: this.receivedBytes,
      lastSeq: this.lastSeq,
      state: this.state,
      sampleRate: this.sampleRate,
      channels: this.channels,
      scheduled: this.scheduled.length,
      pending: this.pending.length,
      expectedEnd: this.expectedEndPts,
      draining: this.draining,
      hidden: document.visibilityState === "hidden",
    };
  }

  async destroy() {
    clearInterval(this.monitorTimer);
    this.monitorTimer = null;
    this.stopTest({ silent: true });
    this.reset({ silent: true });
    const ctx = this.ctx;
    this.ctx = null;
    this.masterGain = null;
    this.analyser = null;
    this.testGain = null;
    this.monitorData = null;
    this.pending = [];
    this.scheduled = [];
    if (ctx && ctx.state !== "closed") {
      try {
        await ctx.close();
      } catch {}
    }
  }
}
