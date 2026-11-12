import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { WebSocket } from "ws";
import { createLisServer } from "../server/app.js";
import { encodeAudioFrame, parseAudioFrame } from "../public/js/protocol.js";

class Client {
  constructor(ws) {
    this.ws = ws;
    this.queue = [];
    this.waiters = [];
    ws.on("message", (data, isBinary) => {
      let item;
      if (isBinary) {
        item = { binary: true, data };
      } else {
        item = JSON.parse(data.toString("utf8"));
        item.binary = false;
      }
      this.deliver(item);
    });
    ws.on("close", (code) => {
      for (const waiter of this.waiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error(`Socket closed (${code}) before message`));
      }
    });
  }

  static async connect(port, role, token) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await once(ws, "open");
    const client = new Client(ws);
    ws.send(JSON.stringify({ type: "auth", role, token }));
    client.welcome = await client.next((message) => message.type === "welcome");
    return client;
  }

  deliver(item) {
    const index = this.waiters.findIndex((waiter) => waiter.predicate(item));
    if (index >= 0) {
      const [waiter] = this.waiters.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(item);
      return;
    }
    this.queue.push(item);
  }

  next(predicate, timeout = 2500) {
    const index = this.queue.findIndex(predicate);
    if (index >= 0) {
      const [item] = this.queue.splice(index, 1);
      return Promise.resolve(item);
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new Error("Timed out waiting for message"));
        }, timeout),
      };
      this.waiters.push(waiter);
    });
  }

  send(message) {
    this.ws.send(JSON.stringify(message));
  }

  sendBinary(buffer) {
    this.ws.send(Buffer.from(buffer));
  }

  close() {
    this.ws.close();
  }
}

async function makeServer() {
  const logs = [];
  const lis = await createLisServer({
    host: "127.0.0.1",
    port: 0,
    hostToken: "host_test_token",
    listenerToken: "listener_test_token",
    tunnel: false,
    logger: {
      log: (line) => logs.push(String(line)),
      warn: (line) => logs.push(String(line)),
      error: (line) => logs.push(String(line)),
    },
  });
  const address = await lis.start(0);
  return { lis, port: address.port, logs };
}

test("server serves health and static pages", async (t) => {
  const { lis, port } = await makeServer();
  t.after(async () => {
    await lis.close();
  });

  const health = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(health.status, 200);
  const body = await health.json();
  assert.equal(body.ok, true);
  assert.equal(body.hostOnline, false);

  const listenPage = await fetch(`http://127.0.0.1:${port}/l`);
  assert.equal(listenPage.status, 200);
  assert.match(listenPage.headers.get("content-type"), /text\/html/);
  const html = await listenPage.text();
  assert.match(html, /Enable audio/);

  const missing = await fetch(`http://127.0.0.1:${port}/js/nope.js`);
  assert.equal(missing.status, 404);
});

test("server authenticates, streams, rotates invites, and ends tracks", async (t) => {
  const { lis, port } = await makeServer();
  t.after(async () => {
    await lis.close();
  });

  const host = await Client.connect(port, "host", "host_test_token");
  assert.equal(host.welcome.role, "host");

  const listener = await Client.connect(port, "listener", "listener_test_token");
  assert.equal(listener.welcome.hostOnline, true);
  const idleSync = await listener.next((message) => message.type === "stream-sync");
  assert.equal(idleSync.hasAudio, false);
  await listener.next(
    (message) => message.type === "error" && message.code === "host-offline",
    100,
  ).then(
    () => assert.fail("listener was incorrectly told the host was offline"),
    () => {},
  );

  host.send({
    type: "load",
    streamId: 41,
    sampleRate: 48000,
    channels: 1,
    duration: 10,
    title: "Test track",
  });
  const track = await listener.next((message) => message.type === "track");
  assert.equal(track.streamId, 41);
  assert.equal(track.duration, 10);

  const payload = new Int16Array(960).fill(1000);
  const frame = encodeAudioFrame({
    channels: 1,
    sampleRate: 48000,
    frames: 960,
    pts: 0,
    seq: 0,
    streamId: 41,
    payload,
  });
  host.sendBinary(frame);
  const received = await listener.next((message) => message.binary);
  const parsed = parseAudioFrame(received.data);
  assert.ok(parsed);
  assert.equal(parsed.streamId, 41);
  assert.equal(parsed.frames, 960);
  assert.equal(parsed.payload[0], 1000);

  host.send({ type: "play", position: 0 });
  const play = await listener.next((message) => message.type === "play");
  assert.equal(play.position, 0);

  host.send({ type: "end-of-track", endPts: 10 });
  const ended = await listener.next((message) => message.type === "end-of-track");
  assert.equal(ended.endPts, 10);
  assert.equal(ended.position, 10);

  const late = await Client.connect(port, "listener", "listener_test_token");
  assert.equal(late.welcome.hostOnline, true);
  const lateSync = await late.next((message) => message.type === "stream-sync");
  assert.equal(lateSync.sampleRate, 48000);
  assert.equal(lateSync.playing, false);
  assert.equal(lateSync.ended, true);

  late.send({ type: "resync" });
  const resync = await late.next((message) => message.type === "stream-sync");
  assert.equal(resync.streamId, 41);

  host.send({ type: "public-url", url: "https://example.com/some/path" });
  const tunnel = await host.next((message) => message.type === "tunnel");
  assert.equal(tunnel.publicUrl, "https://example.com");
  assert.match(tunnel.listenerUrl, /^https:\/\/example\.com\/l#/);

  host.send({ type: "rotate-listener" });
  const tokens = await host.next((message) => message.type === "tokens");
  assert.ok(tokens.listenerToken);
  assert.notEqual(tokens.listenerToken, "listener_test_token");
  assert.equal(tokens.listenerUrl, `https://example.com/l#${tokens.listenerToken}`);

  const oldLink = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await once(oldLink, "open");
  const oldClient = new Client(oldLink);
  oldLink.send(
    JSON.stringify({ type: "auth", role: "listener", token: "listener_test_token" }),
  );
  const error = await oldClient.next((message) => message.type === "error");
  assert.equal(error.code, "bad_token");
  oldLink.close();

  listener.close();
  late.close();
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(lis.session.listeners.size, 0);

  host.close();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(lis.session.host, null);
});
