// Reconnecting, room-scoped WebSocket client shared by host and player pages.
// Works against both the LAN Node server and the Cloudflare Worker (/ws?room=CODE).
window.Net = function (onMessage, onStatus) {
  // Close codes from the relay that must not trigger a reconnect: another tab/device took over this
  // seat (4000), kicked (4001), room gone (4004). Reconnecting after 4000 would kick the other tab,
  // which reconnects and kicks this one: an endless loop that burns the server's request quota.
  const STOP = { 4000: 'replaced', 4001: 'kicked', 4004: 'no_room' };
  let ws = null, room = null, queue = [], openHandlers = [], retry = 1000, timer = null, stable = null, paused = null;
  function connect() {
    clearTimeout(timer);
    if (!room || paused) return;
    const url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws?room=' + encodeURIComponent(room);
    const sock = new WebSocket(url);
    ws = sock;
    sock.onopen = () => {
      if (ws !== sock) return;
      clearTimeout(stable); stable = setTimeout(() => { retry = 1000; }, 15000); // reset backoff only once the link holds
      hideBanner(); onStatus && onStatus(true);
      openHandlers.forEach(h => h());
      const q = queue; queue = []; q.forEach(m => sock.send(JSON.stringify(m)));
    };
    sock.onmessage = (e) => { if (ws !== sock) return; let m; try { m = JSON.parse(e.data); } catch { return; } onMessage(m); };
    sock.onclose = (e) => {
      if (ws !== sock) return;
      clearTimeout(stable);
      onStatus && onStatus(false, STOP[e.code]);
      if (STOP[e.code]) { paused = STOP[e.code]; if (paused === 'replaced') showBanner(); return; }
      if (room) { timer = setTimeout(connect, retry * (0.75 + Math.random() / 2)); retry = Math.min(retry * 2, 30000); }
    };
    sock.onerror = () => { try { sock.close(); } catch { /* ignore */ } };
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && room && !paused && (!ws || ws.readyState > 1)) { retry = 1000; connect(); }
  });
  let banner = null;
  function showBanner() {
    if (!banner) {
      banner = document.createElement('div');
      banner.className = 'netbanner';
      banner.addEventListener('click', (e) => { if (e.target.closest('button')) resume(); });
      document.body.appendChild(banner);
    }
    const tr = window.t || (x => x);
    banner.innerHTML = '<span>' + esc(tr('This game is open in another tab or device.')) + '</span><button class="sm primary">' + esc(tr('Use it here')) + '</button>';
    banner.hidden = false;
  }
  function hideBanner() { if (banner) banner.hidden = true; }
  function resume() { paused = null; retry = 1000; hideBanner(); connect(); }
  return {
    connect(code) { if (code === room && ws && ws.readyState <= 1) return; this.disconnect(); room = code; retry = 1000; paused = null; connect(); },
    disconnect() { room = null; paused = null; hideBanner(); queue = []; clearTimeout(timer); if (ws) { const s = ws; ws = null; try { s.close(); } catch { /* ignore */ } } onStatus && onStatus(false); },
    send(m) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); else queue.push(m); },
    onOpen(h) { openHandlers.push(h); },
    get room() { return room; },
  };
};

window.esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
window.store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};
// Browsers only allow vibration after the user has interacted with the page.
window.vibrate = (p) => {
  try {
    if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return;
    if (navigator.vibrate) navigator.vibrate(p);
  } catch { /* ignore */ }
};
