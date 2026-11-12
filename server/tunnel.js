import { spawn } from "node:child_process";

const QUICK_TUNNEL_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

function now() {
  return Date.now();
}

export function startQuickTunnel({ port, onState = () => {}, onLog = () => {} }) {
  let child = null;
  let stopped = false;
  let healthTimer = null;
  let healthLoopToken = 0;
  let consecutiveFails = 0;
  let state = {
    status: "starting",
    url: null,
    lastUrl: null,
    error: null,
    latencyMs: null,
    checkedAt: null,
    startedAt: now(),
    updatedAt: now(),
  };

  const emit = (patch) => {
    state = { ...state, ...patch, updatedAt: now() };
    onState(state);
  };

  const scheduleHealthCheck = (delay, token) => {
    clearTimeout(healthTimer);
    healthTimer = setTimeout(() => runHealthCheck(token), delay);
  };

  const runHealthCheck = async (token) => {
    if (stopped || token !== healthLoopToken || !state.url) return;
    const started = performance.now();
    let ok = false;
    let error = null;
    try {
      const response = await fetch(`${state.url}/health`, {
        cache: "no-store",
        signal: AbortSignal.timeout(6000),
      });
      ok = response.ok;
      if (!ok) error = `Health endpoint returned ${response.status}`;
    } catch (err) {
      error = err?.name === "TimeoutError" ? "Health check timed out" : err?.message || String(err);
    }
    if (stopped || token !== healthLoopToken) return;

    const latencyMs = Math.round(performance.now() - started);
    if (ok) {
      consecutiveFails = 0;
      if (state.status !== "online") onLog("Tunnel is reachable from the public internet.");
      emit({
        status: "online",
        latencyMs,
        checkedAt: now(),
        error: null,
      });
      scheduleHealthCheck(20000, token);
    } else {
      consecutiveFails += 1;
      const elapsed = now() - state.startedAt;
      const nextStatus =
        state.status === "online" || state.status === "degraded"
          ? consecutiveFails >= 3
            ? "degraded"
            : state.status
          : elapsed > 35000
            ? "degraded"
            : "connecting";
      emit({
        status: nextStatus,
        latencyMs,
        checkedAt: now(),
        error:
          nextStatus === "degraded"
            ? `Public health check failed: ${error}`
            : null,
      });
      scheduleHealthCheck(nextStatus === "degraded" ? 15000 : 2000, token);
    }
  };

  let lineBuffer = "";
  const consumeLines = (chunk) => {
    lineBuffer += chunk.toString();
    const lines = lineBuffer.split(/\r?\n/);
    lineBuffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const match = trimmed.match(QUICK_TUNNEL_URL);
      if (match && !state.url) {
        const url = match[0];
        healthLoopToken += 1;
        emit({
          status: "connecting",
          url,
          lastUrl: url,
          startedAt: now(),
          error: null,
        });
        onLog(`Quick tunnel assigned: ${url}`);
        scheduleHealthCheck(1500, healthLoopToken);
        continue;
      }
      if (/error|fail|fatal|terminated|reconnect/i.test(trimmed)) {
        onLog(trimmed);
      }
    }
  };

  const start = () => {
    try {
      child = spawn(
        "cloudflared",
        ["tunnel", "--url", `http://127.0.0.1:${port}`, "--no-autoupdate"],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch (err) {
      emit({ status: "error", error: err.message });
      return;
    }

    child.stdout?.on("data", consumeLines);
    child.stderr?.on("data", consumeLines);

    child.on("error", (err) => {
      stopped = true;
      clearTimeout(healthTimer);
      if (err.code === "ENOENT") {
        emit({
          status: "error",
          url: null,
          error: "cloudflared is not installed or not on PATH.",
        });
        onLog(
          "cloudflared not found. Install it with: brew install cloudflared (or use --no-tunnel).",
        );
      } else {
        emit({ status: "error", url: null, error: err.message });
      }
    });

    child.on("exit", (code, signal) => {
      if (stopped) return;
      stopped = true;
      clearTimeout(healthTimer);
      emit({
        status: "offline",
        url: null,
        lastUrl: state.lastUrl || state.url,
        error: `cloudflared stopped${signal ? ` (${signal})` : ` with code ${code}`}`,
      });
      onLog(`Quick tunnel stopped${signal ? ` (${signal})` : ` with code ${code}`}.`);
    });
  };

  start();

  return {
    getState: () => state,
    stop: () => {
      stopped = true;
      clearTimeout(healthTimer);
      healthLoopToken += 1;
      if (child && !child.killed) child.kill("SIGTERM");
    },
    checkNow: () => {
      healthLoopToken += 1;
      runHealthCheck(healthLoopToken);
    },
  };
}

export function disabledTunnelState(reason = "Quick tunnel disabled.") {
  return {
    status: "disabled",
    url: null,
    lastUrl: null,
    error: reason,
    latencyMs: null,
    checkedAt: null,
    startedAt: now(),
    updatedAt: now(),
  };
}
