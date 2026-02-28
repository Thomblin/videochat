import { describe, test, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

// Load index.html into jsdom and eval app.js to get global functions
function loadApp() {
  const html = fs.readFileSync(path.join(__dirname, '../static/index.html'), 'utf-8');
  document.documentElement.innerHTML = html;

  // Stub browser APIs that app.js uses on load
  delete window.location;
  window.location = {
    pathname: '/testroom',
    protocol: 'https:',
    host: 'localhost:8083',
    href: 'https://localhost:8083/testroom',
  };

  // Stub fetch (room-info check on load)
  window.fetch = vi.fn(() =>
    Promise.resolve({ json: () => Promise.resolve({ needsPassword: false }) })
  );

  // Stub navigator.clipboard
  navigator.clipboard = { writeText: vi.fn(() => Promise.resolve()) };

  // Stub MediaStream/AudioContext for makeDummyStream
  window.MediaStream = class {
    constructor(tracks = []) { this._tracks = tracks; }
    getTracks() { return this._tracks; }
    getVideoTracks() { return this._tracks.filter(t => t.kind === 'video'); }
    getAudioTracks() { return this._tracks.filter(t => t.kind === 'audio'); }
    addTrack(t) { this._tracks.push(t); }
  };

  window.AudioContext = class {
    createMediaStreamDestination() {
      return { stream: new MediaStream([{ kind: 'audio', enabled: true }]) };
    }
  };

  // Stub canvas captureStream
  HTMLCanvasElement.prototype.captureStream = function () {
    return new MediaStream([{ kind: 'video', enabled: true, readyState: 'live' }]);
  };

  // Stub visualViewport
  if (!window.visualViewport) {
    window.visualViewport = {
      height: 800,
      offsetTop: 0,
      addEventListener: vi.fn(),
    };
  }

  // Stub matchMedia (used by applyViewportHeight)
  window.matchMedia = vi.fn(() => ({
    matches: false,
    addEventListener: vi.fn(),
  }));

  const appJs = fs.readFileSync(path.join(__dirname, '../static/app.js'), 'utf-8');
  // Indirect eval runs in global scope, making function declarations available on window
  (0, eval)(appJs);
}

describe('app.js', () => {
  beforeEach(() => {
    loadApp();
  });

  // --- Pure functions ---

  describe('escapeHtml', () => {
    test('escapes &, <, >', () => {
      expect(window.escapeHtml('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d');
    });

    test('returns plain strings unchanged', () => {
      expect(window.escapeHtml('hello world')).toBe('hello world');
    });

    test('handles empty string', () => {
      expect(window.escapeHtml('')).toBe('');
    });

    test('escapes multiple occurrences', () => {
      expect(window.escapeHtml('<<>>')).toBe('&lt;&lt;&gt;&gt;');
    });
  });

  describe('shortId', () => {
    test('returns last 8 chars', () => {
      expect(window.shortId('peer-abcdef1234567890')).toBe('34567890');
    });

    test('handles exactly 8 chars', () => {
      expect(window.shortId('12345678')).toBe('12345678');
    });

    test('handles short string', () => {
      expect(window.shortId('abc')).toBe('abc');
    });
  });

  // --- DOM-dependent functions ---

  describe('updateChatBadge (via receiveChat)', () => {
    // unreadCount and chatOpen are `let` variables scoped to the eval'd app.js,
    // so we test badge behavior through receiveChat which naturally modifies them.
    test('shows badge after receiving chat while closed', () => {
      window.receiveChat('peer-12345678', 'hello');

      const badge = document.getElementById('chat-badge');
      expect(badge.textContent).toBe('1');
      expect(badge.classList.contains('visible')).toBe(true);
    });

    test('increments badge count', () => {
      window.receiveChat('peer-12345678', 'one');
      window.receiveChat('peer-12345678', 'two');
      window.receiveChat('peer-12345678', 'three');

      const badge = document.getElementById('chat-badge');
      expect(badge.textContent).toBe('3');
      expect(badge.classList.contains('visible')).toBe(true);
    });

    test('hides badge when no unread', () => {
      // Initially unreadCount=0, chatOpen=false
      window.updateChatBadge();

      const badge = document.getElementById('chat-badge');
      expect(badge.classList.contains('visible')).toBe(false);
    });
  });

  describe('appendChatMsg', () => {
    test('appends message with sender and text', () => {
      window.appendChatMsg('them', 'Alice', 'Hi there');

      const msgs = document.getElementById('chat-messages');
      const last = msgs.lastElementChild;
      expect(last.classList.contains('chat-msg')).toBe(true);
      expect(last.querySelector('.sender').textContent).toBe('Alice');
      expect(last.querySelector('.bubble').textContent).toBe('Hi there');
    });

    test('adds mine class for own messages', () => {
      window.appendChatMsg('me', 'You', 'Hello');

      const msgs = document.getElementById('chat-messages');
      const last = msgs.lastElementChild;
      expect(last.classList.contains('mine')).toBe(true);
    });

    test('escapes HTML in sender and text', () => {
      window.appendChatMsg('them', '<b>Evil</b>', '<script>alert(1)</script>');

      const msgs = document.getElementById('chat-messages');
      const last = msgs.lastElementChild;
      expect(last.querySelector('.sender').innerHTML).toContain('&lt;b&gt;');
      expect(last.querySelector('.bubble').innerHTML).toContain('&lt;script&gt;');
    });

    test('includes timestamp', () => {
      window.appendChatMsg('them', 'Bob', 'test');

      const msgs = document.getElementById('chat-messages');
      const ts = msgs.lastElementChild.querySelector('.ts');
      expect(ts).not.toBeNull();
      expect(ts.textContent).toMatch(/^\d{2}:\d{2}$/);
    });
  });

  describe('appendSystemMsg', () => {
    test('appends system message', () => {
      window.appendSystemMsg('User left');

      const msgs = document.getElementById('chat-messages');
      const last = msgs.lastElementChild;
      expect(last.classList.contains('chat-system')).toBe(true);
      expect(last.textContent).toBe('User left');
    });
  });

  describe('setBtnContent', () => {
    test('updates emoji and label span', () => {
      const btn = document.getElementById('btn-mic');
      window.setBtnContent(btn, '🔇', 'Unmute');

      const span = btn.querySelector('.btn-label');
      expect(span.textContent).toBe(' Unmute');
      expect(btn.childNodes[0].textContent).toBe('🔇');
    });

    test('falls back to textContent when no span', () => {
      const btn = document.createElement('button');
      btn.textContent = 'old';
      window.setBtnContent(btn, '🎤', 'Mute');
      expect(btn.textContent).toBe('🎤 Mute');
    });
  });

  describe('showError', () => {
    test('displays error message', () => {
      window.showError('Something went wrong');

      const el = document.getElementById('error-msg');
      expect(el.textContent).toBe('Something went wrong');
      expect(el.style.display).toBe('block');
    });
  });
});
