// Nightfall LAN server: static files + minimal WebSocket relay. No dependencies.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.webp': 'image/webp', '.md': 'text/markdown; charset=utf-8', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
};

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/info') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ addresses: lanAddresses(), port: PORT }));
  }
  if (url.pathname === '/api/rooms' && req.method === 'POST') {
    const room = { code: newCode(), hostToken: id(), host: null, state: null, players: new Map(), created: Date.now() };
    rooms.set(room.code, room);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ room: room.code, hostToken: room.hostToken }));
  }
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

// ---------- minimal WebSocket (RFC 6455) ----------
function wsAccept(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key) return socket.destroy();
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.setNoDelay(true);
  const conn = { socket, alive: true, onmessage: null, onclose: null, send, close };
  let buf = Buffer.alloc(0);
  let fragments = [];

  function frame(opcode, payload) {
    const len = payload.length;
    let header;
    if (len < 126) { header = Buffer.from([0x80 | opcode, len]); }
    else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(len, 2); }
    else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
    return Buffer.concat([header, payload]);
  }
  function send(obj) {
    if (!conn.alive) return;
    try { socket.write(frame(0x1, Buffer.from(JSON.stringify(obj)))); } catch { /* ignore */ }
  }
  // code: 4000 replaced by another tab/device, 4001 kicked (clients don't reconnect after these)
  function close(code) {
    if (!conn.alive) return;
    conn.alive = false;
    let payload = Buffer.alloc(0);
    if (code) { payload = Buffer.alloc(2); payload.writeUInt16BE(code, 0); }
    try { socket.end(frame(0x8, payload)); } catch { /* ignore */ }
    if (conn.onclose) conn.onclose();
  }
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const fin = (buf[0] & 0x80) !== 0;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (len > 4 * 1024 * 1024) return close();
      const maskOff = off; if (masked) off += 4;
      if (buf.length < off + len) return;
      let payload = buf.subarray(off, off + len);
      if (masked) {
        const mask = buf.subarray(maskOff, maskOff + 4);
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      }
      buf = buf.subarray(off + len);
      if (opcode === 0x8) return close();
      if (opcode === 0x9) { try { socket.write(frame(0xA, payload)); } catch { /* ignore */ } continue; }
      if (opcode === 0xA) continue;
      if (opcode === 0x1 || opcode === 0x0) {
        fragments.push(payload);
        if (!fin) continue;
        const text = Buffer.concat(fragments).toString('utf8');
        fragments = [];
        let msg; try { msg = JSON.parse(text); } catch { continue; }
        if (conn.onmessage) conn.onmessage(msg);
      }
    }
  });
  socket.on('close', () => { if (conn.alive) { conn.alive = false; if (conn.onclose) conn.onclose(); } });
  socket.on('error', () => socket.destroy());
  return conn;
}

// ---------- rooms ----------
// room: { code, hostToken, host: conn|null, state, players: Map<pid, {pid,name,token,conn,view}> }
const rooms = new Map();
const id = (n = 8) => crypto.randomBytes(n).toString('hex');
function newCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let c; do { c = Array.from({ length: 4 }, () => A[crypto.randomInt(A.length)]).join(''); } while (rooms.has(c));
  return c;
}
function presence(room) {
  return [...room.players.values()].map(p => ({ pid: p.pid, name: p.name, connected: !!(p.conn && p.conn.alive) }));
}
function toHost(room, msg) { if (room.host && room.host.alive) room.host.send(msg); }
function pushPresence(room) { toHost(room, { t: 'presence', players: presence(room) }); }
function hostStatus(room) {
  const online = !!(room.host && room.host.alive);
  for (const p of room.players.values()) if (p.conn) p.conn.send({ t: 'host_status', online });
}

server.on('upgrade', (req, socket) => {
  if ((req.headers.upgrade || '').toLowerCase() !== 'websocket') return socket.destroy();
  const conn = wsAccept(req, socket);
  if (!conn) return;
  let role = null; let room = null; let player = null;

  conn.onmessage = (m) => {
    if (!m || typeof m.t !== 'string') return;
    // ---- host ----
    if (m.t === 'host_resume') {
      const r = rooms.get(String(m.room || '').toUpperCase());
      if (!r || r.hostToken !== m.hostToken) return conn.send({ t: 'error', code: 'no_room', msg: 'Room not found on server.' });
      if (r.host && r.host !== conn) r.host.close(4000);
      room = r; room.host = conn; role = 'host';
      conn.send({ t: 'resumed', room: room.code, players: presence(room) });
      return hostStatus(room);
    }
    if (role === 'host' && room) {
      if (m.t === 'state') { room.state = m.state; return; }
      if (m.t === 'views') {
        for (const [pid, view] of Object.entries(m.views || {})) {
          const p = room.players.get(pid);
          if (!p) continue;
          p.view = view;
          if (p.conn) p.conn.send({ t: 'view', view });
        }
        return;
      }
      if (m.t === 'kick') {
        const p = room.players.get(m.pid);
        if (p) { if (p.conn) { p.conn.send({ t: 'kicked' }); p.conn.close(4001); } room.players.delete(m.pid); }
        return pushPresence(room);
      }
      if (m.t === 'rename') {
        const p = room.players.get(m.pid);
        if (p) p.name = String(m.name || '').slice(0, 24);
        return pushPresence(room);
      }
      return;
    }
    // ---- player ----
    if (m.t === 'join') {
      const r = rooms.get(String(m.room || '').toUpperCase().trim());
      if (!r) return conn.send({ t: 'error', code: 'no_room', msg: 'No game with that code.' });
      room = r; role = 'player';
      let p = m.token && [...r.players.values()].find(x => x.token === m.token);
      if (!p) {
        const name = String(m.name || '').trim().slice(0, 24);
        if (!name) return conn.send({ t: 'error', code: 'no_name', msg: 'Enter a name.' });
        // Joining a game in progress is allowed: the Storyteller may seat them as a Traveller.
        p = { pid: id(4), name, token: id(), conn: null, view: null, late: !!(r.state && r.state.locked) };
        r.players.set(p.pid, p);
      }
      if (p.conn && p.conn !== conn) p.conn.close(4000);
      p.conn = conn; player = p;
      conn.send({ t: 'joined', pid: p.pid, token: p.token, room: r.code, name: p.name, late: !!p.late });
      conn.send({ t: 'host_status', online: !!(r.host && r.host.alive) });
      if (p.view) conn.send({ t: 'view', view: p.view });
      return pushPresence(r);
    }
    if (role === 'player' && room && player) {
      if (m.t === 'act') return toHost(room, { t: 'act', pid: player.pid, act: m.act });
      if (m.t === 'leave') { room.players.delete(player.pid); pushPresence(room); return conn.close(); }
    }
  };
  conn.onclose = () => {
    if (!room) return;
    if (role === 'host' && room.host === conn) { room.host = null; hostStatus(room); }
    if (role === 'player' && player && player.conn === conn) { player.conn = null; pushPresence(room); }
  };
});

// keepalive + cleanup of abandoned rooms (12h)
setInterval(() => {
  const now = Date.now();
  for (const [code, r] of rooms) {
    const anyone = (r.host && r.host.alive) || [...r.players.values()].some(p => p.conn && p.conn.alive);
    if (!anyone && now - r.created > 12 * 3600e3) rooms.delete(code);
  }
}, 600e3);

server.listen(PORT, '0.0.0.0', () => {
  console.log('Nightfall server running.');
  console.log(`  Host (Storyteller):  http://localhost:${PORT}/host.html`);
  for (const a of lanAddresses()) console.log(`  Players on Wi-Fi:    http://${a}:${PORT}/`);
});
