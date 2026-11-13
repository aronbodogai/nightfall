// Nightfall on Cloudflare Workers: static assets + one Durable Object per room acting as the
// WebSocket relay (same protocol as server.js). Uses the WebSocket Hibernation API so idle rooms cost nothing.
import { DurableObject } from 'cloudflare:workers';

const ROOM_TTL_MS = 24 * 3600 * 1000;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
const randomHex = (bytes) => [...crypto.getRandomValues(new Uint8Array(bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
const randomCode = () => [...crypto.getRandomValues(new Uint8Array(4))].map(b => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
const roomStub = (env, code) => env.ROOMS.get(env.ROOMS.idFromName(code));

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/info') return json({ addresses: [], port: null, cloud: true });
    if (url.pathname === '/api/rooms' && request.method === 'POST') {
      for (let i = 0; i < 8; i++) {
        const code = randomCode();
        const hostToken = randomHex(8);
        const res = await roomStub(env, code).fetch('https://room/init', { method: 'POST', body: JSON.stringify({ code, hostToken }) });
        if (res.status === 200) return json({ room: code, hostToken });
      }
      return json({ error: 'Could not allocate a room code, try again.' }, 503);
    }
    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected WebSocket', { status: 426 });
      const code = (url.searchParams.get('room') || '').toUpperCase();
      if (!/^[A-Z]{4}$/.test(code)) return new Response('Bad room code', { status: 400 });
      return roomStub(env, code).fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
};

export class Room extends DurableObject {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/init') {
      if (await this.ctx.storage.get('meta')) return new Response('taken', { status: 409 });
      const { code, hostToken } = await request.json();
      await this.ctx.storage.put({ meta: { code, hostToken, created: Date.now() }, players: {}, locked: false });
      await this.ctx.storage.setAlarm(Date.now() + ROOM_TTL_MS);
      return new Response('ok');
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ role: null });
    return new Response(null, { status: 101, webSocket: client });
  }

  // ---------- helpers ----------
  send(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch { /* socket gone */ } }
  sockets(except) {
    return this.ctx.getWebSockets().filter(ws => ws !== except && ws.readyState === 1)
      .map(ws => ({ ws, att: ws.deserializeAttachment() || {} }));
  }
  hosts(except) { return this.sockets(except).filter(s => s.att.role === 'host').map(s => s.ws); }
  playerSockets(pid, except) { return this.sockets(except).filter(s => s.att.role === 'player' && s.att.pid === pid).map(s => s.ws); }
  async presence(except) {
    const players = (await this.ctx.storage.get('players')) || {};
    const online = new Set(this.sockets(except).filter(s => s.att.role === 'player').map(s => s.att.pid));
    return Object.values(players).map(p => ({ pid: p.pid, name: p.name, connected: online.has(p.pid) }));
  }
  async pushPresence(except) {
    const players = await this.presence(except);
    for (const ws of this.hosts(except)) this.send(ws, { t: 'presence', players });
  }
  hostStatus(except) {
    const online = this.hosts(except).length > 0;
    for (const s of this.sockets(except)) if (s.att.role === 'player') this.send(s.ws, { t: 'host_status', online });
  }

  // ---------- messages ----------
  async webSocketMessage(ws, data) {
    let m; try { m = JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data)); } catch { return; }
    if (!m || typeof m.t !== 'string') return;
    const meta = await this.ctx.storage.get('meta');
    if (!meta) { this.send(ws, { t: 'error', code: 'no_room', msg: 'No game with that code.' }); return ws.close(4004, 'no room'); }
    const att = ws.deserializeAttachment() || {};

    if (m.t === 'host_resume') {
      if (m.hostToken !== meta.hostToken) { this.send(ws, { t: 'error', code: 'no_room', msg: 'Not the host of this room.' }); return; }
      for (const other of this.hosts(ws)) { try { other.close(4000, 'replaced'); } catch { /* ignore */ } }
      ws.serializeAttachment({ role: 'host' });
      this.send(ws, { t: 'resumed', room: meta.code, players: await this.presence() });
      this.hostStatus();
      await this.ctx.storage.setAlarm(Date.now() + ROOM_TTL_MS);
      return;
    }
    if (att.role === 'host') {
      if (m.t === 'state') { await this.ctx.storage.put('locked', !!(m.state && m.state.locked)); return; }
      if (m.t === 'views') {
        const players = (await this.ctx.storage.get('players')) || {};
        const puts = {};
        for (const [pid, view] of Object.entries(m.views || {})) {
          if (!players[pid]) continue;
          puts['view:' + pid] = view;
          for (const pws of this.playerSockets(pid)) this.send(pws, { t: 'view', view });
        }
        if (Object.keys(puts).length) await this.ctx.storage.put(puts);
        return;
      }
      if (m.t === 'kick') {
        const players = (await this.ctx.storage.get('players')) || {};
        for (const pws of this.playerSockets(m.pid)) { this.send(pws, { t: 'kicked' }); try { pws.close(4001, 'kicked'); } catch { /* ignore */ } }
        delete players[m.pid];
        await this.ctx.storage.put('players', players);
        await this.ctx.storage.delete('view:' + m.pid);
        return this.pushPresence();
      }
      return;
    }

    if (m.t === 'join') {
      const players = (await this.ctx.storage.get('players')) || {};
      let p = m.token && Object.values(players).find(x => x.token === m.token);
      if (!p) {
        const name = String(m.name || '').trim().slice(0, 24);
        if (!name) return this.send(ws, { t: 'error', code: 'no_name', msg: 'Enter a name.' });
        if (await this.ctx.storage.get('locked')) return this.send(ws, { t: 'error', code: 'locked', msg: 'Game already started.' });
        if (Object.keys(players).length >= 20) return this.send(ws, { t: 'error', code: 'full', msg: 'Room is full.' });
        p = { pid: randomHex(4), name, token: randomHex(8) };
        players[p.pid] = p;
        await this.ctx.storage.put('players', players);
      }
      for (const old of this.playerSockets(p.pid, ws)) { try { old.close(4000, 'replaced'); } catch { /* ignore */ } }
      ws.serializeAttachment({ role: 'player', pid: p.pid });
      this.send(ws, { t: 'joined', pid: p.pid, token: p.token, room: meta.code, name: p.name });
      this.send(ws, { t: 'host_status', online: this.hosts().length > 0 });
      const view = await this.ctx.storage.get('view:' + p.pid);
      if (view) this.send(ws, { t: 'view', view });
      return this.pushPresence();
    }
    if (att.role === 'player') {
      if (m.t === 'act') { for (const h of this.hosts()) this.send(h, { t: 'act', pid: att.pid, act: m.act }); return; }
      if (m.t === 'leave') {
        const players = (await this.ctx.storage.get('players')) || {};
        delete players[att.pid];
        await this.ctx.storage.put('players', players);
        await this.pushPresence(ws);
        try { ws.close(1000, 'left'); } catch { /* ignore */ }
      }
    }
  }

  async webSocketClose(ws) {
    const att = ws.deserializeAttachment() || {};
    if (att.role === 'host') this.hostStatus(ws);
    if (att.role === 'player') await this.pushPresence(ws);
  }
  async webSocketError(ws) { await this.webSocketClose(ws); }

  async alarm() {
    for (const ws of this.ctx.getWebSockets()) { try { ws.close(1001, 'room expired'); } catch { /* ignore */ } }
    await this.ctx.storage.deleteAll();
  }
}
