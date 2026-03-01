// ── Config (fetched from server) ─────────────────────────────────────────────

let iceServers = [];

const roomName = location.pathname.replace(/^\/+|\/+$/g, '') || null;

// ── State ───────────────────────────────────────────────────────────────────

let ws;
let localStream;
let myId;
let myName = '';
let hasCam = false;
let hasMic = false;
const peers = {};
const peerNames = {};
const peerMediaState = {};

let screenStream = null;
let screenSharerId = null;

let chatOpen = false;
let unreadCount = 0;
let micEnabled = true;
let camEnabled = true;

let intentionalLeave = false;
let serverShutdown = false;
let reconnectAttempts = 0;
let reconnectTimer = null;
const MAX_RECONNECT_ATTEMPTS = 5;

let guestCounter = 0;
const guestNumbers = {};

let audioCtx = null;
let localAnalyser = null;

// ── Room history ─────────────────────────────────────────────────────────────

function getRoomHistory() {
  try {
    return JSON.parse(localStorage.getItem('videochat-rooms') || '[]');
  } catch (e) { return []; }
}

function saveRoomToHistory(name) {
  const rooms = getRoomHistory().filter(r => r.name !== name);
  rooms.unshift({ name, lastVisited: Date.now() });
  // Keep only last 20 rooms
  if (rooms.length > 20) rooms.length = 20;
  localStorage.setItem('videochat-rooms', JSON.stringify(rooms));
}

function renderRoomHistory() {
  const container = document.getElementById('room-history');
  if (!container) return;
  const rooms = getRoomHistory();
  if (rooms.length === 0) {
    container.classList.add('hidden');
    return;
  }
  container.classList.remove('hidden');
  const list = container.querySelector('.room-history-list');
  list.innerHTML = '';
  for (const room of rooms) {
    const tile = document.createElement('a');
    tile.className = 'room-tile';
    tile.href = '/' + encodeURIComponent(room.name);
    tile.innerHTML = `<span class="room-tile-name">${escapeHtml(room.name)}</span><span class="room-tile-count" data-room="${escapeHtml(room.name)}"></span>`;
    list.appendChild(tile);
  }
  // Fetch live counts
  fetchRoomCounts(rooms);
}

async function fetchRoomCounts(rooms) {
  for (const room of rooms) {
    try {
      const resp = await fetch(`/room-info?room=${encodeURIComponent(room.name)}`);
      const info = await resp.json();
      const el = document.querySelector(`.room-tile-count[data-room="${CSS.escape(room.name)}"]`);
      if (el) {
        el.textContent = info.peerCount > 0 ? `${info.peerCount} online` : 'empty';
        el.classList.toggle('room-tile-active', info.peerCount > 0);
      }
    } catch (e) {}
  }
}

// ── Init ────────────────────────────────────────────────────────────────────

async function init() {

  // Load quality preference
  const savedQuality = localStorage.getItem('videochat-quality');
  if (savedQuality) qualityMode = savedQuality;

  // Show room picker if no room name in URL
  if (!roomName) {
    document.getElementById('room-name').textContent = '';
    document.getElementById('room-picker').classList.remove('hidden');
    document.getElementById('room-join').classList.add('hidden');
    renderRoomHistory();
    // Refresh room tile counts periodically
    setInterval(() => {
      const rooms = getRoomHistory();
      if (rooms.length > 0) fetchRoomCounts(rooms);
    }, 5000);
    return;
  }
  document.getElementById('room-picker').classList.add('hidden');
  document.getElementById('room-join').classList.remove('hidden');

  document.getElementById('room-name').textContent = roomName;

  // Pre-fill name from localStorage
  const savedName = localStorage.getItem('videochat-name');
  if (savedName) {
    document.getElementById('name-input-inline').value = savedName;
  }

  // Fetch config (ICE servers)
  try {
    const configResp = await fetch('/config');
    const config = await configResp.json();
    iceServers = config.iceServers || [];
  } catch (e) {
    iceServers = [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
    ];
  }

  // Check if the room needs a password and show lobby info
  try {
    const resp = await fetch(`/room-info?room=${encodeURIComponent(roomName)}`);
    const info = await resp.json();
    if (info.needsPassword) {
      document.getElementById('password-input').classList.remove('hidden');
    }
    updateLobbyInfo(info);
  } catch (e) {}

  // Refresh lobby info while on landing
  setInterval(async () => {
    if (document.getElementById('landing').classList.contains('hidden')) return;
    try {
      const resp = await fetch(`/room-info?room=${encodeURIComponent(roomName)}`);
      const info = await resp.json();
      updateLobbyInfo(info);
    } catch (e) {}
  }, 5000);
}

function updateLobbyInfo(info) {
  const lobbyEl = document.getElementById('lobby-info');
  if (!lobbyEl) return;
  lobbyEl.style.display = 'block';

  if (info.peerCount === 0) {
    lobbyEl.innerHTML = '<span class="lobby-status">Room is empty</span>';
    return;
  }

  const namedPeers = info.peerNames || [];
  const unnamed = info.peerCount - namedPeers.length;
  let html = `<span class="lobby-status">${info.peerCount} person${info.peerCount !== 1 ? 's' : ''} in room</span>`;
  html += '<ul class="lobby-users">';
  for (const name of namedPeers) {
    html += `<li>${escapeHtml(name)}</li>`;
  }
  if (unnamed > 0) {
    html += `<li class="lobby-guests">${unnamed} guest${unnamed !== 1 ? 's' : ''}</li>`;
  }
  html += '</ul>';
  lobbyEl.innerHTML = html;
}

// ── Dummy stream ────────────────────────────────────────────────────────────

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

// ── Preview ─────────────────────────────────────────────────────────────────

async function startPreview() {
  const previewVideo = document.getElementById('preview-video');
  const previewArea = document.getElementById('preview-area');

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

  previewVideo.srcObject = localStream;
  previewArea.classList.remove('hidden');
  document.getElementById('preview-btn').classList.add('hidden');

  // Populate device selectors
  populateDeviceSelectors();

  // Show preview controls
  document.getElementById('preview-controls').classList.remove('hidden');
}

function closePreview() {
  const previewArea = document.getElementById('preview-area');
  const previewBtn = document.getElementById('preview-btn');
  const previewControls = document.getElementById('preview-controls');
  const previewVideo = document.getElementById('preview-video');

  previewArea.classList.add('hidden');
  previewBtn.classList.remove('hidden');
  previewControls.classList.add('hidden');

  if (previewVideo.srcObject) {
    previewVideo.srcObject = null;
  }
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
    hasCam = false;
    hasMic = false;
  }
}

async function populateDeviceSelectors() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const audioSelects = [document.getElementById('audio-input-select'), document.getElementById('setting-audio-input')].filter(Boolean);
    const videoSelects = [document.getElementById('video-input-select'), document.getElementById('setting-video-input')].filter(Boolean);

    audioSelects.forEach(s => s.innerHTML = '');
    videoSelects.forEach(s => s.innerHTML = '');

    devices.forEach(device => {
      if (device.kind === 'audioinput') {
        audioSelects.forEach(sel => {
          const option = document.createElement('option');
          option.value = device.deviceId;
          option.textContent = device.label || `Microphone ${sel.options.length + 1}`;
          sel.appendChild(option);
        });
      } else if (device.kind === 'videoinput') {
        videoSelects.forEach(sel => {
          const option = document.createElement('option');
          option.value = device.deviceId;
          option.textContent = device.label || `Camera ${sel.options.length + 1}`;
          sel.appendChild(option);
        });
      }
    });

    // Select currently active devices
    if (localStream) {
      const audioTrack = localStream.getAudioTracks()[0];
      const videoTrack = localStream.getVideoTracks()[0];
      if (audioTrack) {
        const settings = audioTrack.getSettings ? audioTrack.getSettings() : {};
        if (settings.deviceId) audioSelects.forEach(s => s.value = settings.deviceId);
      }
      if (videoTrack) {
        const settings = videoTrack.getSettings ? videoTrack.getSettings() : {};
        if (settings.deviceId) videoSelects.forEach(s => s.value = settings.deviceId);
      }
    }
  } catch (e) {}
}

async function switchDevice(kind, deviceId) {
  if (!deviceId) {
    const select = kind === 'audio'
      ? document.getElementById('audio-input-select')
      : document.getElementById('video-input-select');
    deviceId = select.value;
  }
  if (!deviceId) return;

  const constraints = kind === 'audio'
    ? { audio: { deviceId: { exact: deviceId } } }
    : { video: { deviceId: { exact: deviceId } } };

  try {
    const newStream = await navigator.mediaDevices.getUserMedia(constraints);
    const newTrack = newStream.getTracks()[0];
    const oldTrack = kind === 'audio'
      ? localStream.getAudioTracks()[0]
      : localStream.getVideoTracks()[0];

    if (oldTrack) {
      localStream.removeTrack(oldTrack);
      oldTrack.stop();
    }
    localStream.addTrack(newTrack);

    // Replace track on all peer connections
    for (const peerId of Object.keys(peers)) {
      const senders = peers[peerId].pc.getSenders();
      const sender = senders.find(s => s.track && s.track.kind === newTrack.kind);
      if (sender) sender.replaceTrack(newTrack);
    }

    // Update preview/local video
    const previewVideo = document.getElementById('preview-video');
    if (previewVideo && previewVideo.srcObject) previewVideo.srcObject = localStream;
    const localVideo = document.getElementById('video-local');
    if (localVideo) {
      const vid = localVideo.querySelector('video');
      if (vid) vid.srcObject = localStream;
    }
  } catch (e) {
    console.error('Failed to switch device:', e);
  }
}

// ── Join ────────────────────────────────────────────────────────────────────

async function joinRoom() {
  myName = document.getElementById('name-input-inline').value.trim();

  // Save name to localStorage
  if (myName) {
    localStorage.setItem('videochat-name', myName);
  }

  // Save room to history
  saveRoomToHistory(roomName);

  // If no preview was done, get media now
  if (!localStream) {
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
  }

  // Initialize AudioContext on user gesture so notifications work later
  if (!audioCtx) {
    try { audioCtx = new AudioContext(); } catch (e) {}
  } else if (audioCtx.state === 'suspended') {
    audioCtx.resume();
  }

  // Set up local mic analyser for speaking detection
  if (audioCtx && localStream && localStream.getAudioTracks().length > 0) {
    try {
      const source = audioCtx.createMediaStreamSource(localStream);
      localAnalyser = audioCtx.createAnalyser();
      localAnalyser.fftSize = 256;
      source.connect(localAnalyser);
    } catch (e) {}
  }

  intentionalLeave = false;
  serverShutdown = false;
  reconnectAttempts = 0;

  document.getElementById('landing').classList.add('hidden');
  document.getElementById('main').classList.remove('hidden');
  document.getElementById('toolbar').classList.add('visible');
  document.getElementById('video-grid').classList.remove('hidden');
  document.getElementById('screen-layout').classList.add('hidden');
  if (!hasCam) document.getElementById('btn-cam').disabled = true;
  if (!hasMic) document.getElementById('btn-mic').disabled = true;

  // Sync toolbar buttons with current mic/cam state from preview
  const micBtn = document.getElementById('btn-mic');
  setBtnContent(micBtn, micEnabled ? '🎤' : '🔇', micEnabled ? 'Mute' : 'Unmute');
  micBtn.classList.toggle('active', !micEnabled);
  const camBtn = document.getElementById('btn-cam');
  setBtnContent(camBtn, '📷', camEnabled ? 'Hide' : 'Show');
  camBtn.classList.toggle('btn-crossed', !camEnabled);
  camBtn.classList.toggle('active', !camEnabled);

  addVideoElement('local', localStream, myName || 'You', true);
  connectSignaling();
  startSpeakerDetection();
}

// ── Room picker (named rooms) ───────────────────────────────────────────────

function joinNamedRoom() {
  const input = document.getElementById('room-input');
  const name = input.value.trim();
  if (!name) {
    // Generate random room
    location.href = '/' + Math.random().toString(36).substring(2, 8);
    return;
  }
  // Validate
  if (!/^[a-zA-Z0-9_-]+$/.test(name) || name.length > 64) {
    document.getElementById('room-error').textContent = 'Letters, numbers, hyphens, underscores only (max 64 chars)';
    document.getElementById('room-error').style.display = 'block';
    return;
  }
  location.href = '/' + name;
}

// ── Signaling ───────────────────────────────────────────────────────────────

function connectSignaling() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${proto}//${location.host}/ws?room=${encodeURIComponent(roomName)}`;
  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    console.log('WS connected');
    hideReconnectBanner();
    reconnectAttempts = 0;

    // Send auth if password-protected
    const passwordVal = document.getElementById('password-input').value;
    if (passwordVal) {
      ws.send(JSON.stringify({ type: 'auth', password: passwordVal }));
    }
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    switch (msg.type) {
      case 'welcome':
        myId = msg.yourId;
        for (const peerId of msg.peers) createPeerConnection(peerId, true);
        if (myName) broadcastToAll({ type: 'name', name: myName });
        // Send current media state to all peers
        broadcastToAll({ type: 'media-state', audio: micEnabled, video: camEnabled });
        break;
      case 'name':
        peerNames[msg.peerId] = msg.name;
        updatePeerLabel(msg.peerId);
        break;
      case 'peer-joined':
        if (myName && msg.peerId)
          ws.send(JSON.stringify({ type: 'name', targetId: msg.peerId, name: myName }));
        // Send media state to new peer
        ws.send(JSON.stringify({ type: 'media-state', targetId: msg.peerId, audio: micEnabled, video: camEnabled }));
        appendSystemMsg(displayName(msg.peerId) + ' joined');
        playNotification('join');
        break;
      case 'offer':   handleOffer(msg.peerId, msg.sdp); break;
      case 'answer':  handleAnswer(msg.peerId, msg.sdp); break;
      case 'ice':     handleICE(msg.peerId, msg.ice); break;
      case 'peer-left':
        if (screenSharerId === msg.peerId) { screenSharerId = null; revertLayout(); }
        appendSystemMsg(displayName(msg.peerId) + ' left');
        removePeer(msg.peerId);
        break;
      case 'screen-share-start':
        screenSharerId = msg.peerId;
        updateScreenBtn();
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
      case 'media-state':
        peerMediaState[msg.peerId] = { audio: msg.audio, video: msg.video };
        updateMediaIndicators(msg.peerId);
        break;
      case 'reaction':
        handleReaction(msg.peerId, msg.emoji, msg.raised);
        break;
      case 'server-shutdown':
        serverShutdown = true;
        appendSystemMsg('Server is shutting down...');
        break;
    }
  };

  ws.onclose = (e) => {
    console.log('WS closed', e.code, e.reason);
    // If connection was rejected (bad password)
    if (!myId && e.code === 4001) {
      showError('Invalid room password.');
      leaveRoom();
      return;
    }
    if (!myId && e.code !== 1000) {
      showError('Connection rejected. Check the room password.');
      leaveRoom();
      return;
    }
    // Don't reconnect on intentional leave or server shutdown
    if (intentionalLeave || serverShutdown) return;
    // Try to reconnect
    attemptReconnect();
  };
}

// ── Reconnection (Prompt 4) ─────────────────────────────────────────────────

function attemptReconnect() {
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    showReconnectBanner('Connection lost.', true);
    return;
  }
  reconnectAttempts++;
  const delay = Math.min(1000 * Math.pow(2, reconnectAttempts - 1), 30000);
  showReconnectBanner(`Reconnecting (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`, false);
  reconnectTimer = setTimeout(() => {
    // Clean up old peer connections
    for (const peerId in peers) {
      peers[peerId].pc.close();
      delete peers[peerId];
      document.getElementById('video-' + peerId)?.remove();
      document.getElementById('video-screen-' + peerId)?.remove();
    }
    connectSignaling();
  }, delay);
}

function showReconnectBanner(text, showRetry) {
  const banner = document.getElementById('reconnect-banner');
  if (!banner) return;
  banner.querySelector('.reconnect-text').textContent = text;
  const retryBtn = banner.querySelector('.reconnect-retry');
  if (retryBtn) retryBtn.classList.toggle('hidden', !showRetry);
  banner.classList.remove('hidden');
}

function hideReconnectBanner() {
  const banner = document.getElementById('reconnect-banner');
  if (banner) banner.classList.add('hidden');
}

function manualReconnect() {
  reconnectAttempts = 0;
  hideReconnectBanner();
  for (const peerId in peers) {
    peers[peerId].pc.close();
    delete peers[peerId];
    document.getElementById('video-' + peerId)?.remove();
  }
  connectSignaling();
}

// ── Network change detection (Prompt 18) ────────────────────────────────────

window.addEventListener('online', () => {
  if (!ws || ws.readyState === WebSocket.CLOSED) {
    attemptReconnect();
  }
});

if (navigator.connection) {
  navigator.connection.addEventListener('change', () => {
    if (!ws || ws.readyState === WebSocket.CLOSED) {
      attemptReconnect();
    } else if (ws.readyState === WebSocket.OPEN) {
      // ICE restart on all connections
      for (const peerId of Object.keys(peers)) {
        triggerICERestart(peerId);
      }
    }
  });
}

// ── Error display ───────────────────────────────────────────────────────────

function showError(text) {
  const el = document.getElementById('error-msg');
  el.textContent = text;
  el.style.display = 'block';
}

function broadcastToAll(obj) {
  for (const peerId of Object.keys(peers))
    ws.send(JSON.stringify({ ...obj, targetId: peerId }));
}

// ── Peer connections ────────────────────────────────────────────────────────

function createPeerConnection(peerId, shouldOffer) {
  if (peers[peerId]) return peers[peerId].pc;

  const pc = new RTCPeerConnection({ iceServers });
  peers[peerId] = {
    pc,
    camStream: new MediaStream(),
    screenStream: new MediaStream(),
    camStreamId: null,
    iceRestartCount: 0,
  };

  for (const track of localStream.getTracks()) pc.addTrack(track, localStream);

  pc.ontrack = (event) => {
    const peer = peers[peerId];
    const track = event.track;
    const incomingStreamId = (event.streams && event.streams[0]) ? event.streams[0].id : null;
    console.log(`[${shortId(peerId)}] ontrack kind=${track.kind} streamId=${incomingStreamId} camStreamId=${peer.camStreamId}`);

    // If streams are not provided (WebView), treat all tracks as camera
    const noStreams = !event.streams || event.streams.length === 0;

    if (peer.camStreamId === null && incomingStreamId !== null) {
      peer.camStreamId = incomingStreamId;
    }

    if (noStreams || incomingStreamId === peer.camStreamId) {
      peer.camStream.addTrack(track);
      addVideoElement(peerId, peer.camStream, displayName(peerId));
      if (peerMediaState[peerId]) updateMediaIndicators(peerId);
    } else {
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

  // ICE restart on failure (Prompt 5)
  let disconnectedTimer = null;
  pc.oniceconnectionstatechange = () => {
    const state = pc.iceConnectionState;
    console.log(`[${shortId(peerId)}] iceConnectionState: ${state}`);
    if (state === 'failed') {
      triggerICERestart(peerId);
    } else if (state === 'disconnected') {
      disconnectedTimer = setTimeout(() => triggerICERestart(peerId), 5000);
    } else {
      if (disconnectedTimer) { clearTimeout(disconnectedTimer); disconnectedTimer = null; }
      if (state === 'connected') {
        if (peers[peerId]) peers[peerId].iceRestartCount = 0;
      }
    }
  };

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

  // Start quality monitoring
  startQualityMonitor(peerId, pc);

  return pc;
}

function triggerICERestart(peerId) {
  const peer = peers[peerId];
  if (!peer) return;
  if (peer.iceRestartCount >= 3) {
    console.log(`[${shortId(peerId)}] max ICE restarts reached, cleaning up`);
    removePeer(peerId);
    return;
  }
  peer.iceRestartCount++;
  console.log(`[${shortId(peerId)}] ICE restart attempt ${peer.iceRestartCount}`);
  peer.pc.restartIce();
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
  delete peerMediaState[peerId];
  delete peerNames[peerId];
  delete guestNumbers[peerId];
  delete prevAudioEnergy[peerId];
  updateGrid();
}

// ── Connection quality (Prompt 11) ──────────────────────────────────────────

function startQualityMonitor(peerId, pc) {
  const interval = setInterval(async () => {
    if (!peers[peerId] || pc.connectionState === 'closed') {
      clearInterval(interval);
      return;
    }
    try {
      const stats = await pc.getStats();
      let rtt = null, packetsLost = 0, jitter = null;
      stats.forEach(report => {
        if (report.type === 'candidate-pair' && report.state === 'succeeded') {
          rtt = report.currentRoundTripTime;
        }
        if (report.type === 'inbound-rtp' && report.kind === 'video') {
          packetsLost = report.packetsLost || 0;
          jitter = report.jitter;
        }
      });
      const quality = getQualityLevel(rtt, packetsLost, jitter);
      updateQualityIndicator(peerId, quality);
      autoAdaptQuality();
    } catch (e) {}
  }, 3000);
}

function getQualityLevel(rtt, packetsLost, jitter) {
  if (rtt === null) return 'unknown';
  if (rtt < 0.1 && packetsLost < 10) return 'good';
  if (rtt < 0.3 && packetsLost < 50) return 'fair';
  return 'poor';
}

function updateQualityIndicator(peerId, quality) {
  const container = document.getElementById('video-' + peerId);
  if (!container) return;
  let dot = container.querySelector('.quality-dot');
  if (!dot) {
    dot = document.createElement('div');
    dot.className = 'quality-dot';
    container.appendChild(dot);
  }
  dot.className = 'quality-dot quality-' + quality;
}

// ── Screen sharing ──────────────────────────────────────────────────────────

async function startScreenShare() {
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  } catch (err) { console.log('Screen share cancelled:', err.message); return; }

  screenStream = stream;
  const screenTrack = stream.getVideoTracks()[0];

  screenTrack.onended = () => {
    if (document.hidden) {
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

// ── Chat ────────────────────────────────────────────────────────────────────

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
  appendChatMsg('me', myName || 'You', text);
  broadcastToAll({ type: 'chat', text });
}

function receiveChat(peerId, text) {
  const senderName = displayName(peerId);
  appendChatMsg('them', senderName, text);
  if (!chatOpen) {
    unreadCount++;
    updateChatBadge();
  }
  playNotification('chat');
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

function downloadChat() {
  const msgs = document.getElementById('chat-messages');
  const lines = [];
  msgs.querySelectorAll('.chat-msg, .chat-system').forEach(el => {
    if (el.classList.contains('chat-system')) {
      lines.push('--- ' + el.textContent.trim() + ' ---');
    } else {
      const sender = el.querySelector('.sender')?.textContent || '';
      const text = el.querySelector('.bubble')?.textContent || '';
      const ts = el.querySelector('.ts')?.textContent || '';
      lines.push(`[${ts}] ${sender}: ${text}`);
    }
  });
  if (lines.length === 0) return;
  const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'chat-' + (roomName || 'room') + '.txt';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ── Notifications (Prompt 12) ───────────────────────────────────────────────

function playNotification(kind) {
  if (!document.hidden) return;
  try {
    if (!audioCtx) audioCtx = new AudioContext();
    if (audioCtx.state === 'suspended') {
      audioCtx.resume();
      return;
    }
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    gain.gain.value = 0.15;
    if (kind === 'join') {
      osc.frequency.value = 880;
      osc.type = 'sine';
      osc.start();
      osc.stop(audioCtx.currentTime + 0.15);
    } else {
      osc.frequency.value = 660;
      osc.type = 'sine';
      osc.start();
      osc.stop(audioCtx.currentTime + 0.1);
    }
  } catch (e) {}
}


// ── Reactions (Prompt 13) ───────────────────────────────────────────────────

let handRaised = false;

function toggleHand() {
  handRaised = !handRaised;
  broadcastToAll({ type: 'reaction', emoji: '✋', raised: handRaised });
  // Show on own video
  handleReaction(myId || 'local', '✋', handRaised);
  const btn = document.getElementById('btn-hand');
  btn.classList.toggle('active', handRaised);
}

function sendReaction(emoji) {
  broadcastToAll({ type: 'reaction', emoji, raised: false });
  handleReaction(myId || 'local', emoji, false);
}

function handleReaction(peerId, emoji, raised) {
  const videoId = peerId === myId ? 'local' : peerId;
  const container = document.getElementById('video-' + videoId);
  if (!container) return;

  if (emoji === '✋') {
    let handEl = container.querySelector('.hand-indicator');
    if (raised || raised === undefined) {
      if (!handEl) {
        handEl = document.createElement('div');
        handEl.className = 'hand-indicator';
        handEl.textContent = '✋';
        container.appendChild(handEl);
      }
    } else {
      if (handEl) handEl.remove();
    }
    if (!raised && raised !== undefined) return;
  }

  // Floating animation for all reactions — randomize position slightly
  const float = document.createElement('div');
  float.className = 'reaction-float';
  float.textContent = emoji;
  float.style.left = (8 + Math.random() * 40) + 'px';
  float.style.bottom = (8 + Math.random() * 20) + 'px';
  container.appendChild(float);
  setTimeout(() => float.remove(), 3000);

  // Also show on the screen-share featured area if active
  const screenFeatured = document.getElementById('screen-featured');
  const screenLayout = document.getElementById('screen-layout');
  if (screenFeatured && screenLayout && !screenLayout.classList.contains('hidden')) {
    const screenFloat = document.createElement('div');
    screenFloat.className = 'reaction-float';
    screenFloat.textContent = emoji;
    screenFloat.style.left = (8 + Math.random() * 60) + 'px';
    screenFloat.style.bottom = (8 + Math.random() * 30) + 'px';
    screenFeatured.appendChild(screenFloat);
    setTimeout(() => screenFloat.remove(), 3000);
  }
}

// ── Media state indicators (Prompt 8) ───────────────────────────────────────

function updateMediaIndicators(peerId) {
  const container = document.getElementById('video-' + peerId);
  if (!container) return;
  const state = peerMediaState[peerId];
  if (!state) return;

  let indicators = container.querySelector('.media-indicators');
  if (!indicators) {
    indicators = document.createElement('div');
    indicators.className = 'media-indicators';
    container.appendChild(indicators);
  }

  indicators.innerHTML = '';
  if (!state.audio) {
    const icon = document.createElement('span');
    icon.className = 'media-icon';
    icon.textContent = '🔇';
    icon.title = 'Muted';
    indicators.appendChild(icon);
  }
  if (!state.video) {
    const icon = document.createElement('span');
    icon.className = 'media-icon media-icon-off';
    icon.textContent = '📷';
    icon.title = 'Camera off';
    indicators.appendChild(icon);
  }
}

// ── Layout ──────────────────────────────────────────────────────────────────

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
  const label = displayName(peerId);
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

// ── UI helpers ──────────────────────────────────────────────────────────────

function displayName(peerId) {
  if (peerNames[peerId]) return peerNames[peerId];
  if (!guestNumbers[peerId]) {
    guestCounter++;
    guestNumbers[peerId] = guestCounter;
  }
  return guestCounter === 1 ? 'Guest' : 'Guest ' + guestNumbers[peerId];
}

function updatePeerLabel(peerId) {
  const el = document.getElementById('video-' + peerId);
  if (el) el.querySelector('.video-label').textContent = peerNames[peerId] || displayName(peerId);
}

function addVideoElement(id, stream, label, muted = false) {
  if (document.getElementById('video-' + id)) return;

  const container = document.createElement('div');
  container.className = 'video-container';
  container.id = 'video-' + id;

  const video = document.createElement('video');
  video.autoplay = true;
  video.playsInline = true;
  video.setAttribute('playsinline', '');
  video.setAttribute('autoplay', '');
  video.setAttribute('webkit-playsinline', '');
  if (muted) video.muted = true;
  video.srcObject = stream;

  // Double-click for fullscreen (Prompt 16)
  video.addEventListener('dblclick', () => {
    if (container.requestFullscreen) container.requestFullscreen();
    else if (container.webkitRequestFullscreen) container.webkitRequestFullscreen();
  });

  const labelEl = document.createElement('div');
  labelEl.className = 'video-label';
  labelEl.textContent = label;

  container.appendChild(video);
  container.appendChild(labelEl);

  // PiP button (Prompt 15)
  if (document.pictureInPictureEnabled && !muted) {
    const pipBtn = document.createElement('button');
    pipBtn.className = 'pip-btn';
    pipBtn.textContent = '⧉';
    pipBtn.title = 'Picture-in-Picture';
    pipBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      video.requestPictureInPicture().catch(() => {});
    });
    container.appendChild(pipBtn);
  }

  const inScreenLayout = !document.getElementById('screen-layout').classList.contains('hidden');
  if (inScreenLayout) {
    document.getElementById('tile-strip').appendChild(container);
  } else {
    document.getElementById('video-grid').appendChild(container);
    updateGrid();
  }

  // Play after DOM insertion (WebView compat)
  video.play().catch(() => {});
  stream.addEventListener('addtrack', () => { video.play().catch(() => {}); });
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

function applyViewportHeight() {
  const vv = window.visualViewport;
  const top = vv ? vv.offsetTop : 0;
  const h   = vv ? vv.height    : window.innerHeight;

  document.body.style.height    = h + 'px';
  document.body.style.maxHeight = h + 'px';

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

function setBtnContent(btn, emoji, label) {
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
  broadcastToAll({ type: 'media-state', audio: micEnabled, video: camEnabled });
}

function toggleCam() {
  camEnabled = !camEnabled;
  localStream.getVideoTracks().forEach(t => t.enabled = camEnabled);
  const btn = document.getElementById('btn-cam');
  setBtnContent(btn, '📷', camEnabled ? 'Hide' : 'Show');
  btn.classList.toggle('btn-crossed', !camEnabled);
  btn.classList.toggle('active', !camEnabled);
  broadcastToAll({ type: 'media-state', audio: micEnabled, video: camEnabled });
}

function leaveRoom() {
  intentionalLeave = true;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (screenStream) stopScreenShare();
  if (ws) ws.close();
  for (const peerId in peers) { peers[peerId].pc.close(); delete peers[peerId]; }
  if (localStream) localStream.getTracks().forEach(t => t.stop());
  localStream = null;
  for (const k in peerNames) delete peerNames[k];
  for (const k in peerMediaState) delete peerMediaState[k];
  for (const k in guestNumbers) delete guestNumbers[k];
  guestCounter = 0;
  chatOpen = false;
  unreadCount = 0;
  handRaised = false;
  myId = null;
  hasCam = false;
  hasMic = false;
  if (speakerCheckInterval) { clearInterval(speakerCheckInterval); speakerCheckInterval = null; }
  currentSpeaker = null;
  localAnalyser = null;
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
  document.getElementById('btn-hand').classList.remove('active');
  document.getElementById('landing').classList.remove('hidden');
  hideReconnectBanner();
  // Reset preview
  const previewArea = document.getElementById('preview-area');
  if (previewArea) previewArea.classList.add('hidden');
  const previewBtn = document.getElementById('preview-btn');
  if (previewBtn) previewBtn.classList.remove('hidden');
  const previewControls = document.getElementById('preview-controls');
  if (previewControls) previewControls.classList.add('hidden');
}

// ── Settings / bandwidth adaptation ─────────────────────────────────────────

let qualityMode = 'auto'; // 'auto' | 'high' | 'low' | 'speaker'
let speakerCheckInterval = null;
let currentSpeaker = null;

function toggleSettings() {
  const modal = document.getElementById('settings-modal');
  modal.classList.toggle('hidden');
  if (!modal.classList.contains('hidden')) {
    document.getElementById('setting-quality').value = qualityMode;
    populateDeviceSelectors();
  }
}

function applyQualityMode(mode) {
  qualityMode = mode;
  localStorage.setItem('videochat-quality', mode);

  // When leaving speaker mode, show all peer videos again
  if (mode !== 'speaker' && currentSpeaker) {
    currentSpeaker = null;
    document.querySelectorAll('#video-grid .video-container').forEach(el => {
      el.style.display = '';
    });
  }

  // Ensure speaker detection is running for speaking indicators
  startSpeakerDetection();

  // Apply bitrate constraints to all peer connections
  applyBitrateToAll(mode);
}

function applyBitrateToAll(mode) {
  const maxBitrate = mode === 'low' ? 150000 : mode === 'high' ? 2500000 : 0; // 0 = no limit (auto)
  for (const peerId of Object.keys(peers)) {
    const senders = peers[peerId].pc.getSenders();
    for (const sender of senders) {
      if (!sender.track || sender.track.kind !== 'video') continue;
      try {
        const params = sender.getParameters();
        if (!params.encodings || params.encodings.length === 0) continue;
        if (maxBitrate > 0) {
          params.encodings[0].maxBitrate = maxBitrate;
        } else {
          delete params.encodings[0].maxBitrate;
        }
        sender.setParameters(params);
      } catch (e) {}
    }
  }
}

const prevAudioEnergy = {};

function startSpeakerDetection() {
  if (speakerCheckInterval) return;
  speakerCheckInterval = setInterval(async () => {
    let loudest = null;
    let loudestLevel = 0;
    const speakingPeers = new Set();

    for (const peerId of Object.keys(peers)) {
      try {
        const stats = await peers[peerId].pc.getStats();
        let peerLevel = 0;
        stats.forEach(report => {
          // audioLevel on inbound-rtp or media-playout
          if (report.kind === 'audio' && report.audioLevel != null) {
            peerLevel = Math.max(peerLevel, report.audioLevel);
          }
          // Fallback: derive level from totalAudioEnergy delta
          if (report.type === 'inbound-rtp' && report.kind === 'audio' &&
              report.totalAudioEnergy != null && report.totalSamplesDuration != null) {
            const prev = prevAudioEnergy[peerId] || { energy: 0, duration: 0 };
            const dEnergy = report.totalAudioEnergy - prev.energy;
            const dDuration = report.totalSamplesDuration - prev.duration;
            prevAudioEnergy[peerId] = { energy: report.totalAudioEnergy, duration: report.totalSamplesDuration };
            if (dDuration > 0) {
              const rmsLevel = Math.sqrt(dEnergy / dDuration);
              peerLevel = Math.max(peerLevel, rmsLevel);
            }
          }
        });
        if (peerLevel > 0.01) {
          speakingPeers.add(peerId);
          if (peerLevel > loudestLevel) {
            loudestLevel = peerLevel;
            loudest = peerId;
          }
        }
      } catch (e) {}
    }

    // Check local mic level
    if (localStream && micEnabled && localAnalyser) {
      const data = new Uint8Array(localAnalyser.fftSize);
      localAnalyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / data.length);
      if (rms > 0.01) speakingPeers.add('local');
    }

    // Update speaking indicators on all peer tiles
    document.querySelectorAll('#video-grid .video-container').forEach(el => {
      const id = el.id.replace('video-', '');
      const indicator = el.querySelector('.speaking-icon');
      if (speakingPeers.has(id)) {
        if (!indicator) {
          const icon = document.createElement('span');
          icon.className = 'speaking-icon';
          icon.textContent = '🔊';
          icon.title = 'Speaking';
          el.appendChild(icon);
        }
        // Auto-lower raised hand when speaking
        const handEl = el.querySelector('.hand-indicator');
        if (handEl) {
          handEl.remove();
          // If it's our own hand, also reset state and broadcast
          if (id === 'local' || id === myId) {
            handRaised = false;
            document.getElementById('btn-hand').classList.remove('active');
            broadcastToAll({ type: 'reaction', emoji: '✋', raised: false });
          }
        }
      } else if (indicator) {
        indicator.remove();
      }
    });

    // Speaker-only mode: show only the loudest speaker
    if (qualityMode === 'speaker' && loudest && loudest !== currentSpeaker) {
      currentSpeaker = loudest;
      document.querySelectorAll('#video-grid .video-container').forEach(el => {
        const id = el.id.replace('video-', '');
        el.style.display = (id === 'local' || id === loudest) ? '' : 'none';
      });
      updateGrid();
    }
  }, 1000);
}

function autoAdaptQuality() {
  if (qualityMode !== 'auto') return;
  // Check average quality across peers
  let poorCount = 0;
  const peerIds = Object.keys(peers);
  if (peerIds.length === 0) return;

  document.querySelectorAll('.quality-dot.quality-poor').forEach(() => poorCount++);
  const ratio = poorCount / Math.max(1, peerIds.length);

  if (ratio > 0.5) {
    applyBitrateToAll('low');
  } else {
    applyBitrateToAll('auto');
  }
}

// ── Device change listener ──────────────────────────────────────────────────

if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
  navigator.mediaDevices.addEventListener('devicechange', populateDeviceSelectors);
}

// ── Event listeners (Prompt 2 — no inline handlers) ─────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  // Landing page
  document.getElementById('join-btn')?.addEventListener('click', joinRoom);
  document.getElementById('preview-btn')?.addEventListener('click', startPreview);
  document.getElementById('preview-close-btn')?.addEventListener('click', closePreview);
  document.getElementById('copy-link')?.addEventListener('click', copyLink);

  // Room picker (no room in URL)
  document.getElementById('room-go-btn')?.addEventListener('click', joinNamedRoom);
  document.getElementById('room-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') joinNamedRoom();
  });

  // Landing inputs — Enter to join
  document.getElementById('name-input-inline')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      joinRoom();
    }
  });
  document.getElementById('password-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') joinRoom();
  });

  // Device selectors
  document.getElementById('audio-input-select')?.addEventListener('change', () => switchDevice('audio'));
  document.getElementById('video-input-select')?.addEventListener('change', () => switchDevice('video'));

  // Toolbar
  document.getElementById('btn-mic')?.addEventListener('click', toggleMic);
  document.getElementById('btn-cam')?.addEventListener('click', toggleCam);
  document.getElementById('btn-screen')?.addEventListener('click', toggleScreenShare);
  document.getElementById('btn-chat')?.addEventListener('click', toggleChat);
  document.getElementById('btn-leave')?.addEventListener('click', () => { location.href = '/'; });
  document.getElementById('btn-hand')?.addEventListener('click', toggleHand);
  document.getElementById('btn-heart')?.addEventListener('click', () => sendReaction('❤️'));
  document.getElementById('btn-settings')?.addEventListener('click', toggleSettings);
  document.getElementById('settings-close')?.addEventListener('click', toggleSettings);
  document.getElementById('setting-quality')?.addEventListener('change', (e) => applyQualityMode(e.target.value));
  document.getElementById('setting-audio-input')?.addEventListener('change', (e) => {
    switchDevice('audio', e.target.value);
    const joinSelect = document.getElementById('audio-input-select');
    if (joinSelect) joinSelect.value = e.target.value;
  });
  document.getElementById('setting-video-input')?.addEventListener('change', (e) => {
    switchDevice('video', e.target.value);
    const joinSelect = document.getElementById('video-input-select');
    if (joinSelect) joinSelect.value = e.target.value;
  });
  // Close modal on backdrop click
  document.getElementById('settings-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'settings-modal') toggleSettings();
  });

  // Reactions
  document.querySelectorAll('.reaction-btn').forEach(btn => {
    btn.addEventListener('click', () => sendReaction(btn.dataset.emoji));
  });

  // Chat
  document.getElementById('chat-close')?.addEventListener('click', toggleChat);
  document.getElementById('chat-download')?.addEventListener('click', downloadChat);
  document.getElementById('chat-send')?.addEventListener('click', sendChat);
  document.getElementById('chat-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendChat();
  });

  // Reconnect
  document.querySelector('.reconnect-retry')?.addEventListener('click', manualReconnect);

  // Preview mic/cam toggles
  document.getElementById('preview-mic-btn')?.addEventListener('click', () => {
    micEnabled = !micEnabled;
    if (localStream) localStream.getAudioTracks().forEach(t => t.enabled = micEnabled);
    const btn = document.getElementById('preview-mic-btn');
    btn.textContent = micEnabled ? '🎤 Mic On' : '🔇 Mic Off';
  });
  document.getElementById('preview-cam-btn')?.addEventListener('click', () => {
    camEnabled = !camEnabled;
    if (localStream) localStream.getVideoTracks().forEach(t => t.enabled = camEnabled);
    const btn = document.getElementById('preview-cam-btn');
    btn.textContent = camEnabled ? '📷 Cam On' : '📷 Cam Off';
  });

  // Warn before closing/navigating away while in a room
  window.addEventListener('beforeunload', (e) => {
    if (!intentionalLeave && ws && ws.readyState === WebSocket.OPEN) {
      e.preventDefault();
    }
  });

  // Init
  init();
});
