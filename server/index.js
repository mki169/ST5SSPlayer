import { execFile } from "node:child_process";
import { createLisServer } from "./app.js";
import { startQuickTunnel } from "./tunnel.js";

const PORT = Number.parseInt(process.env.PORT || "8787", 10);
const HOST = process.env.HOST || "127.0.0.1";
const NO_TUNNEL = process.env.NO_TUNNEL === "1" || process.env.NO_TUNNEL === "true";
const PUBLIC_URL = process.env.PUBLIC_URL || null;
const NO_OPEN = process.env.NO_OPEN === "1";

const colors = process.stdout.isTTY
  ? {
      reset: "\x1b[0m",
      dim: "\x1b[2m",
      bold: "\x1b[1m",
      green: "\x1b[32m",
      yellow: "\x1b[33m",
      cyan: "\x1b[36m",
      red: "\x1b[31m",
    }
  : Object.fromEntries(
      ["reset", "dim", "bold", "green", "yellow", "cyan", "red"].map((key) => [key, ""]),
    );

const paint = (color, text) => `${colors[color]}${text}${colors.reset}`;

function openBrowser(url) {
  if (NO_OPEN || !process.stdout.isTTY) return;
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  execFile(command, args, () => {});
}

function printLinks({ localHostUrl, localListenerUrl, publicListenerUrl, publicUrl }) {
  console.log("");
  console.log(paint("bold", "  ST5SSPlayer · listening room"));
  console.log("");
  console.log(`  ${paint("dim", "Host (private)")}   ${paint("cyan", localHostUrl)}`);
  if (publicUrl) {
    console.log(
      `  ${paint("dim", "Listener")}         ${paint("green", publicListenerUrl || `${publicUrl}/l`)}`,
    );
  } else {
    console.log(`  ${paint("dim", "Listener (local)")} ${paint("green", localListenerUrl)}`);
    console.log(
      `  ${paint("yellow", "Tunnel is not ready yet. The public listener link will appear here.")}`,
    );
  }
  console.log("");
  console.log(paint("dim", "  Never share the host link. The listener link is the invite."));
  console.log("");
}

async function main() {
  let lis;
  try {
    lis = await createLisServer({
      port: PORT,
      host: HOST,
      publicUrl: PUBLIC_URL,
      tunnel: !NO_TUNNEL && !PUBLIC_URL,
    });
  } catch (err) {
    console.error(paint("red", `Failed to create server: ${err.message}`));
    process.exitCode = 1;
    return;
  }

  let address;
  try {
    address = await lis.start(PORT);
  } catch (err) {
    if (err?.code === "EADDRINUSE") {
      console.error(
        paint("red", `Port ${PORT} is already in use. Try: PORT=8788 npm start`),
      );
    } else {
      console.error(paint("red", `Failed to start server: ${err.message}`));
    }
    process.exitCode = 1;
    return;
  }

  const { hostToken, listenerToken } = lis.getTokens();
  const localOrigin = `http://localhost:${address.port}`;
  const localHostUrl = `${localOrigin}/h#${hostToken}`;
  const localListenerUrl = `${localOrigin}/l#${listenerToken}`;

  console.log("");
  console.log(paint("green", "  Starting ST5SSPlayer..."));
  console.log(paint("dim", `  Local server: ${localOrigin}`));
  console.log(paint("dim", `  Node ${process.version} · audio is streamed in memory only`));

  let publicUrl = PUBLIC_URL;
  let publicListenerUrl = publicUrl ? `${publicUrl}/l#${listenerToken}` : null;
  let tunnel = null;
  let lastTunnelStatus = null;

  const refreshLinks = () => {
    if (!publicUrl) return;
    publicListenerUrl = `${publicUrl}/l#${lis.getTokens().listenerToken}`;
  };

  if (NO_TUNNEL || PUBLIC_URL) {
    lis.updateTunnel({
      status: PUBLIC_URL ? "custom" : "disabled",
      url: PUBLIC_URL,
      lastUrl: null,
      error: PUBLIC_URL ? null : "Quick tunnel disabled (NO_TUNNEL=1).",
      latencyMs: null,
      checkedAt: null,
      startedAt: Date.now(),
      updatedAt: Date.now(),
    });
  } else {
    tunnel = startQuickTunnel({
      port: address.port,
      onState: (state) => {
        const previousUrl = publicUrl;
        publicUrl = state.url;
        if (publicUrl && publicUrl !== previousUrl) {
          refreshLinks();
          printLinks({
            localHostUrl,
            localListenerUrl,
            publicListenerUrl,
            publicUrl,
          });
        }
        if (state.status !== lastTunnelStatus) {
          lastTunnelStatus = state.status;
          if (state.status === "online") {
            console.log(
              paint("green", `  Tunnel online · ${state.latencyMs ?? "?"} ms public health check`),
            );
          } else if (state.status === "connecting") {
            console.log(paint("yellow", "  Tunnel assigned; waiting for public health check..."));
          } else if (state.status === "degraded") {
            console.log(paint("yellow", `  Tunnel warning: ${state.error || "degraded"}`));
          } else if (state.status === "offline" || state.status === "error") {
            console.log(paint("red", `  Tunnel ${state.status}: ${state.error || "unknown"}`));
          }
        }
        lis.updateTunnel(state);
      },
      onLog: (line) => {
        if (line.startsWith("Quick tunnel assigned")) console.log(paint("dim", `  ${line}`));
        else console.error(paint("dim", `  [cloudflared] ${line}`));
      },
    });
    lis.updateTunnel(tunnel.getState());
    lastTunnelStatus = tunnel.getState().status;
  }

  printLinks({ localHostUrl, localListenerUrl, publicListenerUrl, publicUrl });
  console.log(paint("dim", "  Ctrl-C to stop the server and the tunnel."));
  console.log("");
  openBrowser(localHostUrl);

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("");
    console.log(paint("dim", `  ${signal} received. Cleaning up...`));
    tunnel?.stop();
    await lis.close().catch(() => {});
    console.log(paint("dim", "  Audio buffers cleared. Server stopped."));
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error(paint("red", `Fatal: ${err.stack || err.message}`));
  process.exitCode = 1;
});
