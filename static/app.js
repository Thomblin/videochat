const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

const roomName = location.pathname.replace(/^\/+|\/+$/g, '') || null;
if (!roomName) {
  location.href = '/' + Math.random().toString(36).substring(2, 8);
}
document.getElementById('room-name').textContent = roomName;

// Check if the room needs a password and show/hide the field accordingly
fetch(`/room-info?room=${encodeURIComponent(roomName)}`)
  .then(r => r.json())
  .then(info => {
    if (info.needsPassword) {
      document.getElementById('password-input').classList.remove('hidden');
    }
  })
  .catch(() => {});

let ws;
let localStream;
let myId;
let myName = '';
let hasCam = false;
let hasMic = false;
const peers = {};
const peerNames = {};

let screenStream = null;
let screenSharerId = null;

let chatOpen = false;
let unreadCount = 0;

// ── Dummy stream ───────────────────────────────────────────────────────────────

function makeDummyStream() {
  const canvas = document.createElement('canvas');
  canvas.width = 320; canvas.height = 240;
  const ctx = canvas.getContext('2d');
  function draw() {
    ctx.fillStyle = '#0f0f23';
    ctx.fillRect(0, 0, 320, 240);
    ctx.fillStyle = '#444466';
    ctx.font = '48px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('📷', 160, 110);
    ctx.fillStyle = '#666688';
    ctx.font = '16px sans-serif';
    ctx.fillText('No camera', 160, 150);
  }
  draw();
  const videoTrack = canvas.captureStream(0).getVideoTracks()[0];
  const ac = new AudioContext();
  const dest = ac.createMediaStreamDestination();
  const audioTrack = dest.stream.getAudioTracks()[0];
  return new MediaStream([videoTrack, audioTrack]);
}

// ── Join ───────────────────────────────────────────────────────────────────────

async function joinRoom() {
  myName = document.getElementById('name-input').value.trim();

  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    hasCam = true; hasMic = true;
  } catch (e) {
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      hasMic = true;
    } catch (e2) {}
    if (!localStream) localStream = makeDummyStream();
    if (localStream.getVideoTracks().length === 0) {
      localStream.addTrack(makeDummyStream().getVideoTracks()[0]);
    }
  }

  document.getElementById('landing').classList.add('hidden');
  document.getElementById('main').classList.remove('hidden');
  document.getElementById('toolbar').classList.add('visible');
  document.getElementById('video-grid').classList.remove('hidden');
  document.getElementById('screen-layout').classList.add('hidden');
  if (!hasCam) document.getElementById('btn-cam').disabled = true;
  if (!hasMic) document.getElementById('btn-mic').disabled = true;

  addVideoElement('local', localStream, myName || 'You', true);
  connectSignaling();
}

// ── Signaling ──────────────────────────────────────────────────────────────────

function connectSignaling() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const passwordVal = document.getElementById('password-input').value;
  let wsUrl = `${proto}//${location.host}/ws?room=${encodeURIComponent(roomName)}`;
  if (passwordVal) wsUrl += `&password=${encodeURIComponent(passwordVal)}`;
  ws = new WebSocket(wsUrl);
  ws.onopen = () => console.log('WS connected');

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    switch (msg.type) {
      case 'welcome':
        myId = msg.yourId;
        for (const peerId of msg.peers) createPeerConnection(peerId, true);
        if (myName) broadcastToAll({ type: 'name', name: myName });
        break;
      case 'name':
        peerNames[msg.peerId] = msg.name;
        const el = document.getElementById('video-' + msg.peerId);
        if (el) el.querySelector('.video-label').textContent = msg.name;
        break;
      case 'peer-joined':
        if (myName && msg.peerId)
          ws.send(JSON.stringify({ type: 'name', targetId: msg.peerId, name: myName }));
        break;
      case 'offer':   handleOffer(msg.peerId, msg.sdp); break;
      case 'answer':  handleAnswer(msg.peerId, msg.sdp); break;
      case 'ice':     handleICE(msg.peerId, msg.ice); break;
      case 'peer-left':
        if (screenSharerId === msg.peerId) { screenSharerId = null; revertLayout(); }
        removePeer(msg.peerId);
        appendSystemMsg((peerNames[msg.peerId] || shortId(msg.peerId)) + ' left');
        break;
      case 'screen-share-start':
        screenSharerId = msg.peerId;
        updateScreenBtn();
        // If track already arrived (fast link), switch layout now.
        // Otherwise ontrack will do it when the track arrives.
        if (peers[msg.peerId]?.screenStream?.getVideoTracks().length > 0) {
          applyRemoteScreenLayout(msg.peerId, peers[msg.peerId].screenStream);
        }
        break;
      case 'screen-share-stop':
        screenSharerId = null;
        updateScreenBtn();
        removeRemoteScreen(msg.peerId);
        revertLayout();
        break;
      case 'chat':
        receiveChat(msg.peerId, msg.text);
        break;
      case 'server-shutdown':
        appendSystemMsg('Server is shutting down...');
        break;
    }
  };

  ws.onclose = (e) => {
    console.log('WS closed', e.code, e.reason);
    // If connection was rejected (never opened successfully), likely bad password
    if (!myId && e.code !== 1000) {
      showError('Connection rejected. Check the room password.');
      leaveRoom();
    }
  };
}

function showError(text) {
  const el = document.getElementById('error-msg');
  el.textContent = text;
  el.style.display = 'block';
}

function broadcastToAll(obj) {
  for (const peerId of Object.keys(peers))
    ws.send(JSON.stringify({ ...obj, targetId: peerId }));
}

// ── Peer connections ───────────────────────────────────────────────────────────

function createPeerConnection(peerId, shouldOffer) {
  if (peers[peerId]) return peers[peerId].pc;

  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  // camStreamId: the stream id used for the camera/mic tracks (set on first ontrack)
  peers[peerId] = { pc, camStream: new MediaStream(), screenStream: new MediaStream(), camStreamId: null };

  for (const track of localStream.getTracks()) pc.addTrack(track, localStream);

  pc.ontrack = (event) => {
    const peer = peers[peerId];
    const track = event.track;
    const incomingStreamId = event.streams[0]?.id ?? null;
    console.log(`[${shortId(peerId)}] ontrack kind=${track.kind} streamId=${incomingStreamId} camStreamId=${peer.camStreamId}`);
    const peerLabel = () => peerNames[peerId] || shortId(peerId);

    // First track establishes what the camera stream ID is.
    // Subsequent tracks on the SAME stream ID → camera/audio.
    // A track on a DIFFERENT stream ID → screen share.
    if (peer.camStreamId === null) {
      peer.camStreamId = incomingStreamId;
    }

    if (incomingStreamId === peer.camStreamId) {
      // Camera / audio track
      peer.camStream.addTrack(track);
      addVideoElement(peerId, peer.camStream, peerLabel());
    } else {
      // Screen share track (different stream)
      // Replace any old track of same kind in screenStream
      peer.screenStream.getTracks()
        .filter(t => t.kind === track.kind)
        .forEach(t => peer.screenStream.removeTrack(t));
      peer.screenStream.addTrack(track);
      console.log(`[${shortId(peerId)}] screen track received, sharerId=${screenSharerId}`);
      if (screenSharerId === peerId) applyRemoteScreenLayout(peerId, peer.screenStream);
    }
  };

  pc.onicecandidate = (e) => {
    if (e.candidate) ws.send(JSON.stringify({ type: 'ice', targetId: peerId, ice: e.candidate }));
  };

  pc.onconnectionstatechange = () => console.log(`[${shortId(peerId)}] ${pc.connectionState}`);

  const impolite = shouldOffer;
  let makingOffer = false;
  peers[peerId].makingOffer = () => makingOffer;
  peers[peerId].impolite = impolite;

  pc.onnegotiationneeded = async () => {
    console.log(`[${shortId(peerId)}] onnegotiationneeded impolite=${impolite}`);
    try {
      makingOffer = true;
      const offer = await pc.createOffer();
      if (pc.signalingState !== 'stable') return;
      await pc.setLocalDescription(offer);
      ws.send(JSON.stringify({ type: 'offer', targetId: peerId, sdp: pc.localDescription }));
    } catch (err) { console.error('offer error', err); }
    finally { makingOffer = false; }
  };

  return pc;
}

async function handleOffer(peerId, sdp) {
  const pc = createPeerConnection(peerId, false);
  const peer = peers[peerId];
  const offerCollision = peer.makingOffer() || pc.signalingState !== 'stable';
  if (offerCollision && peer.impolite) {
    console.log(`[${shortId(peerId)}] ignoring offer (collision, impolite)`);
    return;
  }
  await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  ws.send(JSON.stringify({ type: 'answer', targetId: peerId, sdp: pc.localDescription }));
}

async function handleAnswer(peerId, sdp) {
  const peer = peers[peerId];
  if (peer) await peer.pc.setRemoteDescription(new RTCSessionDescription(sdp));
}

async function handleICE(peerId, ice) {
  const peer = peers[peerId];
  if (peer) {
    try { await peer.pc.addIceCandidate(new RTCIceCandidate(ice)); }
    catch (err) { console.error('ICE error', err); }
  }
}

function removePeer(peerId) {
  const peer = peers[peerId];
  if (peer) { peer.pc.close(); delete peers[peerId]; }
  document.getElementById('video-' + peerId)?.remove();
  document.getElementById('video-screen-' + peerId)?.remove();
  updateGrid();
}

// ── Screen sharing ─────────────────────────────────────────────────────────────

async function startScreenShare() {
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  } catch (err) { console.log('Screen share cancelled:', err.message); return; }

  screenStream = stream;
  const screenTrack = stream.getVideoTracks()[0];

  // `onended` can fire spuriously when the browser minimizes during the
  // screen picker (Android Chrome) or when sharing an app on the same monitor
  // (Firefox/desktop). We only act on it once the page is visible again and
  // the track is genuinely ended.
  screenTrack.onended = () => {
    if (document.hidden) {
      // Page is hidden — wait for it to become visible, then check
      const onVisible = () => {
        document.removeEventListener('visibilitychange', onVisible);
        if (screenTrack.readyState === 'ended') stopScreenShare();
      };
      document.addEventListener('visibilitychange', onVisible);
    } else {
      stopScreenShare();
    }
  };

  for (const [peerId, peer] of Object.entries(peers))
    peer.pc.addTrack(screenTrack, stream);

  broadcastToAll({ type: 'screen-share-start' });
  screenSharerId = myId;
  applyLocalScreenLayout(stream);
  updateScreenBtn();
}

async function stopScreenShare() {
  if (!screenStream) return;
  const track = screenStream.getVideoTracks()[0];

  for (const [peerId, peer] of Object.entries(peers)) {
    const sender = peer.pc.getSenders().find(s => s.track === track);
    if (sender) {
      peer.pc.removeTrack(sender);
      peer.screenStream.getTracks().forEach(t => peer.screenStream.removeTrack(t));
    }
  }

  screenStream.getTracks().forEach(t => t.stop());
  screenStream = null;
  screenSharerId = null;
  broadcastToAll({ type: 'screen-share-stop' });
  revertLayout();
  updateScreenBtn();
}

function toggleScreenShare() { screenStream ? stopScreenShare() : startScreenShare(); }

function updateScreenBtn() {
  const btn = document.getElementById('btn-screen');
  const iAmSharing = screenStream !== null;
  const someoneElseSharing = screenSharerId !== null && screenSharerId !== myId;
  setBtnContent(btn, iAmSharing ? '⏹' : '🖥️', iAmSharing ? 'Stop' : 'Share');
  btn.classList.toggle('active', iAmSharing);
  btn.disabled = someoneElseSharing;
}

function removeRemoteScreen(peerId) {
  document.getElementById('video-screen-' + peerId)?.remove();
  if (peers[peerId]) peers[peerId].screenStream = null;
}

// ── Chat ───────────────────────────────────────────────────────────────────────

function toggleChat() {
  chatOpen = !chatOpen;
  document.getElementById('chat-panel').classList.toggle('hidden', !chatOpen);
  document.getElementById('btn-chat').classList.toggle('active', chatOpen);
  if (chatOpen) {
    unreadCount = 0;
    updateChatBadge();
    document.getElementById('chat-input').focus();
    const msgs = document.getElementById('chat-messages');
    msgs.scrollTop = msgs.scrollHeight;
  }
  applyViewportHeight();
}

function updateChatBadge() {
  const badge = document.getElementById('chat-badge');
  if (unreadCount > 0 && !chatOpen) {
    badge.textContent = unreadCount > 99 ? '99+' : unreadCount;
    badge.classList.add('visible');
  } else {
    badge.classList.remove('visible');
  }
}

function sendChat() {
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';

  // Show locally
  appendChatMsg('me', myName || 'You', text);
  // Send to all peers
  broadcastToAll({ type: 'chat', text });
}

function receiveChat(peerId, text) {
  const senderName = peerNames[peerId] || shortId(peerId);
  appendChatMsg('them', senderName, text);
  if (!chatOpen) {
    unreadCount++;
    updateChatBadge();
  }
}

function appendChatMsg(who, senderName, text) {
  const msgs = document.getElementById('chat-messages');
  const div = document.createElement('div');
  div.className = 'chat-msg' + (who === 'me' ? ' mine' : '');

  const now = new Date();
  const ts = now.getHours().toString().padStart(2,'0') + ':' + now.getMinutes().toString().padStart(2,'0');

  div.innerHTML = `
    <span class="sender">${escapeHtml(senderName)}</span>
    <span class="bubble">${escapeHtml(text)}</span>
    <span class="ts">${ts}</span>`;
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
}

function appendSystemMsg(text) {
  const msgs = document.getElementById('chat-messages');
  const div = document.createElement('div');
  div.className = 'chat-system';
  div.textContent = text;
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
}

function escapeHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── Layout ─────────────────────────────────────────────────────────────────────

function applyLocalScreenLayout(stream) {
  document.getElementById('video-grid').classList.add('hidden');
  document.getElementById('screen-layout').classList.remove('hidden');
  document.getElementById('screen-video').srcObject = stream;
  document.getElementById('screen-label').textContent = (myName || 'Your') + "'s screen";
  const strip = document.getElementById('tile-strip');
  strip.innerHTML = '';
  document.querySelectorAll('#video-grid .video-container').forEach(el => strip.appendChild(el));
}

function applyRemoteScreenLayout(peerId, stream) {
  document.getElementById('video-grid').classList.add('hidden');
  document.getElementById('screen-layout').classList.remove('hidden');
  document.getElementById('screen-video').srcObject = stream;
  const label = peerNames[peerId] || shortId(peerId);
  document.getElementById('screen-label').textContent = label + "'s screen";
  const strip = document.getElementById('tile-strip');
  strip.innerHTML = '';
  document.querySelectorAll('#video-grid .video-container').forEach(el => strip.appendChild(el));
}

function revertLayout() {
  document.getElementById('screen-video').srcObject = null;
  const grid = document.getElementById('video-grid');
  document.querySelectorAll('#tile-strip .video-container').forEach(el => grid.appendChild(el));
  document.getElementById('screen-layout').classList.add('hidden');
  grid.classList.remove('hidden');
  updateGrid();
}

// ── UI helpers ─────────────────────────────────────────────────────────────────

function addVideoElement(id, stream, label, muted = false) {
  if (document.getElementById('video-' + id)) return;

  const container = document.createElement('div');
  container.className = 'video-container';
  container.id = 'video-' + id;

  const video = document.createElement('video');
  video.srcObject = stream;
  video.autoplay = true;
  video.playsInline = true;
  if (muted) video.muted = true;

  const labelEl = document.createElement('div');
  labelEl.className = 'video-label';
  labelEl.textContent = label;

  container.appendChild(video);
  container.appendChild(labelEl);

  const inScreenLayout = !document.getElementById('screen-layout').classList.contains('hidden');
  if (inScreenLayout) {
    document.getElementById('tile-strip').appendChild(container);
  } else {
    document.getElementById('video-grid').appendChild(container);
    updateGrid();
  }
}

function updateGrid() {
  const grid = document.getElementById('video-grid');
  const count = grid.querySelectorAll('.video-container').length;
  const cols = Math.max(1, Math.ceil(Math.sqrt(count)));
  const gap = 8, padding = 8;
  const availW = grid.clientWidth  - padding * 2 - gap * (cols - 1);
  const availH = grid.clientHeight - padding * 2 - gap * (cols - 1);
  const cellSize = Math.floor(Math.min(availW / cols, availH / cols));
  grid.style.gridTemplateColumns = `repeat(${cols}, ${cellSize}px)`;
  grid.style.gridAutoRows = `${cellSize}px`;
}

function shortId(id) { return id.slice(-8); }

// Adjust body height and mobile chat panel to the visual viewport,
// so the virtual keyboard pushes everything up correctly.
function applyViewportHeight() {
  const vv = window.visualViewport;
  const top = vv ? vv.offsetTop : 0;
  const h   = vv ? vv.height    : window.innerHeight;

  document.body.style.height    = h + 'px';
  document.body.style.maxHeight = h + 'px';

  // On mobile, the full-screen chat panel is position:fixed and must be
  // explicitly pinned to the visual viewport so it shrinks with the keyboard.
  const panel = document.getElementById('chat-panel');
  if (window.matchMedia('(max-width: 600px)').matches && !panel.classList.contains('hidden')) {
    panel.style.top    = top + 'px';
    panel.style.height = h + 'px';
  } else {
    panel.style.top    = '';
    panel.style.height = '';
  }

  updateGrid();
}

if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', applyViewportHeight);
  window.visualViewport.addEventListener('scroll', applyViewportHeight);
}
window.addEventListener('resize', applyViewportHeight);
applyViewportHeight();

function copyLink(e) {
  e.preventDefault();
  navigator.clipboard.writeText(location.href);
  e.target.textContent = 'copied!';
  setTimeout(() => e.target.textContent = 'copy invite link', 2000);
}

let micEnabled = true;
let camEnabled = true;

// Update a toolbar button's emoji + label text without destroying child spans
function setBtnContent(btn, emoji, label) {
  // Set first text node to the emoji, update .btn-label span if present
  const span = btn.querySelector('.btn-label');
  if (span) {
    btn.childNodes[0].textContent = emoji;
    span.textContent = ' ' + label;
  } else {
    btn.textContent = emoji + ' ' + label;
  }
}

function toggleMic() {
  micEnabled = !micEnabled;
  localStream.getAudioTracks().forEach(t => t.enabled = micEnabled);
  const btn = document.getElementById('btn-mic');
  setBtnContent(btn, micEnabled ? '🎤' : '🔇', micEnabled ? 'Mute' : 'Unmute');
  btn.classList.toggle('active', !micEnabled);
}

function toggleCam() {
  camEnabled = !camEnabled;
  localStream.getVideoTracks().forEach(t => t.enabled = camEnabled);
  const btn = document.getElementById('btn-cam');
  setBtnContent(btn, '📷', camEnabled ? 'Hide' : 'Show');
  btn.classList.toggle('active', !camEnabled);
}

function leaveRoom() {
  if (screenStream) stopScreenShare();
  if (ws) ws.close();
  for (const peerId in peers) { peers[peerId].pc.close(); delete peers[peerId]; }
  if (localStream) localStream.getTracks().forEach(t => t.stop());
  for (const k in peerNames) delete peerNames[k];
  chatOpen = false;
  unreadCount = 0;
  updateChatBadge();
  document.getElementById('chat-messages').innerHTML = '';
  document.getElementById('chat-panel').classList.add('hidden');
  document.getElementById('video-grid').innerHTML = '';
  document.getElementById('video-grid').classList.remove('hidden');
  document.getElementById('tile-strip').innerHTML = '';
  document.getElementById('main').classList.add('hidden');
  document.getElementById('screen-layout').classList.add('hidden');
  document.getElementById('toolbar').classList.remove('visible');
  document.getElementById('btn-cam').disabled = false;
  document.getElementById('btn-mic').disabled = false;
  document.getElementById('btn-chat').classList.remove('active');
  document.getElementById('landing').classList.remove('hidden');
}
