# Video Chat

Peer-to-peer video chat in the browser. Go signaling server + vanilla HTML/JS — no frameworks, no build step.

## Features

- Video & audio calls (mesh P2P, no media flows through the server)
- Screen sharing with featured layout
- Text chat with unread message badge
- Named participants
- Mobile-friendly (responsive layout, virtual-keyboard aware)
- Rooms via URL path — share the link to invite others
- HTTPS via self-signed cert (local) or nginx + certbot (production)

## Quick Start (local)

```bash
go build -o videochat ./service
./videochat
```

Open `https://localhost:8083` — accept the self-signed certificate warning once, then you're redirected to a random room. The certificate is saved to `cert.pem` / `key.pem` and reused on subsequent restarts.

Share the URL with others on the same network to join the same room.

## Configuration

| Env var  | Default | Description |
|----------|---------|-------------|
| `PORT`   | `8083`  | Listen port |
| `NO_TLS` | _(unset)_ | Set to `1` to disable TLS (use behind a reverse proxy) |

## Deploy to Raspberry Pi (or any Linux server)

### 1. Build and sync

Copy `.env.example` to `.env` and set `RSYNC_DEST` (e.g. `user@raspberry:/home/www-data/chat.example.de`), then:

```bash
make release
```

This cross-compiles for `linux/arm64` and rsyncs the binary + `www/` to the target.

### 2. systemd service

```bash
sudo cp deploy/videochat.service /etc/systemd/system/
sudo cp deploy/videochat-watcher.service /etc/systemd/system/
sudo cp deploy/videochat-watcher.path /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now videochat
sudo systemctl enable --now videochat-watcher.path videochat-watcher.service
```

The service sets `NO_TLS=1` and binds to `127.0.0.1` only — nginx handles public TLS.

### 3. nginx + certbot

```bash
sudo cp deploy/nginx_ssl.conf /etc/nginx/sites-available/videochat
sudo ln -s /etc/nginx/sites-available/videochat /etc/nginx/sites-enabled/
# Obtain cert first (adjust domain):
sudo certbot --nginx -d chat.example.com
sudo nginx -t && sudo systemctl reload nginx
```

The nginx config proxies HTTPS → `http://127.0.0.1:<PORT>` and includes the WebSocket upgrade headers required for signaling.

## How It Works

- **Signaling** (Go + gorilla/websocket): Relays SDP offers/answers, ICE candidates, and app messages (chat, names, screen-share events) between peers. All fields are forwarded generically — no server changes needed for new message types.
- **WebRTC mesh**: Each participant connects directly to every other participant. No media flows through the server.
- **Rooms**: The URL path is the room name. `/abc123` and `/meeting` are separate rooms.
- **Screen sharing**: Uses a dedicated second transceiver per peer so `ontrack` fires cleanly on remote peers. Identified by stream ID, not track counting.

## Limitations

- **Mesh topology**: Works well up to ~4–6 participants. Beyond that, upload bandwidth and CPU grow linearly (each peer sends their stream to every other peer). For larger groups, a selective forwarding unit (SFU) like mediasoup or LiveKit would be needed.
- **No TURN server**: Peers behind strict NATs (~10–20% of networks) may fail to connect. For production, add a TURN server to `ICE_SERVERS` in `www/static/app.js`:

```js
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  {
    urls: 'turn:your-turn-server.com:3478',
    username: 'user',
    credential: 'pass',
  },
];
```

- **No persistence**: Rooms exist only while participants are connected. Chat history is lost on disconnect.
