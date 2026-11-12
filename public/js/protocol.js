export const PROTOCOL_VERSION = 1;
export const AUDIO_MAGIC = 0x4c495341;
export const AUDIO_HEADER_BYTES = 32;
export const MAX_CHANNELS = 2;
export const MAX_AUDIO_FRAMES = 96000;
export const DEFAULT_BUFFER_TARGET = 8;
export const STREAM_LOOKAHEAD = 9.5;
export const HISTORY_SECONDS = 13;
export const MAX_LISTENERS = 40;

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

export function readNumber(value, fallback = 0) {
  return isFiniteNumber(value) ? value : fallback;
}

export function formatTime(seconds) {
  if (!isFiniteNumber(seconds) || seconds < 0) seconds = 0;
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function formatBytes(bytes) {
  if (!isFiniteNumber(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** index;
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

export function streamRateLabel(sampleRate, channels) {
  if (!sampleRate || !channels) return "-";
  const kbps = (sampleRate * channels * 16) / 1000;
  return `${(sampleRate / 1000).toFixed(sampleRate % 1000 === 0 ? 0 : 1)} kHz ${channels === 1 ? "mono" : "stereo"} · ${Math.round(kbps)} kbps`;
}

export function encodeAudioFrame({
  channels,
  sampleRate,
  frames,
  pts,
  seq = 0,
  streamId = 0,
  payload,
}) {
  if (!payload || payload.length !== frames * channels) {
    throw new Error("Audio payload size does not match frame metadata");
  }
  const buffer = new ArrayBuffer(AUDIO_HEADER_BYTES + payload.length * 2);
  const view = new DataView(buffer);
  view.setUint32(0, AUDIO_MAGIC, true);
  view.setUint8(4, PROTOCOL_VERSION);
  view.setUint8(5, channels);
  view.setUint16(6, AUDIO_HEADER_BYTES, true);
  view.setUint32(8, sampleRate, true);
  view.setUint32(12, frames, true);
  view.setFloat64(16, pts, true);
  view.setUint32(24, seq >>> 0, true);
  view.setUint32(28, streamId >>> 0, true);
  const bytes = new Uint8Array(buffer, AUDIO_HEADER_BYTES);
  const source = new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
  bytes.set(source);
  return buffer;
}

export function parseAudioFrame(data) {
  let view;
  let bytes;
  if (data instanceof ArrayBuffer) {
    if (data.byteLength < AUDIO_HEADER_BYTES) return null;
    view = new DataView(data);
    bytes = new Uint8Array(data);
  } else if (ArrayBuffer.isView(data)) {
    if (data.byteLength < AUDIO_HEADER_BYTES) return null;
    view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  } else {
    return null;
  }

  if (view.getUint32(0, true) !== AUDIO_MAGIC) return null;
  if (view.getUint8(4) !== PROTOCOL_VERSION) return null;
  const channels = view.getUint8(5);
  const headerBytes = view.getUint16(6, true);
  const sampleRate = view.getUint32(8, true);
  const frames = view.getUint32(12, true);
  const pts = view.getFloat64(16, true);
  const seq = view.getUint32(24, true);
  const streamId = view.getUint32(28, true);

  if (headerBytes !== AUDIO_HEADER_BYTES) return null;
  if (channels < 1 || channels > MAX_CHANNELS) return null;
  if (sampleRate < 8000 || sampleRate > 192000) return null;
  if (frames < 1 || frames > MAX_AUDIO_FRAMES) return null;
  if (!Number.isFinite(pts) || pts < 0) return null;
  const expectedBytes = AUDIO_HEADER_BYTES + frames * channels * 2;
  if (view.byteLength !== expectedBytes) return null;

  let payload;
  if (data instanceof ArrayBuffer) {
    payload = new Int16Array(data, AUDIO_HEADER_BYTES, frames * channels);
  } else {
    const payloadOffset = data.byteOffset + AUDIO_HEADER_BYTES;
    if (payloadOffset % 2 === 0) {
      payload = new Int16Array(data.buffer, payloadOffset, frames * channels);
    } else {
      const payloadBytes = frames * channels * 2;
      const copy = new Uint8Array(payloadBytes);
      copy.set(new Uint8Array(data.buffer, payloadOffset, payloadBytes));
      payload = new Int16Array(copy.buffer);
    }
  }

  return {
    channels,
    sampleRate,
    frames,
    pts,
    seq,
    streamId,
    duration: frames / sampleRate,
    payload,
    raw: bytes,
  };
}

export function pcm16ToFloat32Channels(payload, channels, frames) {
  const result = new Array(channels);
  const scale = 1 / 32768;
  for (let channel = 0; channel < channels; channel += 1) {
    result[channel] = new Float32Array(frames);
  }
  let cursor = 0;
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      result[channel][frame] = payload[cursor] * scale;
      cursor += 1;
    }
  }
  return result;
}

export function randomToken(byteLength = 24) {
  const bytes = new Uint8Array(byteLength);
  globalThis.crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function makeId(prefix = "id") {
  return `${prefix}_${randomToken(9)}`;
}

export function sanitizeText(value, maxLength = 200) {
  return typeof value === "string" ? value.slice(0, maxLength) : "";
}
