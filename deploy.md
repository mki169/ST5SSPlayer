# Deployment

ST5SSPlayer has two jobs: serve a private listening room and give listeners a public HTTPS link. Choose the mode that matches how long the room will exist.

| Mode | Best for | Public URL |
| --- | --- | --- |
| Quick tunnel | Temporary sessions from a laptop | Random `*.trycloudflare.com` link |
| Custom domain with reverse proxy | A stable server and permanent hostname | Your own domain |
| Local only | Testing on one machine | None |

All modes run the same Node process. There is no database and no persistent state.

## Quick tunnel mode

This is the default behavior of `npm start`.

```bash
npm install
npm start
```

The script starts the Node server on loopback, launches `cloudflared tunnel --url http://127.0.0.1:8787`, and prints the public listener link when it is ready.

Requirements:

- `cloudflared` must be on `PATH`.
- The machine must be allowed to make outbound connections to Cloudflare.
- Port `8787` must be free, or set `PORT` to another value.

Notes:

- The public hostname changes every time the tunnel restarts.
- Quick tunnels are intended for testing and temporary sharing, not as an uptime SLA.
- The relay still requires a valid listener token. The tunnel does not make the room public without an invite.
- The host link points to `localhost`. Never send it to a listener.

For an unattended server, use a custom domain instead.

## Custom domain with a reverse proxy

Use this mode when listeners should have a stable URL.

### 1. Run ST5SSPlayer on loopback

```bash
PUBLIC_URL=https://listen.example.com \
NO_TUNNEL=1 \
NO_OPEN=1 \
HOST=127.0.0.1 \
PORT=8787 \
npm start
```

`PUBLIC_URL` must be the public HTTPS origin. ST5SSPlayer uses it to build listener links. Any path in the value is discarded.

### 2. Proxy HTTPS and WebSocket traffic

The proxy must forward WebSocket upgrades on `/ws` without response buffering. Both Caddy and nginx can do this.

#### Caddy

```caddyfile
listen.example.com {
  encode zstd gzip
  reverse_proxy 127.0.0.1:8787
}
```

Caddy obtains and renews TLS certificates automatically and handles WebSocket upgrades.

#### nginx

```nginx
map $http_upgrade $connection_upgrade {
  default upgrade;
  ''      close;
}

server {
  listen 443 ssl http2;
  server_name listen.example.com;

  ssl_certificate     /etc/letsencrypt/live/listen.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/listen.example.com/privkey.pem;

  location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_buffering off;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
  }
}
```

The long read timeout keeps idle WebSocket connections alive. The app also sends periodic WebSocket pings.

#### Existing Cloudflare Tunnel

If you already run a named Cloudflare Tunnel, point its hostname at `http://127.0.0.1:8787`. Set `PUBLIC_URL` to that hostname and run ST5SSPlayer with `NO_TUNNEL=1`. Do not start a second quick tunnel at the same time.

### 3. Keep the host link private

The host link is always local to the Node process:

```text
http://localhost:8787/h#<hostToken>
```

For a remote server, use an SSH port forward to open it without exposing the host interface:

```bash
ssh -L 8787:127.0.0.1:8787 user@server
```

Then open the host link printed by ST5SSPlayer on your own machine. Do not publish or proxy the host link for other people.

## systemd service

This example assumes a dedicated `st5ss` user, the app in `/opt/ST5SSPlayer`, and a reverse proxy in front of a loopback server.

```bash
sudo useradd --system --create-home --shell /usr/sbin/nologin st5ss
sudo mkdir -p /opt/ST5SSPlayer
sudo chown -R st5ss:st5ss /opt/ST5SSPlayer
```

Install dependencies as the service user:

```bash
sudo -u st5ss git clone https://github.com/mki169/ST5SSPlayer.git /opt/ST5SSPlayer
sudo -u st5ss npm --prefix /opt/ST5SSPlayer ci --omit=dev
```

Create `/etc/systemd/system/st5ssplayer.service`:

```ini
[Unit]
Description=ST5SSPlayer listening room
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=st5ss
WorkingDirectory=/opt/ST5SSPlayer
Environment=NODE_ENV=production
Environment=HOST=127.0.0.1
Environment=PORT=8787
Environment=NO_TUNNEL=1
Environment=PUBLIC_URL=https://listen.example.com
Environment=NO_OPEN=1
ExecStart=/usr/bin/node server/index.js
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true

[Install]
WantedBy=multi-user.target
```

Enable and start it:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now st5ssplayer
sudo systemctl status st5ssplayer
```

If you use the default quick tunnel service instead, omit `NO_TUNNEL` and `PUBLIC_URL`, make sure `cloudflared` is in the service `PATH`, and allow outbound internet access. A stable reverse proxy with your own domain is the better long-running choice.

## Operations

### Health check

```bash
curl http://127.0.0.1:8787/health
```

The endpoint returns basic liveness data: app version, uptime, host connection state, and listener count. It does not expose audio or invite tokens.

### Restart behavior

Restarting the process:

- Generates new host and listener tokens.
- Invalidates every previously printed link.
- Clears the in-memory audio history.
- Disconnects all listeners and the host.
- Assigns a new quick tunnel URL if quick tunnel mode is enabled.

There is no state to back up. Treat every restart as a new room.

### Updating

```bash
sudo -u st5ss git -C /opt/ST5SSPlayer pull
sudo -u st5ss npm --prefix /opt/ST5SSPlayer ci --omit=dev
sudo systemctl restart st5ssplayer
```

### Resource use

Audio history is capped in memory. The server does not transcode and does not persist files. CPU load is mainly WebSocket fan-out to listeners. Capacity depends on listener count, sample rate, and channel count. The default maximum is 40 listeners per room.

### One room per process

Each process has one host token and one listener token. To run multiple rooms, start multiple processes on different local ports and route them through separate hostnames or paths. Do not put multiple instances behind one listener link.

## Security checklist

- Keep `HOST=127.0.0.1` unless a firewall and trusted proxy are in place.
- Terminate TLS at the tunnel or reverse proxy. Do not send invite links over plain HTTP.
- Never share the host link. It grants playback control.
- Rotate the listener link with **New link** when an invite leaks.
- Use the public HTTPS origin for listeners and the loopback URL for the host.
- Keep Node.js and dependencies updated.
- Treat quick tunnel URLs as public endpoints. The token is the only access control.
- Do not place ST5SSPlayer behind a proxy that buffers WebSocket frames or has a short read timeout.
- Do not add authentication middleware that rewrites or strips the WebSocket upgrade headers.

## Troubleshooting

### The public listener link returns a DNS error

Wait for DNS propagation and flush the local resolver cache:

```bash
# macOS
sudo dscacheutil -flushcache
sudo killall -HUP mDNSResponder

# Linux with systemd-resolved
sudo resolvectl flush-caches
```

Some local resolvers fail to resolve newly assigned `*.trycloudflare.com` hostnames even when public DNS has the record. Test from another device or network. The server-side tunnel health check may report a warning until the resolver catches up.

### WebSocket connects, then drops immediately

Check the reverse proxy:

- `/ws` must allow HTTP/1.1 upgrades.
- `proxy_read_timeout` must be longer than the idle interval.
- Response buffering must be disabled.
- The proxy must not strip `Upgrade` or `Connection` headers.

### Listeners hear gaps or repeated buffering

- Test from a nearby device first.
- Check the host self-check panel for stream pacing and listener underruns.
- Keep the host on a wired or stable connection.
- Avoid proxies that buffer WebSocket traffic.
- Remember that listeners intentionally start about 8 seconds behind the host.

### Port already in use

```bash
PORT=8788 npm start
```

If using systemd, update `Environment=PORT=...` and the reverse proxy target.

## License

MIT. See [LICENSE](LICENSE).
