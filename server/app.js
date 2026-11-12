import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import {
  DEFAULT_BUFFER_TARGET,
  HISTORY_SECONDS,
  MAX_LISTENERS,
  PROTOCOL_VERSION,
  STREAM_LOOKAHEAD,
  clamp,
  isFiniteNumber,
  parseAudioFrame,
  sanitizeText,
} from "../public/js/protocol.js";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(MODULE_DIR, "..", "public");
const APP_VERSION = "1.0.0";
const MAX_JSON_BYTES = 32 * 1024;
const MAX_HISTORY_CHUNKS = 6000;
const MAX_HISTORY_BYTES = 64 * 1024 * 1024;

const MIME_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".ico", "image/x-icon"],
  [".webmanifest", "application/manifest+json"],
  [".json", "application/json; charset=utf-8"],
]);

const SECURITY_HEADERS = {
  "Cache-Control": "no-store, no-cache, max-age=0, must-revalidate",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "microphone=(), camera=(), geolocation=(), interest-cohort=()",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    "connect-src 'self' ws: wss:; img-src 'self' data:; media-src 'none'; " +
    "object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; worker-src 'self'",
};

function generateToken() {
  return crypto.randomBytes(24).toString("base64url");
}

function normalizePublicUrl(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

function tokenMatches(candidate, expected) {
  if (typeof candidate !== "string" || typeof expected !== "string") return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    crypto.timingSafeEqual(a, a);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

function parseJson(data) {
  try {
    if (data.length > MAX_JSON_BYTES) return null;
    return JSON.parse(data.toString("utf8"));
  } catch {
    return null;
  }
}

function intInRange(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max;
}

export async function createLisServer(options = {}) {
  const logger = options.logger ?? console;
  const host = options.host ?? "127.0.0.1";
  const requestedPort = options.port ?? 8787;
  const hostToken = options.hostToken ?? generateToken();
  const listenerToken = options.listenerToken ?? generateToken();
  const maxListeners = options.maxListeners ?? MAX_LISTENERS;
  const envPublicUrl = normalizePublicUrl(options.publicUrl);
  const hasTunnel = options.tunnel !== false;

  const session = {
    hostToken,
    listenerToken,
    publicUrl: envPublicUrl,
    publicUrlFromTunnel: false,
    tunnel: options.tunnelState ?? {
      status: hasTunnel ? "starting" : envPublicUrl ? "custom" : "disabled",
      url: envPublicUrl,
      lastUrl: null,
      error: null,
      latencyMs: null,
      checkedAt: null,
      startedAt: Date.now(),
      updatedAt: Date.now(),
    },
    host: null,
    hostClientId: null,
    listeners: new Map(),
    nextListenerNumber: 1,
    state: {
      online: false,
      playing: false,
      position: 0,
      duration: 0,
      sampleRate: 0,
      channels: 0,
      volume: 800,
      bufferTarget: DEFAULT_BUFFER_TARGET,
      streamId: 0,
      title: "",
      ended: false,
      updatedAt: 0,
    },
    history: [],
    historyStart: 0,
    historyEnd: 0,
    historyBytes: 0,
    test: null,
    testTimer: null,
    counters: {
      startedAt: Date.now(),
      audioFrames: 0,
      audioBytes: 0,
      relayBytes: 0,
      droppedAudio: 0,
      authFailures: 0,
      listenerConnections: 0,
    },
    rates: {
      audioBps: 0,
      relayBps: 0,
      sampledAt: Date.now(),
      audioBytes: 0,
      relayBytes: 0,
    },
    eventLoopLagMs: 0,
  };

  const getPublicUrl = () => session.publicUrl;
  const getListenerUrl = () => {
    const base = getPublicUrl();
    return base ? `${base}/l#${session.listenerToken}` : null;
  };

  const server = http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url || "/", "http://localhost");
    const pathname = requestUrl.pathname;

    if (pathname === "/health") {
      sendJson(res, 200, {
        ok: true,
        app: "st5ssplayer",
        version: APP_VERSION,
        uptimeSec: Math.floor((Date.now() - session.counters.startedAt) / 1000),
        hostOnline: session.state.online,
        listeners: session.listeners.size,
        serverTime: Date.now(),
      });
      return;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      sendText(res, 405, "Method not allowed", { Allow: "GET, HEAD" });
      return;
    }

    let filePath = null;
    if (pathname === "/" || pathname === "/index.html") {
      filePath = path.join(PUBLIC_DIR, "landing.html");
    } else if (pathname === "/h" || pathname === "/h/") {
      filePath = path.join(PUBLIC_DIR, "host.html");
    } else if (pathname === "/l" || pathname === "/l/") {
      filePath = path.join(PUBLIC_DIR, "listen.html");
    } else if (
      pathname.startsWith("/js/") ||
      pathname.startsWith("/css/") ||
      pathname.startsWith("/assets/")
    ) {
      try {
        const decoded = decodeURIComponent(pathname);
        const resolved = path.resolve(PUBLIC_DIR, `.${decoded}`);
        if (resolved.startsWith(`${PUBLIC_DIR}${path.sep}`)) filePath = resolved;
      } catch {
        filePath = null;
      }
    }

    if (!filePath) {
      sendText(res, 404, "Not found");
      return;
    }

    try {
      const body = await fs.readFile(filePath);
      const extension = path.extname(filePath).toLowerCase();
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        "Content-Type": MIME_TYPES.get(extension) ?? "application/octet-stream",
        "Content-Length": body.byteLength,
      });
      if (req.method === "HEAD") res.end();
      else res.end(body);
    } catch (err) {
      if (err?.code === "ENOENT") sendText(res, 404, "Not found");
      else {
        logger.error("Static file error:", err);
        sendText(res, 500, "Internal error");
      }
    }
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024 });

  server.on("upgrade", (req, socket, head) => {
    const requestUrl = new URL(req.url || "/", "http://localhost");
    if (requestUrl.pathname !== "/ws") {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  const send = (ws, payload) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  };

  const broadcastToListeners = (payload) => {
    const encoded = JSON.stringify(payload);
    for (const listener of session.listeners.values()) {
      if (listener.ws.readyState === WebSocket.OPEN) listener.ws.send(encoded);
    }
  };

  const broadcastAudio = (data) => {
    for (const listener of session.listeners.values()) {
      if (listener.ws.readyState !== WebSocket.OPEN) continue;
      if (listener.ws.bufferedAmount > 16 * 1024 * 1024) {
        listener.skippedChunks = (listener.skippedChunks ?? 0) + 1;
        continue;
      }
      listener.ws.send(data, { binary: true });
      session.counters.relayBytes += data.byteLength;
    }
  };

  const clearHistory = () => {
    for (const chunk of session.history) {
      chunk.data = null;
    }
    session.history = [];
    session.historyStart = 0;
    session.historyEnd = 0;
    session.historyBytes = 0;
  };

  const trimHistory = () => {
    while (session.history.length > 1) {
      const first = session.history[0];
      if (
        session.historyEnd - first.pts <= HISTORY_SECONDS &&
        session.history.length <= MAX_HISTORY_CHUNKS &&
        session.historyBytes <= MAX_HISTORY_BYTES
      ) {
        break;
      }
      session.history.shift();
      session.historyBytes -= first.bytes;
      first.data = null;
    }
    session.historyStart = session.history[0]?.pts ?? 0;
  };

  const listenerSummary = (listener) => {
    const diag = listener.diag ?? {};
    return {
      id: listener.id,
      label: listener.label,
      connectedAt: listener.connectedAt,
      lastDiagAt: listener.lastDiagAt || null,
      diagAgeMs: listener.lastDiagAt ? Date.now() - listener.lastDiagAt : null,
      rtt: isFiniteNumber(diag.rtt) ? diag.rtt : null,
      buffer: isFiniteNumber(diag.buffer) ? diag.buffer : null,
      bufferTarget: isFiniteNumber(diag.bufferTarget) ? diag.bufferTarget : null,
      underruns: isFiniteNumber(diag.underruns) ? diag.underruns : 0,
      dropped: isFiniteNumber(diag.dropped) ? diag.dropped : 0,
      context: typeof diag.context === "string" ? diag.context : "unknown",
      received: isFiniteNumber(diag.received) ? diag.received : 0,
      lastSeq: isFiniteNumber(diag.lastSeq) ? diag.lastSeq : null,
      hidden: Boolean(diag.hidden),
      skippedChunks: listener.skippedChunks ?? 0,
    };
  };

  const listenersPayload = () => ({
    type: "listeners",
    listeners: [...session.listeners.values()].map(listenerSummary),
    count: session.listeners.size,
  });

  const sendListeners = () => {
    if (session.host) send(session.host, listenersPayload());
  };

  const serverChecks = () => {
    const checks = [];
    const major = Number(process.versions.node.split(".")[0]);
    checks.push({
      id: "node",
      level: major >= 18 ? "ok" : "fail",
      label: "Node.js runtime",
      detail: `v${process.versions.node}`,
    });
    checks.push({
      id: "host",
      level: session.state.online ? "ok" : "warn",
      label: "Host connection",
      detail: session.state.online ? "Host is connected" : "Waiting for the host",
    });
    const tunnel = session.tunnel ?? {};
    let tunnelLevel = "info";
    if (tunnel.status === "online") tunnelLevel = "ok";
    else if (tunnel.status === "connecting" || tunnel.status === "starting") tunnelLevel = "warn";
    else if (tunnel.status === "degraded" || tunnel.status === "error" || tunnel.status === "offline")
      tunnelLevel = "fail";
    checks.push({
      id: "tunnel",
      level: tunnelLevel,
      label: "Quick tunnel",
      detail:
        tunnel.status === "online"
          ? `Reachable · ${tunnel.latencyMs ?? "?"} ms`
          : tunnel.error || `Status: ${tunnel.status ?? "unknown"}`,
    });
    if (session.listeners.size === 0) {
      checks.push({
        id: "listeners",
        level: "info",
        label: "Listeners",
        detail: "No listeners connected yet",
      });
    } else if ([...session.listeners.values()].some((l) => l.diag?.context === "suspended")) {
      checks.push({
        id: "listeners",
        level: "warn",
        label: "Listeners",
        detail: "One or more listeners need to tap to resume audio",
      });
    } else {
      checks.push({
        id: "listeners",
        level: "ok",
        label: "Listeners",
        detail: `${session.listeners.size} connected`,
      });
    }
    return checks;
  };

  const buildDiag = () => {
    const memory = process.memoryUsage();
    const now = Date.now();
    return {
      type: "diag",
      now,
      server: {
        app: APP_VERSION,
        node: process.version,
        uptimeSec: Math.floor((now - session.counters.startedAt) / 1000),
        memoryRss: memory.rss,
        memoryHeap: memory.heapUsed,
        eventLoopLagMs: Math.round(session.eventLoopLagMs * 10) / 10,
        listenerCount: session.listeners.size,
        hostOnline: session.state.online,
        audioFrames: session.counters.audioFrames,
        audioBytes: session.counters.audioBytes,
        relayBytes: session.counters.relayBytes,
        droppedAudio: session.counters.droppedAudio,
        authFailures: session.counters.authFailures,
        audioBps: session.rates.audioBps,
        relayBps: session.rates.relayBps,
        historySeconds:
          session.history.length > 0 ? Math.max(0, session.historyEnd - session.historyStart) : 0,
        historyBytes: session.historyBytes,
        historyChunks: session.history.length,
      },
      tunnel: session.tunnel,
      publicUrl: getPublicUrl(),
      listenerUrl: getListenerUrl(),
      state: {
        playing: session.state.playing,
        position: session.state.position,
        duration: session.state.duration,
        sampleRate: session.state.sampleRate,
        channels: session.state.channels,
        volume: session.state.volume,
        bufferTarget: session.state.bufferTarget,
        streamId: session.state.streamId,
        ended: session.state.ended,
      },
      listeners: [...session.listeners.values()].map(listenerSummary),
      test: session.test
        ? {
            id: session.test.id,
            startedAt: session.test.startedAt,
            durationMs: session.test.durationMs,
            results: [...session.test.results.values()],
          }
        : null,
      checks: serverChecks(),
    };
  };

  const sendDiag = () => {
    if (session.host) send(session.host, buildDiag());
  };

  const sendHistoryTo = (listener) => {
    const state = session.state;
    if (!state.sampleRate || state.channels < 1) {
      send(listener.ws, {
        type: "stream-sync",
        streamId: state.streamId,
        sampleRate: 0,
        channels: 0,
        duration: state.duration,
        playing: false,
        volume: state.volume,
        bufferTarget: state.bufferTarget,
        startPts: state.position,
        hasAudio: false,
        ended: state.ended,
      });
      return;
    }

    let startPts = state.position;
    if (!isFiniteNumber(startPts)) startPts = session.historyStart;
    if (session.history.length > 0) {
      startPts = clamp(
        startPts,
        session.historyStart,
        Math.max(session.historyStart, session.historyEnd - 0.15),
      );
    }

    send(listener.ws, {
      type: "stream-sync",
      streamId: state.streamId,
      sampleRate: state.sampleRate,
      channels: state.channels,
      duration: state.duration,
      playing: state.playing && session.history.length > 0,
      volume: state.volume,
      bufferTarget: state.bufferTarget,
      startPts,
      hasAudio: session.history.length > 0,
      ended: state.ended,
    });

    for (const chunk of session.history) {
      if (chunk.data && chunk.pts + chunk.duration > startPts - 0.05) {
        listener.ws.send(chunk.data, { binary: true });
      }
    }
  };

  const cancelTest = () => {
    if (session.testTimer) clearTimeout(session.testTimer);
    session.testTimer = null;
    session.test = null;
  };

  const finishTest = (testId) => {
    if (!session.test || session.test.id !== testId) return;
    broadcastToListeners({ type: "test-end", id: testId });
    if (session.host) {
      send(session.host, {
        type: "test-end",
        id: testId,
        results: [...session.test.results.values()],
      });
    }
    session.test = null;
    session.testTimer = null;
  };

  const startTest = (message) => {
    const durationMs = intInRange(message.durationMs, 500, 5000)
      ? message.durationMs
      : 1800;
    const id = sanitizeText(message.testId, 64) || crypto.randomBytes(8).toString("hex");
    cancelTest();
    session.test = {
      id,
      startedAt: Date.now(),
      durationMs,
      results: new Map(),
    };
    broadcastToListeners({ type: "test", id, durationMs, startedAt: session.test.startedAt });
    session.testTimer = setTimeout(() => finishTest(id), durationMs + 15000);
    return { id, durationMs };
  };

  const rotateListenerToken = () => {
    session.listenerToken = generateToken();
    return {
      listenerToken: session.listenerToken,
      listenerUrl: getListenerUrl(),
    };
  };

  const resetHostState = () => {
    Object.assign(session.state, {
      online: false,
      playing: false,
      position: 0,
      duration: 0,
      sampleRate: 0,
      channels: 0,
      streamId: 0,
      title: "",
      ended: false,
      updatedAt: Date.now(),
    });
    clearHistory();
    cancelTest();
  };

  const handleHostMessage = (ws, message) => {
    switch (message.type) {
      case "load": {
        if (
          !intInRange(message.sampleRate, 8000, 192000) ||
          !intInRange(message.channels, 1, 2) ||
          !isFiniteNumber(message.duration) ||
          message.duration <= 0 ||
          message.duration > 86400
        ) {
          send(ws, { type: "error", code: "bad_load", message: "Invalid audio stream metadata." });
          return;
        }
        const streamId = intInRange(message.streamId, 1, 0xffffffff)
          ? message.streamId
          : (session.state.streamId + 1) >>> 0;
        clearHistory();
        cancelTest();
        Object.assign(session.state, {
          online: true,
          playing: false,
          position: 0,
          duration: message.duration,
          sampleRate: message.sampleRate,
          channels: message.channels,
          streamId,
          title: sanitizeText(message.title, 240),
          ended: false,
          updatedAt: Date.now(),
        });
        broadcastToListeners({
          type: "track",
          streamId,
          sampleRate: message.sampleRate,
          channels: message.channels,
          duration: message.duration,
          volume: session.state.volume,
          bufferTarget: session.state.bufferTarget,
        });
        send(ws, {
          type: "loaded",
          streamId,
          sampleRate: message.sampleRate,
          channels: message.channels,
          duration: message.duration,
        });
        sendDiag();
        return;
      }
      case "play": {
        if (!session.state.sampleRate) return;
        session.state.playing = true;
        session.state.ended = false;
        session.state.position = clamp(
          isFiniteNumber(message.position) ? message.position : session.state.position,
          0,
          session.state.duration || 86400,
        );
        session.state.updatedAt = Date.now();
        broadcastToListeners({ type: "play", position: session.state.position });
        return;
      }
      case "pause": {
        session.state.playing = false;
        session.state.position = clamp(
          isFiniteNumber(message.position) ? message.position : session.state.position,
          0,
          session.state.duration || 86400,
        );
        session.state.updatedAt = Date.now();
        broadcastToListeners({ type: "pause", position: session.state.position });
        return;
      }
      case "end-of-track": {
        if (!session.state.sampleRate) return;
        const endPts = clamp(
          isFiniteNumber(message.endPts) ? message.endPts : session.state.duration,
          0,
          session.state.duration || 86400,
        );
        session.state.playing = false;
        session.state.ended = true;
        session.state.position = endPts;
        session.state.updatedAt = Date.now();
        broadcastToListeners({ type: "end-of-track", endPts, position: endPts });
        sendDiag();
        return;
      }
      case "seek": {
        const position = clamp(
          isFiniteNumber(message.position) ? message.position : 0,
          0,
          session.state.duration || 86400,
        );
        clearHistory();
        session.state.position = position;
        session.state.playing = Boolean(message.playing);
        session.state.ended = false;
        session.state.updatedAt = Date.now();
        broadcastToListeners({
          type: "flush",
          position,
          playing: session.state.playing,
        });
        return;
      }
      case "stop": {
        session.state.playing = false;
        session.state.position = 0;
        session.state.ended = false;
        session.state.updatedAt = Date.now();
        clearHistory();
        broadcastToListeners({ type: "stop" });
        return;
      }
      case "volume": {
        session.state.volume = clamp(Math.round(Number(message.value) || 0), 0, 1000);
        broadcastToListeners({ type: "volume", value: session.state.volume });
        return;
      }
      case "position": {
        session.state.position = clamp(
          isFiniteNumber(message.position) ? message.position : session.state.position,
          0,
          session.state.duration || 86400,
        );
        session.state.updatedAt = Date.now();
        return;
      }
      case "test": {
        const test = startTest(message);
        send(ws, { type: "test-started", ...test });
        sendDiag();
        return;
      }
      case "rotate-listener": {
        const tokens = rotateListenerToken();
        send(ws, { type: "tokens", ...tokens, publicUrl: getPublicUrl() });
        sendDiag();
        logger.log("Listener invite rotated. Existing listeners stay connected.");
        return;
      }
      case "public-url": {
        const publicUrl = normalizePublicUrl(message.url);
        if (!publicUrl) {
          send(ws, {
            type: "error",
            code: "bad_public_url",
            message: "Enter a valid http or https URL.",
          });
          return;
        }
        session.publicUrl = publicUrl;
        session.publicUrlFromTunnel = false;
        session.tunnel = {
          ...session.tunnel,
          status: "custom",
          url: publicUrl,
          error: null,
          updatedAt: Date.now(),
        };
        send(ws, {
          type: "tunnel",
          tunnel: session.tunnel,
          publicUrl,
          listenerUrl: getListenerUrl(),
        });
        sendDiag();
        return;
      }
      case "diag-request": {
        sendDiag();
        return;
      }
      case "ping": {
        send(ws, { type: "pong", t: message.t, serverTime: Date.now() });
        return;
      }
      default:
        return;
    }
  };

  const handleListenerMessage = (ws, message, listener) => {
    switch (message.type) {
      case "resync": {
        const now = Date.now();
        if (now - listener.lastResyncAt < 1200) return;
        listener.lastResyncAt = now;
        if (session.state.online) sendHistoryTo(listener);
        else send(ws, { type: "host-offline" });
        return;
      }
      case "diag": {
        listener.diag = {
          rtt: clamp(Number(message.rtt) || 0, 0, 120000),
          buffer: clamp(Number(message.buffer) || 0, 0, 120),
          bufferTarget: clamp(Number(message.bufferTarget) || 0, 0, 60),
          underruns: clamp(Math.round(Number(message.underruns) || 0), 0, 1e9),
          dropped: clamp(Math.round(Number(message.dropped) || 0), 0, 1e9),
          context: sanitizeText(message.context, 32),
          received: clamp(Math.round(Number(message.received) || 0), 0, 1e12),
          lastSeq: clamp(Math.round(Number(message.lastSeq) || 0), 0, 0xffffffff),
          hidden: Boolean(message.hidden),
          detail: sanitizeText(message.detail, 160),
        };
        listener.lastDiagAt = Date.now();
        return;
      }
      case "test-result": {
        if (!session.test || session.test.id !== message.testId) return;
        const result = {
          listenerId: listener.id,
          label: listener.label,
          heard: message.heard === true ? true : message.heard === false ? false : null,
          detected: Boolean(message.detected),
          at: Date.now(),
        };
        session.test.results.set(listener.id, result);
        if (session.host) send(session.host, { type: "test-result", testId: message.testId, ...result });
        return;
      }
      case "ping": {
        send(ws, { type: "pong", t: message.t, serverTime: Date.now() });
        return;
      }
      default:
        return;
    }
  };

  const handleAudio = (ws, data) => {
    if (ws !== session.host || session.state.ended) return;
    const frame = parseAudioFrame(data);
    if (!frame) {
      session.counters.droppedAudio += 1;
      return;
    }
    if (
      frame.streamId !== session.state.streamId ||
      frame.sampleRate !== session.state.sampleRate ||
      frame.channels !== session.state.channels
    ) {
      session.counters.droppedAudio += 1;
      return;
    }
    const chunk = {
      pts: frame.pts,
      duration: frame.duration,
      seq: frame.seq,
      data: Buffer.from(data),
      bytes: data.byteLength,
    };
    session.history.push(chunk);
    session.historyBytes += chunk.bytes;
    session.historyEnd = frame.pts + frame.duration;
    if (!session.historyStart) session.historyStart = frame.pts;
    trimHistory();
    session.counters.audioFrames += 1;
    session.counters.audioBytes += frame.payload.byteLength;
    session.state.position = Math.max(session.state.position, frame.pts - STREAM_LOOKAHEAD);
    session.state.updatedAt = Date.now();
    broadcastAudio(data);
  };

  const authConnection = (ws, message) => {
    const role = message.role;
    if (role !== "host" && role !== "listener") {
      session.counters.authFailures += 1;
      send(ws, { type: "error", code: "bad_role", message: "Unknown role." });
      ws.close(4003, "Bad role");
      return;
    }
    const expected = role === "host" ? session.hostToken : session.listenerToken;
    if (!tokenMatches(message.token, expected)) {
      session.counters.authFailures += 1;
      send(ws, { type: "error", code: "bad_token", message: "Invalid or expired invite link." });
      setTimeout(() => ws.close(4003, "Invalid token"), 120);
      return;
    }

    ws.authed = true;
    ws.role = role;
    clearTimeout(ws.authTimer);

    if (role === "host") {
      if (session.host && session.host !== ws) {
        send(session.host, {
          type: "error",
          code: "replaced",
          message: "This host session was opened in another tab.",
        });
        session.host.close(4001, "Host replaced");
        session.host = null;
      }
      resetHostState();
      session.host = ws;
      session.hostClientId = ws.clientId;
      session.state.online = true;
      session.state.updatedAt = Date.now();
      send(ws, {
        type: "welcome",
        role: "host",
        clientId: ws.clientId,
        protocol: PROTOCOL_VERSION,
        serverTime: Date.now(),
        session: {
          listenerToken: session.listenerToken,
          listenerUrl: getListenerUrl(),
          publicUrl: getPublicUrl(),
          bufferTarget: DEFAULT_BUFFER_TARGET,
          lookahead: STREAM_LOOKAHEAD,
          maxListeners,
          listenerCount: session.listeners.size,
          startedAt: session.counters.startedAt,
          appVersion: APP_VERSION,
        },
        tunnel: session.tunnel,
        checks: serverChecks(),
        listeners: [...session.listeners.values()].map(listenerSummary),
      });
      broadcastToListeners({ type: "host-online", serverTime: Date.now() });
      for (const listener of session.listeners.values()) {
        if (listener.ws.readyState === WebSocket.OPEN) sendHistoryTo(listener);
      }
      sendListeners();
      sendDiag();
      logger.log(`Host connected (${ws.clientId}).`);
      return;
    }

    if (session.listeners.size >= maxListeners) {
      send(ws, { type: "error", code: "room_full", message: "The listening room is full." });
      ws.close(4029, "Room full");
      return;
    }

    const number = session.nextListenerNumber;
    session.nextListenerNumber += 1;
    const listener = {
      id: `L${number}`,
      label: `Listener ${number}`,
      ws,
      connectedAt: Date.now(),
      diag: null,
      lastDiagAt: 0,
      lastResyncAt: 0,
      skippedChunks: 0,
    };
    session.listeners.set(listener.id, listener);
    session.counters.listenerConnections += 1;

    send(ws, {
      type: "welcome",
      role: "listener",
      clientId: ws.clientId,
      label: listener.label,
      protocol: PROTOCOL_VERSION,
      serverTime: Date.now(),
      hostOnline: session.state.online,
      bufferTarget: session.state.bufferTarget,
      state: {
        playing: session.state.playing,
        sampleRate: session.state.sampleRate,
        channels: session.state.channels,
        duration: session.state.duration,
        streamId: session.state.streamId,
        volume: session.state.volume,
        ended: session.state.ended,
      },
      test: session.test
        ? {
            id: session.test.id,
            durationMs: session.test.durationMs,
            startedAt: session.test.startedAt,
          }
        : null,
    });

    if (session.state.online) {
      sendHistoryTo(listener);
    } else {
      send(ws, { type: "host-offline" });
    }
    if (
      session.test &&
      Date.now() - session.test.startedAt < session.test.durationMs + 4000
    ) {
      send(ws, {
        type: "test",
        id: session.test.id,
        durationMs: session.test.durationMs,
        startedAt: session.test.startedAt,
      });
    }
    sendListeners();
    sendDiag();
    logger.log(`${listener.label} connected.`);
  };

  wss.on("connection", (ws) => {
    ws.clientId = `c_${crypto.randomBytes(5).toString("hex")}`;
    ws.isAlive = true;
    ws.authed = false;
    ws.role = null;
    ws.authTimer = setTimeout(() => {
      if (!ws.authed) {
        send(ws, { type: "error", code: "auth_timeout", message: "Authentication timed out." });
        ws.close(4008, "Auth timeout");
      }
    }, 8000);

    ws.on("pong", () => {
      ws.isAlive = true;
    });

    ws.on("message", (data, isBinary) => {
      if (!ws.authed) {
        if (isBinary) {
          ws.close(4003, "Authenticate first");
          return;
        }
        const message = parseJson(data);
        if (!message || message.type !== "auth") {
          send(ws, { type: "error", code: "auth_required", message: "Authenticate first." });
          ws.close(4003, "Auth required");
          return;
        }
        authConnection(ws, message);
        return;
      }

      if (isBinary) {
        if (ws.role === "host") handleAudio(ws, data);
        return;
      }

      const message = parseJson(data);
      if (!message || typeof message.type !== "string") return;

      if (ws.role === "host") {
        if (ws !== session.host) return;
        handleHostMessage(ws, message);
        return;
      }

      if (ws.role === "listener") {
        const listener = [...session.listeners.values()].find((item) => item.ws === ws);
        if (listener) handleListenerMessage(ws, message, listener);
      }
    });

    ws.on("close", () => {
      clearTimeout(ws.authTimer);
      if (ws === session.host) {
        session.host = null;
        session.hostClientId = null;
        resetHostState();
        broadcastToListeners({ type: "host-offline" });
        sendListeners();
        logger.log("Host disconnected.");
        return;
      }
      for (const [id, listener] of session.listeners.entries()) {
        if (listener.ws === ws) {
          session.listeners.delete(id);
          logger.log(`${listener.label} disconnected.`);
          break;
        }
      }
      sendListeners();
      sendDiag();
    });

    ws.on("error", (err) => {
      logger.warn(`WebSocket error (${ws.clientId}): ${err.message}`);
    });
  });

  const heartbeatTimer = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch {
        ws.terminate();
      }
    }
  }, 20000);
  heartbeatTimer.unref?.();

  let lastLoopTick = performance.now();
  const lagTimer = setInterval(() => {
    const current = performance.now();
    const lag = current - lastLoopTick - 500;
    session.eventLoopLagMs = Math.max(0, lag);
    lastLoopTick = current;
  }, 500);
  lagTimer.unref?.();

  const diagTimer = setInterval(() => {
    const now = Date.now();
    const elapsed = Math.max(0.001, (now - session.rates.sampledAt) / 1000);
    const audioDelta = session.counters.audioBytes - session.rates.audioBytes;
    const relayDelta = session.counters.relayBytes - session.rates.relayBytes;
    session.rates.audioBps = Math.round(audioDelta / elapsed);
    session.rates.relayBps = Math.round(relayDelta / elapsed);
    session.rates.audioBytes = session.counters.audioBytes;
    session.rates.relayBytes = session.counters.relayBytes;
    session.rates.sampledAt = now;
    sendDiag();
  }, 2000);
  diagTimer.unref?.();

  const start = async (port = requestedPort) => {
    await new Promise((resolve, reject) => {
      const onError = (err) => {
        server.off("listening", onListening);
        reject(err);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, host);
    });
    const address = server.address();
    return {
      port: typeof address === "object" && address ? address.port : port,
      host,
    };
  };

  const close = async () => {
    clearInterval(heartbeatTimer);
    clearInterval(lagTimer);
    clearInterval(diagTimer);
    cancelTest();
    for (const ws of wss.clients) {
      try {
        ws.close(1001, "Server shutting down");
      } catch {
        ws.terminate();
      }
    }
    clearHistory();
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => server.close(resolve));
  };

  const updateTunnel = (tunnelState) => {
    if (!tunnelState) return;
    session.tunnel = tunnelState;
    if (tunnelState.url) {
      session.publicUrl = normalizePublicUrl(tunnelState.url) ?? session.publicUrl;
      if (!envPublicUrl) session.publicUrlFromTunnel = true;
    } else if (session.publicUrlFromTunnel) {
      session.publicUrl = null;
      session.publicUrlFromTunnel = false;
    }
    if (session.host) {
      send(session.host, {
        type: "tunnel",
        tunnel: session.tunnel,
        publicUrl: getPublicUrl(),
        listenerUrl: getListenerUrl(),
      });
    }
  };

  return {
    server,
    wss,
    session,
    start,
    close,
    updateTunnel,
    getPublicUrl,
    getListenerUrl,
    getTokens: () => ({
      hostToken: session.hostToken,
      listenerToken: session.listenerToken,
    }),
    getDiag: buildDiag,
  };
}

function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.byteLength,
  });
  res.end(body);
}

function sendText(res, status, text, extraHeaders = {}) {
  const body = Buffer.from(text);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": body.byteLength,
    ...extraHeaders,
  });
  res.end(body);
}
