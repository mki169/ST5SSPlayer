import test from "node:test";
import assert from "node:assert/strict";
import {
  AUDIO_HEADER_BYTES,
  encodeAudioFrame,
  formatTime,
  parseAudioFrame,
  pcm16ToFloat32Channels,
} from "../public/js/protocol.js";

test("audio frames round-trip through the binary codec", () => {
  const payload = Int16Array.from([-32768, 32767, 0, 16384, -16384, 1024, -1024, 512]);
  const encoded = encodeAudioFrame({
    channels: 2,
    sampleRate: 48000,
    frames: 4,
    pts: 12.5,
    seq: 42,
    streamId: 7,
    payload,
  });

  assert.equal(encoded.byteLength, AUDIO_HEADER_BYTES + payload.length * 2);
  const frame = parseAudioFrame(encoded);
  assert.ok(frame);
  assert.equal(frame.channels, 2);
  assert.equal(frame.sampleRate, 48000);
  assert.equal(frame.frames, 4);
  assert.equal(frame.pts, 12.5);
  assert.equal(frame.seq, 42);
  assert.equal(frame.streamId, 7);
  assert.equal(frame.duration, 4 / 48000);
  assert.deepEqual([...frame.payload], [...payload]);
});

test("audio frames parse from a misaligned byte offset", () => {
  const payload = Int16Array.from([-32768, 32767, 0, 16384]);
  const encoded = encodeAudioFrame({
    channels: 1,
    sampleRate: 48000,
    frames: 4,
    pts: 3,
    seq: 9,
    streamId: 2,
    payload,
  });
  const backing = new Uint8Array(encoded.byteLength + 1);
  backing.set(new Uint8Array(encoded), 1);
  const view = new Uint8Array(backing.buffer, 1, encoded.byteLength);

  assert.equal(view.byteOffset, 1);
  const frame = parseAudioFrame(view);
  assert.ok(frame);
  assert.equal(frame.pts, 3);
  assert.deepEqual([...frame.payload], [...payload]);
});

test("audio frames reject malformed headers and payload sizes", () => {
  const payload = Int16Array.from([1, 2, 3, 4]);
  const encoded = encodeAudioFrame({
    channels: 1,
    sampleRate: 44100,
    frames: 4,
    pts: 0,
    seq: 0,
    streamId: 1,
    payload,
  });
  const corrupt = encoded.slice(0);
  new Uint8Array(corrupt)[0] = 0;
  assert.equal(parseAudioFrame(corrupt), null);
  assert.equal(parseAudioFrame(new ArrayBuffer(8)), null);
  assert.throws(
    () =>
      encodeAudioFrame({
        channels: 2,
        sampleRate: 44100,
        frames: 4,
        pts: 0,
        payload,
      }),
    /payload size/,
  );
});

test("PCM conversion and time formatting handle normal values", () => {
  const payload = Int16Array.from([-32768, 0, 16384, 32767]);
  const channels = pcm16ToFloat32Channels(payload, 2, 2);
  assert.equal(channels.length, 2);
  assert.deepEqual([...channels[0]], [-1, 0.5]);
  assert.equal(channels[1][0], 0);
  assert.equal(channels[1][1], 32767 / 32768);
  assert.equal(formatTime(0), "0:00");
  assert.equal(formatTime(65), "1:05");
  assert.equal(formatTime(3661), "1:01:01");
  assert.equal(formatTime(Number.NaN), "0:00");
});
