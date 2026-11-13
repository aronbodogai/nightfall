// Reconnecting, room-scoped WebSocket client shared by host and player pages.
// Works against both the LAN Node server and the Cloudflare Worker (/ws?room=CODE).
window.Net = function (onMessage, onStatus) {
  let ws = null, room = null, queue = [], openHandlers = [], retry = 500, timer = null;
  function connect() {
    clearTimeout(timer);
    if (!room) return;
    const url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws?room=' + encodeURIComponent(room);
    const sock = new WebSocket(url);
    ws = sock;
    sock.onopen = () => {
      if (ws !== sock) return;
      retry = 500; onStatus && onStatus(true);
      openHandlers.forEach(h => h());
      const q = queue; queue = []; q.forEach(m => sock.send(JSON.stringify(m)));
    };
    sock.onmessage = (e) => { if (ws !== sock) return; let m; try { m = JSON.parse(e.data); } catch { return; } onMessage(m); };
    sock.onclose = () => {
      if (ws !== sock) return;
      onStatus && onStatus(false);
      if (room) { timer = setTimeout(connect, retry); retry = Math.min(retry * 2, 5000); }
    };
    sock.onerror = () => { try { sock.close(); } catch { /* ignore */ } };
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && room && (!ws || ws.readyState > 1)) connect();
  });
  return {
    connect(code) { if (code === room && ws && ws.readyState <= 1) return; this.disconnect(); room = code; retry = 500; connect(); },
    disconnect() { room = null; queue = []; clearTimeout(timer); if (ws) { const s = ws; ws = null; try { s.close(); } catch { /* ignore */ } } onStatus && onStatus(false); },
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
window.vibrate = (p) => { try { navigator.vibrate && navigator.vibrate(p); } catch { /* ignore */ } };
