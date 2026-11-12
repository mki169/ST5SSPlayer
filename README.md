# ST5SSPlayer

[![check](https://github.com/mki169/ST5SSPlayer/actions/workflows/check.yml/badge.svg)](https://github.com/mki169/ST5SSPlayer/actions/workflows/check.yml)

ST5SSPlayer is a private, invite-only listening room. The host plays audio from a browser, and invited listeners hear it live through a Cloudflare quick tunnel. The host keeps full playback control. Listeners get one button and no library.

The app is built for small, temporary listening sessions: send a friend a link, press play, and listen together without uploading files or creating accounts.

## Features

- Private host link with playback, seek, volume, queue, and invite controls.
- Public listener link that only plays audio and reports connection status.
- Local file decoding in the browser. Audio is never uploaded to a storage service.
- Raw PCM16 streaming over WebSocket, designed to work through tunnel response buffering.
- 8 second listener buffer with 9.5 seconds of host lookahead for network jitter.
- In-memory server history so late listeners can join a track already in progress.
- End-of-track handling that waits for listener buffers to drain before auto-advance.
- Built-in host audio test with automatic tone detection and listener confirmation.
- Self-check panel for WebSocket, audio engine, tunnel, buffer, and runtime health.
- Invite token rotation and optional custom public URL.
- Responsive host and listener interfaces with no frontend build step.

## Requirements

- Node.js 18.17 or newer.
- `cloudflared` for the default quick tunnel mode.
- A modern browser with Web Audio and WebSocket support.

On macOS, install `cloudflared` with Homebrew:

```bash
brew install cloudflared
```

See [deploy.md](deploy.md) for custom-domain and reverse-proxy deployments.

## Quick start

```bash
git clone https://github.com/mki169/ST5SSPlayer.git
cd ST5SSPlayer
npm install
npm start
```

The process prints two links:

- **Host link**: private. Keep it on the host machine and never share it.
- **Listener link**: safe to send to invited listeners.

The host page opens automatically when a terminal is available. Set `NO_OPEN=1` to disable that behavior.

If you already have a public HTTPS origin with WebSocket support, skip the quick tunnel:

```bash
PUBLIC_URL=https://listen.example.com NO_TUNNEL=1 npm start
```

For a local-only test without a public link:

```bash
NO_TUNNEL=1 npm start
```

## Using the room

1. Open the host link on the machine that will play audio.
2. Add audio files with the button or drop them anywhere on the page.
3. Press play.
4. Send the listener link to your guests.
5. Ask guests to tap **Enable audio** once. Browsers require a user gesture before playback.
6. Use **Test audio** to confirm the guest can hear the stream.

Auto-advance waits for connected listener buffers to finish before loading the next queued track. This keeps the end of each track from being cut off.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `8787` | HTTP and WebSocket port. |
| `HOST` | `127.0.0.1` | Interface to bind. Keep loopback unless a trusted reverse proxy or firewall is in front. |
| `NO_TUNNEL` | unset | Set to `1` to disable the Cloudflare quick tunnel. |
| `PUBLIC_URL` | unset | Public origin used in listener links. Setting it also disables the quick tunnel. |
| `NO_OPEN` | unset | Set to `1` to stop the host page from opening automatically. |

Example:

```bash
PORT=9000 HOST=127.0.0.1 PUBLIC_URL=https://listen.example.com NO_TUNNEL=1 NO_OPEN=1 npm start
```

`PUBLIC_URL` should be an origin such as `https://listen.example.com`. A path is discarded.

## How it works

```text
Host browser                 Node relay                  Listener browser
Web Audio decode  --PCM16-->  in-memory ring  --PCM16-->  Web Audio playback
local file only              no disk writes               no audio storage
```

1. The host decodes the selected file locally with the Web Audio API.
2. The host sends interleaved PCM16 frames over a WebSocket. Each frame has a small binary header with sample rate, channel count, timestamp, sequence, and stream ID.
3. The server keeps a short in-memory history ring and forwards frames to connected listeners.
4. The listener buffers ahead by about 8 seconds before starting playback. The host streams up to 9.5 seconds ahead.
5. Play, pause, seek, stop, volume, and end-of-track events travel over the same WebSocket connection.

Raw streamed audio is used instead of a normal HTTP audio endpoint because quick tunnels may buffer complete HTTP responses. WebSocket frames pass through immediately.

## Privacy and security

- Decoded audio and PCM frames stay in memory. Nothing is written to disk or uploaded to object storage.
- The listener page does not receive track titles, file names, waveform data, or queue metadata.
- Host and listener tokens are generated in memory at startup and travel in URL fragments, so they are not sent in HTTP requests.
- Listener tokens can be rotated from the host page. Existing listeners stay connected; new connections need the new link.
- The quick tunnel exposes the relay to the public internet, but the WebSocket still requires a valid invite token.
- The host link is the control credential. Anyone with it can control playback and rotate invites.
- There is no account system, database, or persistent room state. Restarting the server generates new tokens and invalidates old links.
- The server accepts up to 40 listeners and is intended for one host and one room per process.

This is a small listening tool, not a hardened multi-tenant service. Read [deploy.md](deploy.md) before exposing it outside a temporary session.

## Development

```bash
npm test
npm run check
```

`npm run check` syntax-checks every server and browser module, then runs the protocol and server integration tests with `node --test`.

There is no bundler and no frontend dependency install. Browser modules are served directly from `public/`.

### Project layout

```text
public/
  host.html              Host interface
  listen.html            Listener interface
  landing.html           Private root landing page
  css/app.css            Shared responsive styles
  js/host.js             Host controls, queue, links, diagnostics
  js/listen.js           Listener controls and status
  js/host-audio.js       Decode, playback, PCM pump, seek
  js/listener-audio.js   Listener buffer, scheduling, audio test
  js/protocol.js         Shared frame codec and constants
  js/ws-client.js        Browser WebSocket client
  js/ui.js               Shared DOM helpers
server/
  index.js               CLI, link printing, tunnel lifecycle
  app.js                 HTTP routes, WebSocket auth, relay, history
  tunnel.js              cloudflared supervisor and health checks
test/
  protocol.test.js       Frame codec tests
  server.test.js         Auth, streaming, rotation, end-of-track tests
```

## Troubleshooting

### The listener link does not open

Quick tunnel hostnames can take a few seconds to appear in DNS. If the tunnel process is online but the link still fails:

- Wait 10 to 30 seconds and retry.
- Flush the DNS cache on the machine doing the test.
  - macOS: `sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder`
  - Linux: `sudo resolvectl flush-caches`
  - Windows: `ipconfig /flushdns`
- Open the listener link from another device or network.

Some local resolvers fail on newly assigned `*.trycloudflare.com` names even when public DNS has the record. Remote listeners are usually unaffected. The host self-check may report a tunnel warning until the local resolver catches up.

### cloudflared is not installed

Install `cloudflared`, or run with `NO_TUNNEL=1` and use a local listener link. A local link only works on the same machine.

### The port is already in use

Run on another port:

```bash
PORT=8788 npm start
```

### Audio does not start on the listener device

The listener must tap **Enable audio** once. Browser autoplay rules block sound before that gesture. If the browser suspends the audio context later, the listener page shows a **Resume audio** button.

### The listener buffers repeatedly or logs underruns

Check the self-check panel and the listener connection. A slow network or a long distance from the relay can cause underruns. Keep the host and listener on stable connections. See [deploy.md](deploy.md) for reverse-proxy settings that avoid buffering WebSocket traffic.

## Deployment

For a public custom domain, systemd, Caddy, and nginx examples, see [deploy.md](deploy.md).

## License

MIT. See [LICENSE](LICENSE).
