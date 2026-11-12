export class LisSocket {
  constructor({ role, token, onMessage, onStatus, onFatal }) {
    this.role = role;
    this.token = token;
    this.onMessage = onMessage ?? (() => {});
    this.onStatus = onStatus ?? (() => {});
    this.onFatal = onFatal ?? (() => {});
    this.ws = null;
    this.manualClose = false;
    this.fatal = false;
    this.authenticated = false;
    this.rttMs = null;
    this.serverClockOffsetMs = null;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.status = "idle";
    this.lastMessageAt = 0;
  }

  get connected() {
    return this.ws?.readyState === WebSocket.OPEN && this.authenticated;
  }

  setStatus(status, extra = {}) {
    this.status = status;
    this.onStatus({ status, rtt: this.rttMs, ...extra });
  }

  connect() {
    this.manualClose = false;
    this.fatal = false;
    this.reconnectAttempts = 0;
    this.open();
  }

  open() {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.authenticated = false;
    clearInterval(this.pingTimer);
    this.pingTimer = null;

    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${protocol}//${location.host}/ws`;
    this.setStatus(this.reconnectAttempts > 0 ? "reconnecting" : "connecting");

    let ws;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.binaryType = "arraybuffer";

    const authTimeout = setTimeout(() => {
      if (!this.authenticated) {
        try {
          ws.close(4000, "Auth timeout");
        } catch {}
      }
    }, 8000);

    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ type: "auth", role: this.role, token: this.token }));
    });

    ws.addEventListener("message", (event) => {
      this.lastMessageAt = performance.now();
      if (typeof event.data === "string") {
        let message;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }
        if (message.type === "pong") {
          if (typeof message.t === "number") {
            this.rttMs = Math.max(0, performance.now() - message.t);
          }
          if (typeof message.serverTime === "number") {
            this.serverClockOffsetMs = message.serverTime - Date.now();
          }
          this.onMessage(message);
          return;
        }
        if (message.type === "welcome") {
          clearTimeout(authTimeout);
          this.authenticated = true;
          this.reconnectAttempts = 0;
          this.setStatus("connected");
          this.startPing();
        }
        if (message.type === "error") {
          if (
            message.code === "bad_token" ||
            message.code === "room_full" ||
            message.code === "replaced" ||
            message.code === "bad_role"
          ) {
            this.fatal = true;
            this.manualClose = true;
          }
        }
        this.onMessage(message);
        return;
      }
      this.onMessage(event.data);
    });

    ws.addEventListener("close", (event) => {
      clearTimeout(authTimeout);
      clearInterval(this.pingTimer);
      this.pingTimer = null;
      this.authenticated = false;
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.manualClose || this.fatal) {
        this.setStatus(this.fatal ? "fatal" : "closed", { code: event.code });
        if (this.fatal) this.onFatal(event);
        return;
      }
      this.setStatus("disconnected", { code: event.code });
      this.scheduleReconnect();
    });

    ws.addEventListener("error", () => {
      // The close event owns reconnect/error handling.
    });
  }

  startPing() {
    clearInterval(this.pingTimer);
    const ping = () => {
      this.send({ type: "ping", t: performance.now() });
    };
    ping();
    this.pingTimer = setInterval(ping, 5000);
  }

  scheduleReconnect() {
    if (this.manualClose || this.fatal) return;
    this.reconnectAttempts += 1;
    const base = Math.min(8000, 600 * 2 ** Math.min(this.reconnectAttempts, 4));
    const delay = base + Math.random() * 350;
    this.setStatus("reconnecting", { retryInMs: delay });
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.open(), delay);
  }

  send(message) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
      return true;
    }
    return false;
  }

  sendBinary(buffer) {
    if (this.ws?.readyState === WebSocket.OPEN && this.authenticated) {
      this.ws.send(buffer);
      return true;
    }
    return false;
  }

  close() {
    this.manualClose = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.pingTimer);
    this.pingTimer = null;
    try {
      this.ws?.close(1000, "Client closed");
    } catch {}
    this.ws = null;
    this.authenticated = false;
  }
}
