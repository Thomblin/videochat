# Video Chat

Peer-to-peer video chat in the browser. Go signaling server + vanilla HTML/JS — no frameworks, no build step.

## Features

- Video & audio calls (mesh P2P, no media flows through the server)
- Screen sharing with featured layout
- Text chat with unread badge and chat download
- Named participants (remembered across sessions)
- Raise hand and emoji reactions (floating animations)
- Audio/video device picker (switch mid-call)
- Connection quality indicator (green/yellow/red per peer)
- Mute/camera-off indicators on peer video tiles
- Speaking indicator on active speakers
- Bandwidth adaptation (auto/high/low/speaker-only modes)
- Picture-in-Picture and double-click fullscreen
- Room picker with history tiles and live participant counts
- Lobby showing who's in the room before joining
- Audio/video preview before joining
- WebSocket reconnection with exponential backoff
- ICE restart on connection failure
- Auto-reconnect on network change (WiFi/cellular switch)
- Mobile-friendly (responsive layout, virtual-keyboard aware chat)
- DuckDuckGo / WebView browser compatibility
- HTTPS via self-signed cert (local) or nginx + certbot (production)
- No inline JavaScript — strict CSP (`script-src 'self'`)

## Quick Start (local)

```bash
go build -o videochat ./service
./videochat
```

Open `https://localhost:8083` — accept the self-signed certificate warning once. You'll see a room picker where you can enter a room name or join a previous room. The certificate is saved to `cert.pem` / `key.pem` and reused on subsequent restarts.

Share the URL with others on the same network to join the same room.

## Configuration

| Env var | Default | Description |
|---|---|---|
| `PORT` | `8083` | Listen port |
| `NO_TLS` | _(unset)_ | Set to `1` to disable TLS (use behind a reverse proxy) |
| `ICE_SERVERS` | Google STUN | JSON array of RTCIceServer objects (see below) |

### ICE server example

```bash
export ICE_SERVERS='[{"urls":"stun:stun.l.google.com:19302"},{"urls":"turn:your-turn-server.com:3478","username":"user","credential":"pass"}]'
```

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

- **Signaling** (Go + gorilla/websocket): Relays SDP offers/answers, ICE candidates, and app messages (chat, names, reactions, media state) between peers. All fields are forwarded generically — no server changes needed for new message types. The server also tracks peer names and counts for the lobby API.
- **WebRTC mesh**: Each participant connects directly to every other participant. No media flows through the server.
- **Rooms**: The URL path is the room name. `/family` and `/meeting` are separate rooms. Room history is saved in localStorage.
- **Screen sharing**: Uses a dedicated second transceiver per peer so `ontrack` fires cleanly on remote peers. Identified by stream ID, not track counting.
- **Password auth**: Sent as the first WebSocket message (`{ type: "auth", password }`) — never in the URL.
- **Bandwidth adaptation**: Settings modal lets users choose between auto, high, low, or speaker-only modes. Bitrate is controlled via `RTCRtpSender.setParameters()`.

## Limitations

- **Mesh topology**: Works well up to ~4–6 participants. Beyond that, upload bandwidth and CPU grow linearly (each peer sends their stream to every other peer). For larger groups, a selective forwarding unit (SFU) like mediasoup or LiveKit would be needed.
- **No TURN server by default**: Peers behind strict NATs (~10–20% of networks) may fail to connect. For production, set the `ICE_SERVERS` env var with a TURN server.
- **No persistence**: Rooms exist only while participants are connected. Chat history is lost on page reload (but can be downloaded during the session).

## Tests

```bash
# Go server tests
cd service && go test ./...

# JS client tests
cd www && npx vitest run
```
