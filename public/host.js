/* Nightfall — Storyteller (host). Holds the authoritative game state. */
'use strict';
const $app = document.getElementById('app');
const $tabs = document.getElementById('tabs');
const $sheet = document.getElementById('sheet');

let S = null;          // game state (persisted)
let presence = [];     // [{pid,name,connected}] from server
let tab = 'lobby';
let sheet = null;      // {type, ...}
let info = { addresses: [], port: location.port };
let online = false;
let creating = false;

const now = () => Date.now();
const shuffle = (a) => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const UNKNOWN_ROLE = { id: '?', name: 'Unknown', team: 'townsfolk', icon: '❔', ability: '' };
const role = (id) => ROLE[id] || Object.assign({}, UNKNOWN_ROLE, { id, name: String(id) });
const roleRef = (id) => R(role(id));

function freshState(room, hostToken) {
  return {
    v: 1, room, hostToken, locked: false, phase: 'lobby', day: 0, night: 0,
    seats: [], players: {}, selection: [], bluffs: [], steps: [], stepIdx: 0,
    nominations: [], vote: null, block: null, requests: [], executedToday: null, lastExecuted: null,
    debtorNight: false, dawn: null, winner: null, log: [], announce: '', promptSeq: 1,
    script: null,       // imported script (see script.js) or null = built-in set
    ghostVotes: true,   // official rule: each dead player keeps one vote for the rest of the game
    travellerPids: [],  // players who play a Traveller (chosen in the lobby, or late joiners)
    pending: [],        // late joiners waiting to be seated as Travellers
    fabledOn: [],       // ids of Fabled/Loric in play (public)
    exiledToday: [],    // Travellers already called for exile today
  };
}
// Travellers are selectable alongside the script's characters but never dealt from the bag.
function scriptTravellers() { return S && S.script ? S.script.travellers : (window.BASE_EXTRAS || []).filter(r => r.team === 'traveller'); }
function scriptFabled() { return S && S.script ? S.script.fabled : []; }
function applyScript() {
  setRoles([...(S && S.script ? S.script.roles : BASE_ROLES), ...scriptTravellers(), ...scriptFabled()]);
}
function migrate() {
  for (const k of ['travellerPids', 'pending', 'fabledOn', 'exiledToday']) if (!Array.isArray(S[k])) S[k] = [];
  if (S.ghostVotes === undefined) S.ghostVotes = true;
  if (S.script && !S.script.travellers) Object.assign(S.script, { travellers: [], fabled: [], jinxes: [], bootlegger: [], markers: { first: {}, other: {} } });
}

// ---------- networking ----------
const net = Net(onMsg, (on) => { online = on; document.getElementById('netdot').className = 'dot' + (on ? ' on' : ''); });
net.onOpen(() => {
  const saved = store.get('nf_host');
  if (saved && saved.room && saved.hostToken) net.send({ t: 'host_resume', room: saved.room, hostToken: saved.hostToken });
});
fetch('/api/info').then(r => r.json()).then(j => { info = j; render(); }).catch(() => {});
{
  const saved = store.get('nf_host');
  if (saved && saved.room) net.connect(saved.room);
}
mountLangPicker(document.getElementById('lang'));
onLangChange(() => render());

async function createRoom() {
  creating = true; render();
  try {
    const res = await fetch('/api/rooms', { method: 'POST' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const { room, hostToken } = await res.json();
    store.set('nf_host', { room, hostToken });
    store.del('nf_host_state');
    net.connect(room);
  } catch (e) {
    toast(t('Could not create a room: {err}', { err: e.message }));
  }
  creating = false; render();
}

function onMsg(m) {
  if (m.t === 'resumed') {
    const local = store.get('nf_host_state');
    S = (local && local.room === m.room) ? local : freshState(m.room, store.get('nf_host').hostToken);
    migrate();
    applyScript();
    presence = m.players || [];
    syncPresence();
    tab = S.locked ? (S.phase === 'day' ? 'day' : S.phase === 'night' ? 'night' : 'grim') : (S.phase === 'setup' ? 'setup' : 'lobby');
    save();
  } else if (m.t === 'error' && m.code === 'no_room') {
    // Room expired or server restarted: start over.
    net.disconnect();
    store.del('nf_host'); store.del('nf_host_state');
    toast(t('That room no longer exists on the server. Create a new one; players rejoin with the new code.'));
    S = null; render();
  } else if (m.t === 'presence') {
    presence = m.players; syncPresence(); save();
  } else if (m.t === 'act') {
    handleAct(m.pid, m.act || {});
  }
}

function syncPresence() {
  if (!S) return;
  for (const p of presence) {
    if (!S.players[p.pid]) {
      S.players[p.pid] = newPlayer(p.pid, p.name);
      // Before the game: seat them. During the game: they wait to be seated as a Traveller.
      if (!S.locked) S.seats.push(p.pid);
      else if (!S.pending.includes(p.pid)) { S.pending.push(p.pid); toast(t('{name} wants to join as a Traveller.', { name: p.name })); }
    }
    S.players[p.pid].name = p.name;
    S.players[p.pid].connected = p.connected;
  }
  if (!S.locked) {
    const ids = new Set(presence.map(p => p.pid));
    S.seats = S.seats.filter(id => ids.has(id));
    S.travellerPids = S.travellerPids.filter(id => ids.has(id));
    for (const id of Object.keys(S.players)) if (!ids.has(id)) delete S.players[id];
  } else {
    const ids = new Set(presence.map(p => p.pid));
    S.pending = S.pending.filter(id => ids.has(id));
  }
}
function newPlayer(pid, name) {
  return { pid, name, connected: true, role: null, fakeRole: null, alive: true, ghostVote: true,
    cursed: false, protected: false, sentinelUsed: false, luckyUsed: false, duelUsed: false, hollowUsed: false,
    nominated: false, wasNominated: false, msgs: [], prompt: null, evilInfo: null,
    alignment: null,   // null = from character type; 'good' | 'evil' set by the Storyteller (Travellers, alignment changes)
    drunk: false, poisoned: false, reminders: [], exiled: false };
}

// ---------- persistence + views ----------
function save() {
  if (!S) return render();
  store.set('nf_host_state', S);
  net.send({ t: 'state', state: { locked: S.locked, phase: S.phase } });
  net.send({ t: 'views', views: buildViews() });
  render();
}

function seatList() { return S.seats.map(id => S.players[id]).filter(Boolean); }
function alivePlayers() { return seatList().filter(p => p.alive); }
const threshold = () => Math.ceil(alivePlayers().length / 2);
const pname = (pid) => (S.players[pid] ? S.players[pid].name : '?');
const isTraveller = (p) => !!p && (S.travellerPids.includes(p.pid) || (p.role && role(p.role).team === 'traveller'));
// Alignment: a Storyteller override (Travellers, alignment changes) wins over the character type.
const isEvil = (p) => !!p && (p.alignment ? p.alignment === 'evil' : !!p.role && isEvilTeam(role(p.role).team));
const shownRole = (p) => p.fakeRole || p.role;
// Drunk or poisoned (incl. Hexer's curse), the Sleepwalker, or anyone set to "thinks they are" another character.
const malfunctioning = (p) => p.cursed || p.drunk || p.poisoned || p.role === 'sleepwalker' || (!!p.fakeRole && p.fakeRole !== p.role);
// Living players always vote; dead players only while they still hold their ghost vote (if that rule is on).
// Exile is not a vote: every player, alive or dead, may support it without spending anything.
const canVote = (p) => !!p && (p.alive || (S.ghostVotes !== false && p.ghostVote));
const canVoteOn = (p, v) => !!p && (v && v.kind === 'exile' ? true : canVote(p));
function tallyYes(v) {
  let n = 0;
  for (const [pid, yes] of Object.entries(v.votes)) { const p = S.players[pid]; if (yes && canVoteOn(p, v)) n += v.kind === 'exile' ? 1 : voteWeight(p); }
  return n;
}
// Exile needs at least half of all players (alive and dead); execution needs at least half of the living.
const exileThreshold = () => Math.ceil(seatList().length / 2);
const voteNeed = (v) => (v && v.kind === 'exile' ? exileThreshold() : threshold());
const roleOut = (r) => (r ? { id: r.id, name: r.name, team: r.team, icon: r.icon, image: r.image || [], ability: r.ability, imported: !!r.imported } : null);

function buildViews() {
  const views = {};
  // A Traveller's character is public (announced when they join); their alignment is not.
  const seats = seatList().map((p, i) => ({ pid: p.pid, name: p.name, seat: i + 1, alive: p.alive, ghostVote: p.ghostVote, canVote: canVote(p),
    traveller: isTraveller(p) && p.role ? roleOut(role(p.role)) : (isTraveller(p) ? {} : null), exiled: !!p.exiled }));
  // Roles are only revealed to everyone once the game is over.
  const reveal = S.winner ? seatList().map(p => ({ name: p.name, role: roleRef(p.role), rid: p.role, icon: role(p.role).icon, image: role(p.role).image || [], team: role(p.role).team,
    evil: isEvil(p), thought: p.fakeRole ? roleRef(p.fakeRole) : null })) : null;
  // The script (every character that might be in play), its rules and jinxes are public information.
  const sc = S.script;
  const scriptView = {
    name: sc ? sc.name : 'Nightfall', author: sc ? sc.author : '', almanac: sc ? sc.almanac : '',
    roles: ROLES.filter(r => ['townsfolk', 'outsider', 'minion', 'demon'].includes(r.team)).map(roleOut),
    travellers: scriptTravellers().map(roleOut),
    fabled: scriptFabled().filter(r => S.fabledOn.includes(r.id)).map(roleOut),
    bootlegger: sc ? sc.bootlegger : [],
    jinxes: sc ? sc.jinxes : [],
  };
  for (const p of seatList()) {
    const r = p.role ? role(shownRole(p)) : null;
    const v = S.vote;
    views[p.pid] = {
      room: S.room, phase: S.phase, day: S.day, night: S.night, winner: S.winner, announce: S.announce, reveal,
      seats, threshold: threshold(), exileThreshold: exileThreshold(),
      me: {
        pid: p.pid, name: p.name, alive: p.alive, ghostVote: p.ghostVote, canVote: canVoteOn(p, S.vote), traveller: isTraveller(p),
        role: roleOut(r),
        evil: p.role ? isEvil(p) : null,
        evilInfo: p.evilInfo,
        canNominate: S.phase === 'day' && !!S.nomsOpen && p.alive && !p.nominated && !S.vote,
        canDuel: S.phase === 'day' && p.alive && shownRole(p) === 'duelist' && !p.duelUsed,
      },
      prompt: p.prompt,
      msgs: p.msgs.slice(-40),
      nominations: S.nominations.map(n => ({ nominator: pname(n.nominator), nominee: pname(n.nominee), nomineePid: n.nominee, votes: n.votes, voters: n.voters })),
      // Voting is public at the table (hands are raised), so every phone sees the live hands.
      vote: v ? { kind: v.kind || 'execute', nominator: v.nominator ? pname(v.nominator) : '', nominee: pname(v.nominee), nomineePid: v.nominee, open: v.open,
        myVote: v.votes[p.pid] ?? null, yes: tallyYes(v), need: voteNeed(v), hands: v.votes,
        eligible: Object.fromEntries(seatList().map(x => [x.pid, canVoteOn(x, v)])) } : null,
      ghostVotes: S.ghostVotes !== false,
      nomsOpen: !!S.nomsOpen,
      script: scriptView,
      block: S.block ? { name: pname(S.block.pid), votes: S.block.votes } : null,
      nominatable: S.phase === 'day' ? seatList().filter(x => !x.wasNominated).map(x => x.pid) : [],
      pendingRequest: S.requests.some(q => q.pid === p.pid),
    };
  }
  return views;
}

// Messages are { k, v } (translated on each phone) or plain strings typed by the Storyteller.
function msg(pid, m) {
  const p = S.players[pid]; if (!p) return;
  p.msgs.push({ text: m, ts: now() });
}
function msgAll(m) { for (const p of seatList()) msg(p.pid, m); }
function log(text) { S.log.push({ text: tx(text), ts: now(), phase: S.phase === 'night' ? `N${S.night}` : `D${S.day}` }); }

// ---------- setup ----------
// Travellers are outside the setup counts.
const bagPlayers = () => seatList().filter(p => !S.travellerPids.includes(p.pid));
function recommended() { return setupFor(bagPlayers().length); }
function countSel(team) { return S.selection.filter(id => role(id).team === team).length; }
function randomSelection() {
  const [nt, no, nm, nd] = recommended();
  const byTeam = (team) => shuffle(ROLES.filter(r => r.team === team).map(r => r.id));
  S.selection = [...byTeam('townsfolk').slice(0, nt), ...byTeam('outsider').slice(0, no), ...byTeam('minion').slice(0, nm), ...byTeam('demon').slice(0, nd)];
}
function deal() {
  const ps = bagPlayers();
  if (S.selection.length !== ps.length) return toast(t('Select exactly {n} characters (now {m}).', { n: ps.length, m: S.selection.length }));
  const roles = shuffle(S.selection);
  ps.forEach((p, i) => { Object.assign(p, newPlayer(p.pid, p.name), { connected: p.connected, role: roles[i] }); });
  // Travellers keep the character the Storyteller picked for them (default: the first one on the script), good by default.
  const tr = scriptTravellers();
  for (const pid of S.travellerPids) {
    const p = S.players[pid]; if (!p) continue;
    const keep = p.role && role(p.role).team === 'traveller' ? p.role : (tr[0] && tr[0].id);
    const align = p.alignment || 'good';
    Object.assign(p, newPlayer(p.pid, p.name), { connected: p.connected, role: keep || null, alignment: align });
  }
  const notInPlay = ROLES.filter(r => r.team === 'townsfolk' && !S.selection.includes(r.id)).map(r => r.id);
  const sleeper = ps.find(p => p.role === 'sleepwalker');
  if (sleeper) sleeper.fakeRole = pick(notInPlay) || 'archivist';
  // Bluffs: Townsfolk not in play (and not the Sleepwalker's fake character, which would expose them).
  const goodOut = shuffle(notInPlay.filter(id => id !== (sleeper && sleeper.fakeRole)));
  S.bluffs = goodOut.slice(0, 3);
  S.dealt = true;
  save();
}
// A Traveller's character is announced to everyone; an evil Traveller privately learns who the Demon is.
function announceTravellers(list) {
  for (const p of list) {
    if (!p.role) continue;
    msgAll(L('{name} is the {role} (Traveller).', { name: p.name, role: roleRef(p.role) }));
    log(L('{name} is the {role} (Traveller, {align}).', { name: p.name, role: roleRef(p.role), align: L(isEvil(p) ? 'evil' : 'good') }));
    const r = role(p.role);
    msg(p.pid, L('You are the {role}. {ability}', { role: R(r), ability: RA(r) }));
    msg(p.pid, L(isEvil(p) ? 'Your alignment: evil.' : 'Your alignment: good.'));
    if (isEvil(p)) {
      const demons = seatList().filter(x => x.role && role(x.role).team === 'demon').map(x => x.name);
      if (demons.length) { msg(p.pid, L('Evil team: the Demon is {demon}.', { demon: demons })); p.evilInfo = { demon: demons }; }
    }
  }
}
// Seat a late joiner as a Traveller, right after the given player.
function seatTraveller(pid, roleId, alignment, afterPid) {
  const p = S.players[pid]; if (!p || !roleId) return;
  S.pending = S.pending.filter(x => x !== pid);
  if (!S.travellerPids.includes(pid)) S.travellerPids.push(pid);
  Object.assign(p, newPlayer(p.pid, p.name), { connected: p.connected, role: roleId, alignment, msgs: p.msgs });
  const i = S.seats.indexOf(afterPid);
  S.seats = S.seats.filter(x => x !== pid);
  if (i >= 0) S.seats.splice(S.seats.indexOf(afterPid) + 1, 0, pid); else S.seats.push(pid);
  announceTravellers([p]);
  save();
}
function startGame() {
  if (!S.dealt) return toast(t('Deal characters first.'));
  if (seatList().some(p => isTraveller(p) && !p.role)) return toast(t('Pick a Traveller character for every Traveller.'));
  S.locked = true;
  announceTravellers(seatList().filter(isTraveller));
  for (const p of seatList()) {
    if (isTraveller(p)) continue; // already told by announceTravellers()
    const r = role(shownRole(p));
    msg(p.pid, L('You are the {role}. {ability}', { role: R(r), ability: RA(r) }));
  }
  log(L('Game started with {n} players.', { n: seatList().length }));
  startNight();
}

// ---------- night ----------
function startNight() {
  S.night += 1; S.phase = 'night'; S.vote = null; S.requests = S.requests.filter(r => r.kind !== 'nominate');
  for (const p of seatList()) { p.cursed = false; p.protected = false; p.prompt = null; }
  const first = S.night === 1;
  const steps = [];
  const ps = seatList();
  // Minion and Demon info: first night only, and only with 7+ players (Travellers not counted).
  // Their position comes from the script's / night sheet's markers when present.
  const mk = (S.script && S.script.markers && S.script.markers.first) || {};
  if (first && bagPlayers().length >= 7) {
    steps.push({ key: 'minion_info', kind: 'minion_info', order: mk.minioninfo != null ? mk.minioninfo : -2 });
    steps.push({ key: 'demon_info', kind: 'demon_info', order: mk.demoninfo != null ? mk.demoninfo : -1 });
  }
  for (const p of ps) {
    if (!p.alive) continue;
    const r = role(shownRole(p));
    const n = first ? r.first : r.other;
    if (!n) continue;
    steps.push({ key: p.pid + ':' + r.id, kind: 'role', pid: p.pid, roleId: r.id, order: n.order, choice: [], status: 'pending', sent: '' });
  }
  steps.sort((a, b) => a.order - b.order);
  steps.push({ key: 'dawn', kind: 'dawn', order: 999 });
  S.steps = steps; S.stepIdx = 0; S.dawn = null;
  S.announce = L('Night {n}. Close your eyes.', { n: S.night });
  log(L('Night {n} begins.', { n: S.night }));
  tab = 'night'; save();
}
function stepDef(st) {
  const p = S.players[st.pid]; const r = role(st.roleId);
  const n = (S.night === 1 ? r.first : r.other) || {};
  // The Storyteller can override how many players a character picks (needed for imported characters).
  let choose = st.chooseN != null ? st.chooseN : (n.choose || 0), upTo = st.chooseN != null ? 0 : (n.upTo || 0);
  if (n.effect === 'kill' && S.debtorNight) upTo = 2;
  if (st.roleId === 'hollow' && p.hollowUsed && !S.debtorNight) upTo = 0;
  return { p, r, n, choose, upTo: Math.max(choose, upTo) };
}
function promptPlayer(st) {
  const { p, r, choose, upTo, n } = stepDef(st);
  const max = upTo || choose;
  p.prompt = { id: S.promptSeq++, step: st.key, role: R(r), ability: RA(r), min: choose, max, notSelf: !!n.notSelf };
  st.status = 'prompted';
  save();
}

// Suggested true answers are written in the Storyteller's language; they edit and send them as text.
function suggestion(st) {
  const { p, n } = stepDef(st);
  const ch = st.choice.map(id => S.players[id]).filter(Boolean);
  const ps = seatList();
  let s = '';
  switch (n.info) {
    case 'archivist': {
      const inPlay = ps.filter(x => x.pid !== p.pid).map(x => role(x.role).name);
      const out = ROLES.filter(r => !ps.some(x => x.role === r.id)).map(r => r.name);
      s = t('{a} is in play. {b} is not in play.', { a: pick(inPlay), b: pick(out) }); break;
    }
    case 'twin': { const g = ps.filter(x => x.pid !== p.pid && !isEvil(x)); s = g.length ? t('{name} is good.', { name: pick(g).name }) : t('No other good player.'); break; }
    case 'census': {
      const i = S.seats.indexOf(p.pid); let c = 0;
      for (let k = 1; k <= 3 && k < ps.length; k++) if (isEvil(ps[(i + k) % ps.length])) c++;
      s = t('{n} evil among the 3 players to your left.', { n: c }); break;
    }
    case 'cartographer': {
      if (!ch[0]) break;
      const alive = ps.filter(x => x.alive || x.pid === ch[0].pid);
      const i = alive.findIndex(x => x.pid === ch[0].pid);
      const nb = alive.length > 2 ? [alive[(i - 1 + alive.length) % alive.length], alive[(i + 1) % alive.length]] : alive.filter(x => x.pid !== ch[0].pid);
      s = t("{n} of {name}'s living neighbours evil.", { n: nb.filter(isEvil).length, name: ch[0].name }); break;
    }
    case 'oracle': {
      if (ch.length < 2) break;
      s = ch.some(x => role(x.role).team === 'minion') ? t('YES — {a} or {b} is a Minion.', { a: ch[0].name, b: ch[1].name }) : t('NO — neither {a} nor {b} is a Minion.', { a: ch[0].name, b: ch[1].name });
      break;
    }
    case 'tracker': {
      if (!ch[0]) break;
      const other = S.steps.find(x => x.kind === 'role' && x.pid === ch[0].pid && x.choice && x.choice.length);
      s = other ? t('{name} chose {targets}.', { name: ch[0].name, targets: other.choice.map(pname) }) : t('{name} chose nobody (so far tonight).', { name: ch[0].name }); break;
    }
    case 'gravedigger': {
      const e = S.lastExecuted && S.players[S.lastExecuted];
      s = e ? t(isEvil(e) ? '{name} (executed) was EVIL.' : '{name} (executed) was GOOD.', { name: e.name }) : t('Nobody was executed today.'); break;
    }
    case 'whisperer': { if (ch[0]) s = t('{name} is the {role}.', { name: ch[0].name, role: role(ch[0].role).name }); break; }
  }
  return s;
}
// Storyteller-facing note (never sent to the player): malfunction and Mimic warnings.
function suggestionNote(st) {
  const { p } = stepDef(st);
  const notes = [];
  if (malfunctioning(p)) notes.push(t(p.role === 'sleepwalker' ? '⚠ Malfunctioning (Sleepwalker): you may give false info.' : '⚠ Malfunctioning (cursed): you may give false info.'));
  if (seatList().some(x => x.role === 'mimic' && x.alive) && ['census', 'cartographer', 'oracle', 'gravedigger'].includes(stepDef(st).n.info)) notes.push(t('Mimic in play: may register as good/Townsfolk.'));
  return notes.join(' ');
}

function minionInfoText() {
  const ps = seatList();
  const demon = ps.filter(p => role(p.role).team === 'demon');
  const minions = ps.filter(p => role(p.role).team === 'minion');
  return { demon, minions };
}
function sendMinionInfo() {
  const { demon, minions } = minionInfoText();
  for (const m of minions) {
    const others = minions.filter(x => x !== m).map(x => x.name);
    m.evilInfo = Object.assign(m.evilInfo || {}, { demon: demon.map(d => d.name), minions: others });
    msg(m.pid, others.length
      ? L('Evil team: the Demon is {demon}. Fellow Minions: {minions}.', { demon: demon.map(d => d.name), minions: others })
      : L('Evil team: the Demon is {demon}.', { demon: demon.map(d => d.name) }));
  }
}
function sendDemonInfo() {
  const { demon, minions } = minionInfoText();
  const bluffs = S.bluffs.map(roleRef);
  for (const d of demon) {
    d.evilInfo = { minions: minions.map(x => x.name), bluffs };
    msg(d.pid, L('Your Minions: {minions}. Not in play (safe bluffs): {bluffs}.', { minions: minions.length ? minions.map(x => x.name) : L('none'), bluffs }));
  }
}

function applyImmediateEffects(st) {
  const { p, n } = stepDef(st);
  if (n.effect === 'curse' && !malfunctioning(p)) st.choice.forEach(id => { S.players[id].cursed = true; });
  if (n.effect === 'protect' && !malfunctioning(p)) st.choice.forEach(id => { S.players[id].protected = true; });
  if (st.roleId === 'hollow' && st.choice.length > 1 && !S.debtorNight) p.hollowUsed = true;
}

function computeDawn() {
  const kills = []; const notes = [];
  const sentinelHit = { v: false };
  for (const st of S.steps) {
    if (st.kind !== 'role' || !st.choice.length) continue;
    const { p, n } = stepDef(st);
    if (n.effect !== 'kill') continue;
    if (malfunctioning(p)) { notes.push(t('{name} (Demon) is cursed: the kill fails.', { name: p.name })); continue; }
    for (const id of st.choice) {
      const tg = S.players[id];
      if (!tg.alive) { notes.push(t('{name} already dead.', { name: tg.name })); continue; }
      if (tg.protected) { notes.push(t('{name} protected by Herbalist.', { name: tg.name })); continue; }
      if (tg.role === 'sentinel' && !tg.sentinelUsed && !tg.cursed) { tg.sentinelUsed = true; sentinelHit.v = true; notes.push(t('{name} is the Sentinel: nobody dies tonight.', { name: tg.name })); continue; }
      if (tg.role === 'lucky' && !tg.luckyUsed && !tg.cursed) { tg.luckyUsed = true; notes.push(t('{name} is the Lucky One: survives (first time).', { name: tg.name })); continue; }
      kills.push(id);
    }
  }
  S.dawn = { deaths: sentinelHit.v ? [] : [...new Set(kills)], notes };
}

function killPlayer(pid, cause) {
  const p = S.players[pid]; if (!p || !p.alive) return;
  const aliveBefore = alivePlayers().length;
  p.alive = false;
  log(L('{name} died ({cause}).', { name: p.name, cause: L(cause) }));
  if (p.role === 'witness') {
    const evil = seatList().filter(x => isEvil(x) && x.role !== 'mimic');
    const tg = p.cursed ? pick(seatList().filter(x => x.pid !== pid)) : pick(evil);
    if (tg) { msg(pid, L('Witness: {name} is evil.', { name: tg.name })); log(L('Witness {a} told: {b}', { a: p.name, b: tg.name })); }
  }
  if (role(p.role).team === 'demon') {
    const heir = seatList().find(x => x.role === 'heir' && x.alive && !x.cursed);
    if (heir && aliveBefore >= 5) {
      heir.role = p.role;
      msg(heir.pid, L('The Demon has fallen. You are now the {role}: {ability}', { role: roleRef(p.role), ability: RA(role(p.role)) }));
      log(L('{name} (Heir) becomes the {role}.', { name: heir.name, role: roleRef(p.role) }));
      toast(t('Heir {name} becomes the Demon.', { name: heir.name }));
    }
  }
  checkWin();
}
function checkWin() {
  if (S.winner) return;
  const demonAlive = seatList().some(p => p.alive && role(p.role).team === 'demon');
  if (!demonAlive) return endGame('good', L('The Demon is dead.'));
  // Travellers (and Fabled) don't count towards "two players alive".
  if (alivePlayers().filter(p => !isTraveller(p)).length <= 2) return endGame('evil', L('Only two players remain.'));
}
function endGame(side, why) {
  S.winner = side; S.phase = 'over';
  S.announce = L(side === 'good' ? 'GOOD WINS: {why}' : 'EVIL WINS: {why}', { why });
  for (const p of seatList()) p.prompt = null;
  S.vote = null;
  log(S.announce);
  msgAll([S.announce, '\n', ...seatList().map(p => p.fakeRole
    ? L('{name}: {role} (thought {fake})\n', { name: p.name, role: roleRef(p.role), fake: roleRef(p.fakeRole) })
    : L('{name}: {role}\n', { name: p.name, role: roleRef(p.role) }))]);
  tab = 'grim';
}

function startDay() {
  if (!S.dawn) computeDawn();
  const died = S.dawn.deaths.slice();
  S.phase = 'day'; S.day += 1;
  for (const p of seatList()) { p.prompt = null; p.nominated = false; p.wasNominated = false; p.protected = false; }
  S.nominations = []; S.vote = null; S.block = null; S.executedToday = null; S.debtorNight = false; S.nomsOpen = false; S.highest = 0;
  S.requests = []; S.exiledToday = [];
  S.announce = died.length ? L('Day {n}. Died in the night: {names}.', { n: S.day, names: died.map(pname) }) : L('Day {n}. Nobody died in the night.', { n: S.day });
  msgAll(S.announce);
  log(S.announce);
  for (const id of died) killPlayer(id, 'night');
  tab = S.winner ? 'grim' : 'day';
  save();
}

// ---------- day ----------
function nominationProblem(nominator, nominee) {
  const a = S.players[nominator], b = S.players[nominee];
  if (!a || !b) return L('Unknown player.');
  if (!a.alive) return L('{name} is dead and cannot nominate.', { name: a.name });
  if (a.nominated) return L('{name} already nominated today.', { name: a.name });
  if (b.wasNominated) return L('{name} was already nominated today.', { name: b.name });
  if (S.vote) return L('A vote is already in progress.');
  return '';
}
function openVote(nominator, nominee) {
  const prob = nominationProblem(nominator, nominee);
  if (prob) return toast(tx(prob));
  const a = S.players[nominator], b = S.players[nominee];
  a.nominated = true; b.wasNominated = true;
  S.requests = S.requests.filter(r => !(r.kind === 'nominate' && r.pid === nominator));
  log(L('{a} nominates {b}.', { a: a.name, b: b.name }));
  if (a.role === 'hothead' && !a.cursed && !isEvil(b)) {
    toast(t('{name} is the Hothead and nominated a good player: they die.', { name: a.name }));
    killPlayer(a.pid, 'Hothead');
  }
  if (S.winner) return save();
  S.vote = { nominator, nominee, votes: {}, open: true };
  S.announce = L('{a} nominated {b}. Vote now! ({n} needed)', { a: a.name, b: b.name, n: threshold() });
  save();
}
// ---- exile (Travellers only) ----
// Any player, alive or dead, may call for a Traveller's exile. It is not a vote: nobody spends a ghost vote,
// abilities don't affect it, and it never counts as the day's execution. Each Traveller once per day.
function exileProblem(target) {
  const tg = S.players[target];
  if (!tg || !isTraveller(tg)) return L('Only Travellers can be exiled.');
  if (!tg.alive) return L('{name} is already dead.', { name: tg.name });
  if (S.exiledToday.includes(target)) return L('{name} was already called for exile today.', { name: tg.name });
  if (S.vote) return L('A vote is already in progress.');
  return '';
}
function openExile(caller, target) {
  const prob = exileProblem(target);
  if (prob) return toast(tx(prob));
  S.exiledToday.push(target);
  S.requests = S.requests.filter(r => !(r.kind === 'exile' && r.target === target));
  S.vote = { kind: 'exile', nominator: caller || null, nominee: target, votes: {}, open: true };
  S.announce = caller
    ? L('{a} calls for the exile of {b}. Raise your hand to support! ({n} needed)', { a: pname(caller), b: pname(target), n: exileThreshold() })
    : L('Exile of {b}: raise your hand to support! ({n} needed)', { b: pname(target), n: exileThreshold() });
  log(S.announce);
  save();
}
function closeExile() {
  const v = S.vote;
  const voters = Object.entries(v.votes).filter(([, y]) => y).map(([pid]) => pname(pid));
  const n = voters.length, need = exileThreshold();
  const tg = S.players[v.nominee];
  S.vote = null;
  if (n >= need) {
    S.announce = L('{name} is exiled ({n} of {need}).', { name: tg.name, n, need });
    tg.exiled = true;
    msgAll(S.announce); log(S.announce);
    killPlayer(tg.pid, 'exiled');
  } else {
    S.announce = L('Not enough support to exile {name} ({n} of {need}).', { name: tg.name, n, need });
    msgAll(S.announce); log(S.announce);
  }
  save();
}

function voteWeight(p) { return p.role === 'magistrate' && !p.cursed && !p.drunk && !p.poisoned && p.alive ? 2 : 1; }
function closeVote() {
  const v = S.vote; if (!v) return;
  if (v.kind === 'exile') return closeExile();
  let count = 0; const voters = [];
  for (const [pid, yes] of Object.entries(v.votes)) {
    const p = S.players[pid]; if (!yes || !canVote(p)) continue;
    if (!p.alive) p.ghostVote = false; // spending the ghost vote
    count += voteWeight(p); voters.push(p.name);
  }
  const need = threshold();
  S.nominations.push({ nominator: v.nominator, nominee: v.nominee, votes: count, voters });
  let result;
  const best = S.highest || 0;
  if (count >= need && count > best) { S.block = { pid: v.nominee, votes: count }; S.highest = count; result = L('{name} is on the block with {n}.', { name: pname(v.nominee), n: count }); }
  else if (count >= need && count === best) { S.block = null; result = L('Tie at {n}: nobody is on the block.', { n: count }); }
  else result = count < need ? L('{n} votes: not enough ({need} needed).', { n: count, need }) : L('{n} votes: not enough (needs more than {best}).', { n: count, best });
  log([L('Vote on {name}: {n} ({voters}). ', { name: pname(v.nominee), n: count, voters: voters.length ? voters : L('none') }), result]);
  S.announce = result;
  msgAll([L('Vote on {name}: {n}. ', { name: pname(v.nominee), n: count }), result]);
  S.vote = null;
  save();
}
// mode: 'kill' = execute and they die; 'survive' = executed but an ability keeps them alive; 'none' = no execution.
function endDay(mode) {
  if (S.vote) return toast(t('Close the open vote first.'));
  S.nomsOpen = false;
  if (S.block && mode !== 'none') {
    const p = S.players[S.block.pid];
    S.executedToday = p.pid; S.lastExecuted = p.pid;
    if (mode === 'survive') {
      msgAll(L('{name} is executed… but does not die.', { name: p.name }));
      log(L('{name} executed but survived (Storyteller ruling).', { name: p.name }));
    } else {
      msgAll(L('{name} is executed.', { name: p.name }));
      if (p.role === 'debtor' && !p.cursed) { S.debtorNight = true; log(L('Debtor executed: the Demon may kill twice tonight.')); }
      killPlayer(p.pid, 'executed');
    }
  } else {
    S.lastExecuted = null;
    msgAll(L('Nobody is executed today.'));
    log(L('No execution today.'));
  }
  S.highest = 0; S.block = null;
  if (S.winner) return save();
  startNight();
}

// ---------- player actions ----------
function handleAct(pid, a) {
  if (!S) return;
  const p = S.players[pid]; if (!p) return;
  if (a.kind === 'answer') {
    if (!p.prompt || p.prompt.id !== a.promptId) return;
    const st = S.steps.find(x => x.key === p.prompt.step);
    const targets = (a.targets || []).filter(id => S.players[id]).slice(0, p.prompt.max);
    if (targets.length < p.prompt.min) return;
    if (st) { st.choice = targets; st.status = 'answered'; applyImmediateEffects(st); }
    p.prompt = null;
    toast(t('{name} chose {targets}', { name: p.name, targets: targets.map(pname) }));
    save();
  } else if (a.kind === 'nominate') {
    if (S.phase !== 'day') return;
    if (!S.nomsOpen) { msg(pid, L('Nominations are not open yet.')); return save(); }
    const prob = nominationProblem(pid, a.target);
    if (prob) { msg(pid, [L('Nomination refused: '), prob]); return save(); }
    S.requests = S.requests.filter(r => r.pid !== pid || r.kind !== 'nominate');
    S.requests.push({ kind: 'nominate', pid, target: a.target, ts: now() });
    toast(t('{a} wants to nominate {b}', { a: p.name, b: pname(a.target) }));
    save();
  } else if (a.kind === 'vote') {
    if (!S.vote || !S.vote.open) return;
    if (!canVoteOn(p, S.vote)) return; // dead without a ghost vote: ignored
    S.vote.votes[pid] = !!a.yes;
    save();
  } else if (a.kind === 'exile') {
    if (S.phase !== 'day') return;
    const prob = exileProblem(a.target);
    if (prob) { msg(pid, [L('Exile refused: '), prob]); return save(); }
    if (!S.requests.some(r => r.kind === 'exile' && r.target === a.target)) S.requests.push({ kind: 'exile', pid, target: a.target, ts: now() });
    toast(t('{a} calls for the exile of {b}', { a: p.name, b: pname(a.target) }));
    save();
  } else if (a.kind === 'duel') {
    if (S.phase !== 'day' || p.duelUsed) return;
    S.requests.push({ kind: 'duel', pid, target: a.target, ts: now() });
    toast(t('{a} (Duelist?) challenges {b}', { a: p.name, b: pname(a.target) }));
    save();
  } else if (a.kind === 'cancel_request') {
    S.requests = S.requests.filter(r => r.pid !== pid); save();
  }
}

function resolveDuel(i, kill) {
  const r = S.requests[i]; if (!r) return;
  const p = S.players[r.pid]; p.duelUsed = true;
  S.requests.splice(i, 1);
  const tg = S.players[r.target];
  msgAll(L(kill ? '{a} challenges {b}… {b} dies!' : '{a} challenges {b}… nothing happens.', { a: p.name, b: tg.name }));
  log(L(kill ? 'Duel: {a} → {b}: dies.' : 'Duel: {a} → {b}: nothing.', { a: p.name, b: tg.name }));
  if (kill) killPlayer(tg.pid, 'duel');
  save();
}

// ---------- rendering ----------
function toast(text) {
  const el = document.createElement('div'); el.className = 'toast'; el.textContent = text;
  document.body.appendChild(el); setTimeout(() => el.remove(), 3200);
}
function pill(cls, text) { return `<span class="pill ${cls}">${esc(text)}</span>`; }
function pillH(cls, html) { return `<span class="pill ${cls}">${html}</span>`; } // html must already be escaped
function rolePill(id) { if (!id) return ''; const r = role(id); return pillH(r.team, roleArt(r, null, 'xs') + ' ' + esc(r.name) + infoBtn(r.id)); }
window.roleLookup = (id) => ROLES.find(r => r.id === id) || null;
window.jinxLookup = () => (S.script && S.script.jinxes) || [];

function render() {
  const title = document.getElementById('toptitle');
  if (!S) {
    title.textContent = t('Nightfall Storyteller');
    const resuming = !!store.get('nf_host');
    $tabs.innerHTML = '';
    $app.innerHTML = `
      <div class="card stack">
        <h1>${t('Host a game')}</h1>
        <p class="muted">${t('You are the Storyteller. Your device holds the full game state. Keep this page open.')}</p>
        ${resuming ? `<p class="small muted">${t('Reconnecting to your room…')}</p>`
          : `<button class="primary block" data-a="create" ${creating ? 'disabled' : ''}>${creating ? t('Creating…') : t('Create room')}</button>`}
      </div>
      <div class="card small muted">${t(info.cloud ? 'Players open {url}.' : 'Players open {url} on the same Wi-Fi.', { url: joinBase() })}</div>`;
    return;
  }
  const phaseName = S.phase === 'night' ? t('Night {n}', { n: S.night }) : S.phase === 'day' ? t('Day {n}', { n: S.day }) : S.phase === 'over' ? t('Game over') : t('Setup');
  title.textContent = t('Room {code}', { code: S.room }) + ' · ' + phaseName;
  document.getElementById('topright').innerHTML = `<span class="pill">${seatList().length} 👤</span>`;

  const tabsDef = S.locked
    ? [['grim', '📖', t('Grimoire')], [S.phase === 'day' ? 'day' : 'night', S.phase === 'day' ? '☀️' : '🌙', S.phase === 'day' ? t('Day') : t('Night')], ['log', '🧾', t('Log')], ['more', '⚙️', t('More')]]
    : [['lobby', '👥', t('Lobby')], ['setup', '🎭', t('Characters')], ['more', '⚙️', t('More')]];
  if (!tabsDef.some(x => x[0] === tab)) tab = tabsDef[0][0];
  if (S.locked && S.phase !== 'over' && (tab === 'night' || tab === 'day')) tab = S.phase;
  const reqCount = S.requests.length;
  $tabs.innerHTML = tabsDef.map(([k, ic, l]) => `<button class="${tab === k ? 'active' : ''}" data-a="tab" data-k="${k}"><span class="ic">${ic}</span>${l}${k === 'day' && reqCount ? `<span class="badge">${reqCount}</span>` : ''}</button>`).join('');

  const banner = S.winner ? `<div class="banner ${S.winner}"><h2>${esc(tx(S.announce))}</h2></div>` : '';
  $app.innerHTML = banner + ({ lobby: viewLobby, setup: viewSetup, grim: viewGrim, night: viewNight, day: viewDay, log: viewLog, more: viewMore }[tab] || viewGrim)();
  renderSheet();
}

function joinBase() {
  if (!info.addresses || !info.addresses.length) return location.origin + '/';
  return `http://${info.addresses[0]}:${info.port || location.port}/`;
}
// QR code for the join link (generated locally, so it also works on a Wi-Fi without internet).
const qrCache = {};
function qrSvg(url) {
  if (!url || typeof qrcode !== 'function') return '';
  if (!qrCache[url]) {
    const qr = qrcode(0, 'M');
    qr.addData(url); qr.make();
    qrCache[url] = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  }
  return qrCache[url];
}
function viewLobby() {
  const ps = seatList();
  const urls = (info.addresses || []).length
    ? info.addresses.map(a => `http://${a}:${info.port}/?room=${S.room}`)
    : [`${location.origin}/?room=${S.room}`];
  const [nt, no, nm, nd] = recommended();
  return `
    <div class="card center">
      <h3>${t('Room code')}</h3><div class="code">${S.room}</div>
      ${qrSvg(urls[0]) ? `<div class="qr" aria-label="${esc(t('Scan to join'))}">${qrSvg(urls[0])}</div><p class="small muted">${t('Scan to join')}</p>` : ''}
      <p class="small muted">${t(info.cloud ? 'Players open:' : 'Players open (same Wi-Fi):')}</p>
      ${urls.map(u => `<div><b>${esc(u)}</b></div>`).join('')}
    </div>
    <div class="card">
      <div class="row"><h2 class="grow">${t('Players ({n})', { n: ps.length })}</h2></div>
      <p class="small muted">${t('Order = seating order clockwise around the circle.')} ${bagPlayers().length < 5 ? t('5–15 players recommended.') : t('Setup: {t} Townsfolk, {o} Outsider, {m} Minion, {d} Demon.', { t: nt, o: no, m: nm, d: nd })}
        ${bagPlayers().length > 15 ? `<br><b style="color:var(--warn)">${t('More than 15 players: everyone beyond 15 must play a Traveller (tap 🧳).')}</b>` : ''}</p>
      <div class="list">${ps.map((p, i) => `
        <div class="item"><span class="seat">${i + 1}</span>
          <div class="main"><div class="name">${esc(p.name)} ${S.travellerPids.includes(p.pid) ? pill('warn', t('🧳 Traveller')) : ''}</div><div class="small ${p.connected ? 'muted' : ''}">${p.connected ? t('connected') : t('⚠ offline')}</div></div>
          <button class="sm ${S.travellerPids.includes(p.pid) ? 'primary' : ''}" data-a="toggleTraveller" data-pid="${p.pid}" title="${esc(t('Traveller'))}">🧳</button>
          <button class="sm" data-a="seatUp" data-pid="${p.pid}" ${i === 0 ? 'disabled' : ''}>▲</button>
          <button class="sm" data-a="seatDown" data-pid="${p.pid}" ${i === ps.length - 1 ? 'disabled' : ''}>▼</button>
          <button class="sm danger" data-a="kick" data-pid="${p.pid}">✕</button>
        </div>`).join('') || `<p class="muted">${t('Waiting for players to join…')}</p>`}</div>
    </div>
    <button class="primary block" data-a="tab" data-k="setup" ${ps.length < 2 ? 'disabled' : ''}>${t('Choose characters →')}</button>`;
}

function viewSetup() {
  const ps = bagPlayers();
  const [nt, no, nm, nd] = recommended();
  const target = { townsfolk: nt, outsider: no, minion: nm, demon: nd };
  const groups = ['townsfolk', 'outsider', 'minion', 'demon'].map(team => {
    const c = countSel(team);
    return `<div class="card"><div class="row"><h3 class="grow">${teamLabel(team, true)}</h3>${pill(c === target[team] ? 'ok' : 'warn', `${c} / ${target[team]}`)}</div>
      <div class="grid2">${ROLES.filter(r => r.team === team).map(r => {
        const on = S.selection.includes(r.id);
        return `<button class="${on ? (isEvilTeam(team) ? 'danger' : 'good') : ''}" data-a="toggleRole" data-id="${r.id}" style="text-align:left;min-height:56px" title="${esc(r.ability)}">${roleArt(r, null, 'sm')} ${esc(r.name)}${infoBtn(r.id)}${r.setup ? ` <span class="pill warn">${t('setup')}</span>` : ''}</button>`;
      }).join('')}</div></div>`;
  }).join('');
  const sc = S.script;
  const scriptCard = `<div class="card"><div class="row"><div class="grow"><h3 style="margin:0">${t('Script')}</h3>
      <b>${esc(sc ? sc.name : t('Nightfall (built-in)'))}</b>${sc && sc.author ? ` <span class="small muted">${t('by {author}', { author: esc(sc.author) })}</span>` : ''}
      <div class="small muted">${t('{n} characters', { n: ROLES.filter(r => target[r.team] !== undefined).length })}${scriptTravellers().length ? ' · ' + t('{n} Travellers', { n: scriptTravellers().length }) : ''}${scriptFabled().length ? ' · ' + t('{n} Fabled/Loric', { n: scriptFabled().length }) : ''}${sc && sc.missing.length ? ' · ' + t('⚠ {n} unknown', { n: sc.missing.length }) : ''}</div></div>
      <button class="sm" data-a="openImport" ${S.locked ? 'disabled' : ''}>${t('Import…')}</button></div>
      ${sc && sc.missing.length ? `<p class="small" style="color:var(--warn);margin:6px 0 0">${t('Unknown: {ids}. Import a character library that defines them, then import the script again.', { ids: esc(sc.missing.join(', ')) })}</p>` : ''}
      ${sc && sc.warnings && sc.warnings.length ? `<p class="small muted" style="margin:6px 0 0">⚠ ${sc.warnings.map(esc).join('<br>⚠ ')}</p>` : ''}
      ${ROLES.some(r => r.setup) ? `<p class="small muted" style="margin:6px 0 0"><span class="pill warn">${t('setup')}</span> ${t('characters change the Townsfolk/Outsider counts: adjust your selection by hand.')}</p>` : ''}
      ${sc ? sourceLine(sc.source) : ''}
      ${sc && sc.almanac ? `<p class="small" style="margin:6px 0 0"><a href="${esc(sc.almanac)}" target="_blank" rel="noopener" style="color:var(--accent)">${t('Almanac ↗')}</a></p>` : ''}
    </div>
    ${rulesCard(true)}`;
  const dealt = S.dealt ? `
    <div class="card"><h2>${t('Dealt characters')}</h2>
      <p class="small muted">${t('Players can already see their character. Swap here if needed, then start.')}</p>
      <div class="list">${seatList().map((p, i) => `
        <div class="item"><span class="seat">${i + 1}</span><div class="main"><div class="name">${esc(p.name)}</div>
          <div>${rolePill(p.role)} ${isTraveller(p) ? pill(isEvil(p) ? 'evil' : 'good', isEvil(p) ? t('evil') : t('good')) : ''} ${p.fakeRole ? `<span class="small muted">${t('thinks')}</span> ` + rolePill(p.fakeRole) : ''}</div></div>
          <button class="sm" data-a="sheetPlayer" data-pid="${p.pid}">${t('Edit')}</button></div>`).join('')}</div>
      <p class="small">${t('Demon bluffs:')} ${S.bluffs.map(rolePill).join(' ')}</p>
    </div>
    <button class="primary block" data-a="start">${t('Start game: first night 🌙')}</button>` : '';
  return `${scriptCard}
    <div class="card"><h2>${t('Characters for {n} players', { n: ps.length })}</h2>
      <p class="small muted">${t('Recommended: {t} Townsfolk · {o} Outsider · {m} Minion · {d} Demon. Selected {s}/{n}.', { t: nt, o: no, m: nm, d: nd, s: S.selection.length, n: ps.length })}</p>
      <div class="grid2"><button data-a="randomRoles">${t('🎲 Random pick')}</button><button class="primary" data-a="deal" ${S.selection.length === ps.length ? '' : 'disabled'}>${S.dealt ? t('Deal again') : t('Deal')}</button></div>
    </div>
    ${dealt}${groups}`;
}

// Fabled/Loric toggles, bootlegger rules and jinxes. Shown in setup (editable) and the grimoire.
function rulesCard(editable) {
  const sc = S.script;
  const fab = scriptFabled();
  const jinxes = sc ? sc.jinxes : [];
  const boot = sc ? sc.bootlegger : [];
  if (!fab.length && !jinxes.length && !boot.length) return '';
  return `<div class="card"><h3>${t('Special rules')}</h3>
    ${fab.length ? `<div class="small muted" style="margin-bottom:4px">${t('Fabled & Loric (announced to everyone when in play):')}</div>
      <div class="grid2">${fab.map(r => `<button class="sm ${S.fabledOn.includes(r.id) ? 'primary' : ''}" data-a="toggleFabled" data-id="${r.id}" ${editable || S.phase !== 'over' ? '' : 'disabled'} title="${esc(r.ability)}">${roleArt(r, null, 'sm')} ${esc(r.name)}${infoBtn(r.id)}</button>`).join('')}</div>` : ''}
    ${boot.length ? `<div class="small" style="margin-top:8px"><b>${t('Bootlegger rules:')}</b><ul style="margin:4px 0 0 18px;padding:0">${boot.map(b => `<li>${esc(b)}</li>`).join('')}</ul></div>` : ''}
    ${jinxes.length ? `<div class="small" style="margin-top:8px"><b>${t('Jinxes (read all of these aloud at setup):')}</b>${jinxes.map(j => `<div style="margin-top:4px">⚡ <b>${esc(j.aName)} + ${esc(j.bName)}</b>${j.reason ? ': ' + esc(j.reason) : ''}</div>`).join('')}</div>` : ''}
  </div>`;
}
function statusPills(p) {
  return `${p.drunk ? pill('warn', t('🍺 drunk')) : ''}${p.poisoned ? pill('evil', t('☠ poisoned')) : ''}${(p.reminders || []).map(x => pill('', '🔖 ' + x)).join('')}`;
}
function viewGrim() {
  const ps = seatList();
  const alive = alivePlayers().length;
  const pending = S.pending.map(id => S.players[id]).filter(Boolean);
  return `
    ${pending.length ? `<div class="card" style="border-color:var(--accent)"><h3>${t('Waiting to join as Travellers')}</h3>${pending.map(p => `
      <div class="row" style="margin-bottom:6px"><b class="grow">${esc(p.name)}</b>
        <button class="sm good" data-a="openSeatTraveller" data-pid="${p.pid}">${t('Seat as Traveller')}</button>
        <button class="sm" data-a="kick" data-pid="${p.pid}">✕</button></div>`).join('')}</div>` : ''}
    <div class="card"><div class="row"><div class="grow">${t('{a} alive · {n} votes to execute', { a: `<b>${alive}</b>`, n: `<b>${threshold()}</b>` })}</div>
      ${S.phase !== 'over' ? `<button class="sm" data-a="tab" data-k="${S.phase}">${S.phase === 'day' ? t('Go to day →') : t('Go to night →')}</button>` : ''}</div>
      ${S.announce && !S.winner ? `<p class="small muted">${esc(tx(S.announce))}</p>` : ''}</div>
    <div class="card list" style="padding:4px">${ps.map((p, i) => `
      <div class="item tap ${p.alive ? '' : 'dead'}" data-a="sheetPlayer" data-pid="${p.pid}"><span class="seat">${i + 1}</span>
        <div class="main"><div class="name">${esc(p.name)} ${p.connected ? '' : '⚠'}</div>
          <div class="row" style="gap:4px;margin-top:2px">${rolePill(p.role)}${isTraveller(p) ? pill(isEvil(p) ? 'evil' : 'good', '🧳 ' + (isEvil(p) ? t('evil') : t('good'))) : (p.alignment ? pill(isEvil(p) ? 'evil' : 'good', isEvil(p) ? t('evil') : t('good')) : '')}${p.exiled ? pill('dead', t('exiled')) : ''}${p.fakeRole ? pill('', t('thinks {role}', { role: role(p.fakeRole).name })) : ''}${statusPills(p)}
          ${p.cursed ? pill('evil', t('🕸 cursed')) : ''}${p.protected ? pill('good', t('🌿 safe')) : ''}
          ${!p.alive ? pill('dead', canVote(p) ? t('💀 dead · ghost vote left') : t('💀 dead · no vote')) : ''}
          ${p.role === 'sentinel' && p.sentinelUsed ? pill('', t('used')) : ''}${p.role === 'lucky' && p.luckyUsed ? pill('', t('luck used')) : ''}
          ${p.role === 'duelist' && p.duelUsed ? pill('', t('duel used')) : ''}${p.role === 'hollow' && p.hollowUsed ? pill('', t('double used')) : ''}</div></div>
      </div>`).join('')}</div>
    <div class="card small">${t('Bluffs given to Demon:')} ${S.bluffs.map(rolePill).join(' ')}</div>
    ${rulesCard(false)}
    ${S.phase === 'over' ? `<button class="primary block" data-a="newGame">${t('New game with same players')}</button>` : ''}`;
}

function playerChips(st, max) {
  return `<div class="grid2" style="margin-top:8px">${seatList().map(x => {
    const on = st.choice.includes(x.pid);
    return `<button class="sm ${on ? 'primary' : ''}" data-a="hostChoose" data-key="${esc(st.key)}" data-pid="${x.pid}" data-max="${max}">${x.alive ? '' : '💀'}${esc(x.name)}</button>`;
  }).join('')}</div>`;
}

function viewNight() {
  if (S.phase !== 'night') return `<div class="card">${t('Not night.')}</div>`;
  const steps = S.steps.map((st, i) => {
    const cur = i === S.stepIdx; const done = i < S.stepIdx;
    let head = '', body = '';
    if (st.kind === 'minion_info') {
      const { demon, minions } = minionInfoText();
      head = t('😈 Minions wake & learn the Demon');
      body = `<p class="small">${t('Minions: {m} · Demon: {d}', { m: minions.map(x => esc(x.name)).join(', ') || '—', d: demon.map(x => esc(x.name)).join(', ') })}</p>
        <button class="primary block" data-a="sendMinionInfo">${t('Send to Minions & next')}</button>`;
    } else if (st.kind === 'demon_info') {
      head = t('👹 Demon wakes: learns Minions + 3 bluffs');
      body = `<p class="small">${t('Bluffs:')} ${S.bluffs.map(rolePill).join(' ')}</p><button class="primary block" data-a="sendDemonInfo">${t('Send to Demon & next')}</button>`;
    } else if (st.kind === 'dawn') {
      head = t('🌅 Dawn');
      if (cur) {
        if (!S.dawn) computeDawn();
        body = `<p class="small muted">${t('Tap to toggle who dies. Notes:')}</p>
          ${S.dawn.notes.map(n => `<div class="small">• ${esc(n)}</div>`).join('')}
          <div class="grid2" style="margin-top:8px">${alivePlayers().map(x => `<button class="sm ${S.dawn.deaths.includes(x.pid) ? 'danger' : ''}" data-a="toggleDeath" data-pid="${x.pid}">${S.dawn.deaths.includes(x.pid) ? '💀 ' : ''}${esc(x.name)}</button>`).join('')}</div>
          <button class="primary block" style="margin-top:10px" data-a="startDay">${t('Wake everyone: start Day {n} ☀️', { n: S.day + 1 })}</button>`;
      }
    } else {
      const { p, r, choose, upTo } = stepDef(st);
      const max = upTo || choose;
      const mal = malfunctioning(p);
      head = `${roleArt(r, null, 'sm')} ${esc(r.name)}${infoBtn(r.id)} — ${esc(p.name)} ${p.role === 'sleepwalker' ? pill('warn', role('sleepwalker').name) : ''}${p.cursed ? pill('evil', t('cursed')) : ''}`;
      if (cur || (done && st.choice.length)) {
        // Cache so random suggestions (Archivist, Twin) stay stable across re-renders.
        const sugKey = st.choice.join(',') + '|' + LANG;
        if (st.sugFor !== sugKey || st.sug == null) { st.sug = suggestion(st); st.sugFor = sugKey; }
        const sug = st.sug;
        const note = suggestionNote(st);
        const reminder = stepDef(st).n.reminder;
        body = `<p class="small muted">${esc(r.ability)}</p>
          ${reminder ? `<p class="small" style="border-left:3px solid var(--accent);padding-left:8px">${esc(reminder)}</p>` : ''}
          ${!p.alive ? `<p class="small">${t('💀 Dead: skip unless their ability says otherwise.')}</p>` : ''}
          ${cur ? `<div class="row small muted" style="margin-bottom:6px">${t('Players to choose:')}
            ${[0, 1, 2, 3].map(k => `<button class="sm ${choose === k && !(upTo > choose) ? 'primary' : ''}" data-a="setChoose" data-key="${esc(st.key)}" data-n="${k}">${k}</button>`).join('')}</div>` : ''}
          ${max ? `<div class="row"><button class="sm ${st.status === 'prompted' ? '' : 'good'}" data-a="prompt" data-key="${esc(st.key)}" ${p.connected ? '' : 'disabled'}>📱 ${st.status === 'prompted' ? t('Re-send') : t('Ask player to choose')}</button>
            <span class="small muted">${st.status === 'prompted' ? t('Waiting for answer…') : st.status === 'answered' ? t('Answered ✓') : ''}</span></div>
            <p class="small muted" style="margin:6px 0 0">${t('Or pick for them ({n}):', { n: max > choose ? choose + '–' + max : choose })}</p>${playerChips(st, max)}` : ''}
          ${max && st.choice.length ? `<p><b>${t('Chose:')}</b> ${st.choice.map(pname).map(esc).join(', ')}${mal && stepDef(st).n.effect ? ' — ' + t('⚠ no effect (malfunctioning)') : ''}</p>` : ''}
          ${stepDef(st).n.info || r.imported || stepDef(st).n.reminder ? `
            <label>${t('Info to send')} ${sug ? '' : t('(waiting for choice)')}</label>
            ${sug ? `<p class="small muted">${t('True answer: {s}', { s: esc(sug) })}</p>` : ''}
            ${note ? `<p class="small" style="color:var(--warn)">${esc(note)}</p>` : ''}
            <textarea id="info-${esc(st.key)}" placeholder="${esc(t('Information for {name}', { name: p.name }))}">${esc(st.sent || sug || '')}</textarea>
            <button class="sm good" data-a="sendInfo" data-key="${esc(st.key)}">${t('Send info')}</button>${st.sent ? ` <span class="small muted">${t('sent ✓')}</span>` : ''}` : ''}
          ${cur ? `<div class="grid2" style="margin-top:10px"><button data-a="prevStep" ${i === 0 ? 'disabled' : ''}>${t('← Back')}</button><button class="primary" data-a="nextStep">${t('Done →')}</button></div>` : ''}`;
      }
    }
    return `<div class="step ${cur ? 'current' : ''} ${done ? 'done' : ''}" ${!cur ? `data-a="gotoStep" data-i="${i}"` : ''}><div class="row"><b class="grow">${head}</b>${done ? '✓' : ''}</div>${cur || (done && body && st.kind === 'role') ? body : ''}</div>`;
  }).join('');
  return `<div class="card small muted">${t('Night {n}. Players should keep eyes closed; wake each in order (tap "Ask player" to put the choice on their phone).', { n: S.night })} ${S.debtorNight ? `<br><b>${t('Debtor executed: Demon may kill twice tonight.')}</b>` : ''}</div>${steps}`;
}

function viewDay() {
  if (S.phase !== 'day') return `<div class="card">${t('Not day.')}</div>`;
  const v = S.vote;
  const reqs = S.requests.map((r, i) => r.kind === 'nominate' ? `
      <div class="item"><div class="main">${t('{a} nominates {b}', { a: `<b>${esc(pname(r.pid))}</b>`, b: `<b>${esc(pname(r.target))}</b>` })}
        ${nominationProblem(r.pid, r.target) ? `<div class="small" style="color:var(--warn)">${esc(tx(nominationProblem(r.pid, r.target)))}</div>` : ''}</div>
        <button class="sm primary" data-a="acceptNom" data-i="${i}">${t('Open vote')}</button><button class="sm" data-a="dropReq" data-i="${i}">✕</button></div>`
    : r.kind === 'exile' ? `
      <div class="item"><div class="main">${t('{a} calls for the exile of {b}', { a: `<b>${esc(pname(r.pid))}</b>`, b: `<b>${esc(pname(r.target))}</b>` })}
        ${exileProblem(r.target) ? `<div class="small" style="color:var(--warn)">${esc(tx(exileProblem(r.target)))}</div>` : ''}</div>
        <button class="sm primary" data-a="acceptExile" data-i="${i}">${t('Open exile')}</button><button class="sm" data-a="dropReq" data-i="${i}">✕</button></div>`
    : `<div class="item"><div class="main">${t('{a} challenges {b} (claims Duelist)', { a: `<b>${esc(pname(r.pid))}</b>`, b: `<b>${esc(pname(r.target))}</b>` })}
        <div class="small muted">${t('Real:')} ${rolePill(S.players[r.pid].role)} → ${rolePill(S.players[r.target].role)}. ${t('Suggested:')} ${S.players[r.pid].role === 'duelist' && !S.players[r.pid].cursed && role(S.players[r.target].role).team === 'minion' ? t('DIES') : t('nothing')}</div></div>
        <button class="sm danger" data-a="duel" data-i="${i}" data-kill="1">${t('Dies')}</button><button class="sm" data-a="duel" data-i="${i}" data-kill="0">${t('Nothing')}</button></div>`).join('');
  let votePanel = '';
  if (v) {
    const exile = v.kind === 'exile';
    const rows = seatList().map(p => {
      const val = v.votes[p.pid];
      const ok = canVoteOn(p, v);
      return `<div class="item ${p.alive ? '' : 'dead'} ${ok ? '' : 'novote'}"><div class="main"><span class="name">${esc(p.name)}</span> ${!p.alive && !exile ? pill('dead', ok ? t('👻 ghost vote') : t('💀 cannot vote')) : ''}${!exile && voteWeight(p) > 1 ? pill('', '×2') : ''}</div>
        <button class="sm ${val === true ? 'okb' : ''}" data-a="hostVote" data-pid="${p.pid}" data-v="1" ${ok ? '' : 'disabled'}>${t('✋ Yes')}</button>
        <button class="sm ${val === false ? 'danger' : ''}" data-a="hostVote" data-pid="${p.pid}" data-v="0" ${ok ? '' : 'disabled'}>${t('No')}</button></div>`;
    }).join('');
    const yes = tallyYes(v);
    const voted = seatList().filter(p => canVoteOn(p, v) && v.votes[p.pid] !== undefined).length;
    const eligible = seatList().filter(p => canVoteOn(p, v)).length;
    votePanel = `<div class="card" ${exile ? 'style="border-color:var(--warn)"' : ''}><h2>${exile ? t('Exile: {name}', { name: esc(pname(v.nominee)) }) : `${esc(pname(v.nominator))} → ${esc(pname(v.nominee))}`}</h2>
      ${exile ? `<p class="small muted">${t('Not a vote: everyone, alive or dead, may support it; no ghost votes are spent. Needs half of all players.')}</p>` : ''}
      <div class="votebig">${yes} <span class="small muted">/ ${t('{n} needed', { n: voteNeed(v) })}${!exile && S.highest ? ' · ' + t('beat {n}', { n: S.highest }) : ''}</span></div>
      <p class="center small muted">${t('{a} of {b} eligible voters have answered', { a: voted, b: eligible })}</p>
      <div class="list">${rows}</div>
      <div class="grid2" style="margin-top:8px"><button data-a="cancelVote">${t('Cancel')}</button><button class="primary" data-a="closeVote">${t('Close vote & count')}</button></div></div>`;
  }
  return `
    <div class="card"><div class="row"><div class="grow small">${esc(tx(S.announce))}</div></div>
      <div class="small muted">${t('{a} alive · {n} votes to execute', { a: alivePlayers().length, n: threshold() })}</div>
      ${S.block ? `<div class="banner evil" style="margin:8px 0 0">${t('On the block: {name} ({n})', { name: `<b>${esc(pname(S.block.pid))}</b>`, n: S.block.votes })}</div>` : ''}</div>
    <div class="card"><div class="row"><div class="grow"><b>${S.nomsOpen ? t('Nominations open') : t('Nominations closed')}</b>
      <div class="small muted">${S.nomsOpen ? t('Players can nominate from their phones. You open each vote.') : t('Let the town talk first, then open nominations.')}</div></div>
      <button class="${S.nomsOpen ? '' : 'good'}" data-a="toggleNoms" ${v ? 'disabled' : ''}>${S.nomsOpen ? t('Close') : t('Open')}</button></div></div>
    ${reqs ? `<div class="card"><h3>${t('Requests')}</h3><div class="list">${reqs}</div></div>` : ''}
    ${votePanel}
    ${!v ? `<div class="card"><h3>${t('Start a nomination')}</h3>
      <label>${t('Nominator')}</label><select id="nomA">${alivePlayers().filter(p => !p.nominated).map(p => `<option value="${p.pid}">${esc(p.name)}</option>`).join('')}</select>
      <label>${t('Nominee')}</label><select id="nomB">${seatList().filter(p => !p.wasNominated).map(p => `<option value="${p.pid}">${esc(p.name)}</option>`).join('')}</select>
      <button class="good block" style="margin-top:8px" data-a="manualNom">${t('Open vote')}</button></div>` : ''}
    ${!v && seatList().some(p => isTraveller(p) && p.alive) ? `<div class="card"><h3>${t('Exile a Traveller')}</h3>
      <p class="small muted">${t('Any player may call for it. Needs support from half of all players ({n}), alive or dead. It does not use up the day’s execution.', { n: exileThreshold() })}</p>
      <label>${t('Traveller')}</label><select id="exT">${seatList().filter(p => isTraveller(p) && p.alive && !S.exiledToday.includes(p.pid)).map(p => `<option value="${p.pid}">${esc(p.name)}</option>`).join('')}</select>
      <label>${t('Called by')}</label><select id="exC"><option value="">—</option>${seatList().map(p => `<option value="${p.pid}">${esc(p.name)}</option>`).join('')}</select>
      <button class="block" style="margin-top:8px" data-a="manualExile">${t('Open exile')}</button></div>` : ''}
    ${S.nominations.length ? `<div class="card"><h3>${t("Today's votes")}</h3>${S.nominations.map(n => `<div class="small">${esc(pname(n.nominator))} → <b>${esc(pname(n.nominee))}</b>: ${n.votes} <span class="muted">(${esc(n.voters.join(', '))})</span></div>`).join('')}</div>` : ''}
    <button class="primary block" data-a="openEndDay" ${v ? 'disabled' : ''}>${t('Close all voting & end the day 🌙')}</button>`;
}

function viewLog() {
  return `<div class="card">${S.log.slice().reverse().map(l => `<div class="small" style="margin-bottom:6px"><span class="pill">${l.phase}</span> ${esc(l.text)}</div>`).join('') || `<p class="muted">${t('Nothing yet.')}</p>`}</div>`;
}
function viewMore() {
  const gv = S.ghostVotes !== false;
  return `
    <div class="card stack"><h2>${t('Broadcast')}</h2>
      <textarea id="bcast" placeholder="${esc(t('Message to every player'))}"></textarea>
      <button class="good block" data-a="broadcast">${t('Send to all')}</button></div>
    ${S.locked && S.phase !== 'over' ? `<div class="card stack"><h2>${t('Phase control')}</h2>
      <div class="grid2"><button data-a="forceNight">${t('Jump to night')}</button><button data-a="forceDay">${t('Jump to day')}</button></div>
      <div class="grid2"><button class="good" data-a="win" data-side="good">${t('Good wins')}</button><button class="danger" data-a="win" data-side="evil">${t('Evil wins')}</button></div></div>` : ''}
    <div class="card stack"><h2>${t('Rules')}</h2>
      <div class="row"><div class="grow"><b>${t('Ghost votes')}</b><div class="small muted">${gv
        ? t('On (official rule): each dead player may vote once more for the rest of the game.')
        : t('Off (house rule): dead players cannot vote at all.')}</div></div>
        <button class="sm ${gv ? 'okb' : ''}" data-a="toggleGhostVotes">${gv ? t('On') : t('Off')}</button></div></div>
    <div class="card stack"><h2>${t('Room')}</h2><p class="small muted">${t('Code {code}. State is saved on this device; refreshing is safe.', { code: `<b>${S.room}</b>` })}</p>
      <button class="danger block" data-a="endRoom">${t('Close room & start over')}</button></div>`;
}

// ---------- sheets ----------
function renderSheet() {
  if (!sheet) { $sheet.innerHTML = ''; return; }
  if (sheet.type === 'player') {
    const p = S.players[sheet.pid]; if (!p) { sheet = null; $sheet.innerHTML = ''; return; }
    const opts = (cur) => `<option value="">—</option>` + ROLES.map(r => `<option value="${r.id}" ${cur === r.id ? 'selected' : ''}>${r.icon} ${esc(r.name)} (${teamLabel(r.team)})</option>`).join('');
    $sheet.innerHTML = `<div class="sheet-bg" data-a="closeSheet"><div class="sheet" data-stop="1">
      <div class="row"><h2 class="grow">${esc(p.name)}</h2><button class="sm ghost" data-a="closeSheet">✕</button></div>
      <label>${t('Character')}</label><select data-ch="role" data-pid="${p.pid}">${opts(p.role)}</select>
      <label>${t('Thinks they are')} <span class="small">${t('(for Drunk-style characters; their phone shows this one)')}</span></label><select data-ch="fakeRole" data-pid="${p.pid}">${opts(p.fakeRole)}</select>
      <label>${t('Alignment')}</label><select data-ch="alignment" data-pid="${p.pid}">
        <option value="" ${!p.alignment ? 'selected' : ''}>${t('From character type')}</option>
        <option value="good" ${p.alignment === 'good' ? 'selected' : ''}>${t('Good')}</option>
        <option value="evil" ${p.alignment === 'evil' ? 'selected' : ''}>${t('Evil')}</option></select>
      <div class="grid2" style="margin-top:10px">
        <button data-a="toggleFlag" data-f="drunk" data-pid="${p.pid}">${p.drunk ? t('🍺 Drunk: yes') : t('🍺 Drunk: no')}</button>
        <button data-a="toggleFlag" data-f="poisoned" data-pid="${p.pid}">${p.poisoned ? t('☠ Poisoned: yes') : t('☠ Poisoned: no')}</button>
      </div>
      <label>${t('Reminder tokens')}</label>
      <div class="row" style="gap:6px">${reminderOptions().map(x => `<button class="sm ${(p.reminders || []).includes(x) ? 'primary' : ''}" data-a="toggleReminder" data-pid="${p.pid}" data-r="${esc(x)}">🔖 ${esc(x)}</button>`).join('')}</div>
      <div class="row" style="margin-top:6px"><input id="customReminder" class="grow" placeholder="${esc(t('Custom reminder…'))}" style="min-height:40px"><button class="sm" data-a="addReminder" data-pid="${p.pid}">+</button></div>
      ${S.locked ? `<div class="grid2" style="margin-top:10px">
        <button class="${p.alive ? 'danger' : 'okb'}" data-a="toggleAlive" data-pid="${p.pid}">${p.alive ? t('💀 Kill') : t('❤️ Revive')}</button>
        <button data-a="toggleFlag" data-f="ghostVote" data-pid="${p.pid}">${p.ghostVote ? t('👻 Ghost vote: yes') : t('👻 Ghost vote: used')}</button>
        <button data-a="toggleFlag" data-f="cursed" data-pid="${p.pid}">${p.cursed ? t('🕸 Cursed: yes') : t('🕸 Cursed: no')}</button>
        <button data-a="toggleFlag" data-f="protected" data-pid="${p.pid}">${p.protected ? t('🌿 Safe: yes') : t('🌿 Safe: no')}</button>
      </div>` : ''}
      <label>${t('Private message')}</label><textarea id="pmsg" placeholder="${esc(t('Only {name} sees this', { name: p.name }))}"></textarea>
      <button class="good block" style="margin-top:6px" data-a="pmsg" data-pid="${p.pid}">${t('Send')}</button>
      ${p.msgs.length ? `<h3 style="margin-top:12px">${t('Sent to them')}</h3>${p.msgs.slice(-6).reverse().map(m => `<div class="msg small">${esc(tx(m.text))}</div>`).join('')}` : ''}
    </div></div>`;
  } else if (sheet.type === 'seatTraveller') {
    const p = S.players[sheet.pid]; if (!p) { sheet = null; $sheet.innerHTML = ''; return; }
    const tr = scriptTravellers();
    $sheet.innerHTML = `<div class="sheet-bg" data-a="closeSheet"><div class="sheet" data-stop="1">
      <div class="row"><h2 class="grow">${t('Seat {name} as a Traveller', { name: esc(p.name) })}</h2><button class="sm ghost" data-a="closeSheet">✕</button></div>
      ${tr.length ? '' : `<p class="small" style="color:var(--warn)">${t('This script has no Travellers. Import a script that lists some.')}</p>`}
      <label>${t('Traveller character (announced to everyone)')}</label><select id="stRole">${tr.map(r => `<option value="${r.id}">${r.icon} ${esc(r.name)}</option>`).join('')}</select>
      <label>${t('Alignment (secret; usually good)')}</label><select id="stAlign"><option value="good">${t('Good')}</option><option value="evil">${t('Evil')}</option></select>
      <label>${t('Sits after')}</label><select id="stAfter">${seatList().map(x => `<option value="${x.pid}">${esc(x.name)}</option>`).join('')}</select>
      <button class="primary block" style="margin-top:12px" data-a="seatTraveller" data-pid="${p.pid}" ${tr.length ? '' : 'disabled'}>${t('Seat as Traveller')}</button>
    </div></div>`;
  } else if (sheet.type === 'endDay') {
    const ranked = S.nominations.slice().sort((a, b) => b.votes - a.votes);
    const b = S.block && S.players[S.block.pid];
    const top = ranked[0];
    const tie = !b && top && top.votes >= threshold();
    $sheet.innerHTML = `<div class="sheet-bg" data-a="closeSheet"><div class="sheet" data-stop="1">
      <div class="row"><h2 class="grow">${t('End Day {n}', { n: S.day })}</h2><button class="sm ghost" data-a="closeSheet">✕</button></div>
      <h3>${t('All votes today')}</h3>
      ${ranked.length ? ranked.map(n => `<div class="row small" style="margin-bottom:6px"><div class="grow">${esc(pname(n.nominator))} → <b>${esc(pname(n.nominee))}</b>
          <div class="muted">${n.voters.length ? '✋ ' + esc(n.voters.join(', ')) : t('no hands')}</div></div>
          ${pill(S.block && S.block.pid === n.nominee ? 'evil' : '', n.votes + ' / ' + threshold())}</div>`).join('') : `<p class="muted small">${t('No nominations today.')}</p>`}
      <hr>
      ${b ? `<p>${t('Most votes: {name} with {n}.', { name: `<b>${esc(b.name)}</b>`, n: S.block.votes })} ${rolePill(b.role)}</p>
          <p class="small muted">${t('Check the characters in play: some abilities stop the execution or keep the player alive.')}</p>
          <button class="danger block" data-a="endDay" data-mode="kill">${t('💀 Execute {name}: they die', { name: esc(b.name) })}</button>
          <div class="grid2" style="margin-top:8px"><button data-a="endDay" data-mode="survive">${t('Executed, but survives')}</button><button data-a="endDay" data-mode="none">${t('No execution')}</button></div>`
        : `<p>${tie ? t('Tie at {n}: nobody is executed.', { n: top.votes }) : t('Nobody reached enough votes: nobody is executed.')}</p>
          <button class="primary block" data-a="endDay" data-mode="none">${t('End day without execution')}</button>`}
    </div></div>`;
  } else if (sheet.type === 'import') {
    const lib = libStore();
    const nsN = lib.nightsheet ? lib.nightsheet.firstNight.length + lib.nightsheet.otherNight.length : 0;
    const jxN = Object.keys(lib.jinxes || {}).length;
    $sheet.innerHTML = `<div class="sheet-bg" data-a="closeSheet"><div class="sheet" data-stop="1">
      <div class="row"><h2 class="grow">${t('Import a script')}</h2><button class="sm ghost" data-a="closeSheet">✕</button></div>
      ${S.script ? `<div class="small" style="margin-bottom:8px">${t('Current script:')} <b>${esc(S.script.name)}</b>${sourceLine(S.script.source)}</div>` : ''}
      <h3>${t('Official scripts')}</h3>
      <div class="grid3">${EDITIONS.map(([id, name]) => `<button class="primary" data-a="importEdition" data-id="${id}" ${sheet.busy ? 'disabled' : ''}>${esc(name)}</button>`).join('')}</div>
      ${officialScripts && officialScripts.length ? `<label>${t('Community scripts (official release)')}</label>
        <div class="grid2">${officialScripts.map(s => `<button class="scriptbtn" data-a="importOfficialScript" data-id="${esc(s.id)}" ${sheet.busy ? 'disabled' : ''}>${esc(s.name)}${s.author ? `<span>${esc(s.author)}</span>` : ''}</button>`).join('')}</div>` : officialScripts ? `<p class="small muted">${t('Loading the official script list…')}</p>` : ''}
      <p class="small muted">${sheet.busy ? t('Downloading…') + ' ' : ''}${t('Downloaded from The Pandemonium Institute\'s public release (release.botc.app) together with the official character list, night order and jinxes. Blood on the Clocktower is © The Pandemonium Institute; this app is unofficial community content.')}</p>
      <p class="small muted" style="margin:4px 0 0">${t('Sources:')} ${[['roles.json', '/resources/data/roles.json'], ['nightsheet.json', '/resources/data/nightsheet.json'], ['jinxes.json', '/resources/data/jinxes.json'], [t('community script list'), '/wc25/data.json']].map(([n, u]) => `<a href="${OFFICIAL + u}" target="_blank" rel="noopener" style="color:var(--accent)">${esc(n)}</a>`).join(' · ')}</p>
      ${sheet.offErr ? `<p class="small" style="color:var(--evil)">${esc(t(sheet.offErr))}</p>` : ''}
      <hr>
      <h3>${t('Your own script')}</h3>
      <p class="small muted" style="margin:0 0 6px">${t('More scripts: build one in the official Script Tool or find one on botcscripts.com, then download its JSON and load it here.')}
        <a href="https://script.bloodontheclocktower.com/" target="_blank" rel="noopener" style="color:var(--accent)">Script Tool ↗</a> · <a href="https://botcscripts.com/" target="_blank" rel="noopener" style="color:var(--accent)">botcscripts.com ↗</a></p>
      <p class="small muted">${t('Paste or load the JSON exported by an online script builder: a list like')}
        <code>[{"id":"_meta","name":"…"}, "characterid", {…}]</code>.
        ${t('Custom characters with their own name/team/ability work as-is. Plain ids need a character library (below).')}</p>
      <label>${t('Script URL (raw JSON)')}</label><input id="scriptUrl" type="url" placeholder="https://…/script.json" value="${esc(sheet.url || '')}">
      <label>${t('…or a file')}</label><input type="file" accept=".json,application/json" data-ch="file" data-target="scriptText">
      <label>${t('…or paste JSON')}</label><textarea id="scriptText" placeholder='[{"id":"_meta","name":"My script"}, …]'>${esc(sheet.text || '')}</textarea>
      ${sheet.err ? `<p class="small" style="color:var(--evil)">${esc(t(sheet.err))}</p>` : ''}
      <div class="grid2" style="margin-top:8px"><button data-a="useBuiltin">${t('Use built-in set')}</button><button class="primary" data-a="importScript" ${sheet.busy ? 'disabled' : ''}>${t('Import script')}</button></div>
      <hr>
      <h3>${t('Character library')}</h3>
      <div class="row" style="gap:6px;margin-bottom:6px">${pill(lib.roles.length ? 'ok' : '', t('{n} characters', { n: lib.roles.length }))}${pill(nsN ? 'ok' : '', nsN ? t('night sheet ✓') : t('no night sheet'))}${pill(jxN ? 'ok' : '', t('{n} jinx entries', { n: jxN }))}</div>
      ${lib.roles.length ? `<p class="small muted" style="margin:0 0 6px">${t('Library source:')} ${lib.source === 'official' ? `<a href="${OFFICIAL}/resources/data/roles.json" target="_blank" rel="noopener" style="color:var(--accent)">release.botc.app</a>${lib.at ? ' · ' + new Date(lib.at).toLocaleDateString() : ''}` : t('your own files')}</p>` : ''}
      <p class="small muted">${t('Load your own data files here, one at a time; the app detects which kind each is: a character list (id, name, team, ability, …), a night sheet ({"firstNight": [...], "otherNight": [...]}) or a jinx list. Scripts that only list ids are looked up in it. Saved on this device.')}</p>
      <label>${t('Library URL')}</label><input id="libUrl" type="url" placeholder="https://…/characters.json">
      <label>${t('…or a file')}</label><input type="file" accept=".json,application/json" data-ch="file" data-target="libText">
      <label>${t('…or paste JSON')}</label><textarea id="libText"></textarea>
      ${sheet.libErr ? `<p class="small" style="color:var(--evil)">${esc(t(sheet.libErr))}</p>` : ''}
      <button class="block" style="margin-top:8px" data-a="importOfficialLibrary" ${sheet.busy ? 'disabled' : ''}>${lib.source === 'official' ? t('Update official library') : t('Load official library')}</button>
      <div class="grid2" style="margin-top:8px"><button data-a="clearLibrary" ${lib.roles.length || nsN || jxN ? '' : 'disabled'}>${t('Clear library')}</button><button class="good" data-a="importLibrary" ${sheet.busy ? 'disabled' : ''}>${t('Import library')}</button></div>
    </div></div>`;
  }
}

// ---------- script import ----------
// The Storyteller's own data files, saved on this device: { roles: [...], nightsheet: {...} | null, jinxes: {...} }.
function libStore() {
  const v = store.get('nf_library', null);
  if (Array.isArray(v)) return { roles: v, nightsheet: null, jinxes: {} }; // older format: plain character list
  return Object.assign({ roles: [], nightsheet: null, jinxes: {} }, v || {});
}
// Reminder tokens the Storyteller can place: from characters on the script, plus any already in use.
function reminderOptions() {
  const set = new Set();
  const inPlay = new Set(seatList().map(p => p.role));
  for (const r of ROLES) {
    if (inPlay.has(r.id)) (r.reminders || []).forEach(x => set.add(x));
    (r.remindersGlobal || []).forEach(x => set.add(x));
  }
  for (const p of seatList()) (p.reminders || []).forEach(x => set.add(x));
  return [...set];
}
// Read the inputs before any re-render (re-rendering the sheet would wipe them).
function sourceOf(urlId, textId) {
  return { url: document.getElementById(urlId).value.trim(), text: document.getElementById(textId).value.trim() };
}
async function readSource({ url, text }) {
  if (text) return text;
  if (url) return ScriptImport.fetchText(url);
  throw new Error('Paste JSON, choose a file, or enter a URL.');
}
// Where the current script came from: { label, url } (url may be empty for a file or pasted JSON).
function sourceLine(src) {
  if (!src) return '';
  const link = src.url ? `<a href="${esc(src.url)}" target="_blank" rel="noopener" style="color:var(--accent);word-break:break-all">${esc(src.label || src.url)} ↗</a>` : esc(t(src.label));
  return `<p class="small muted" style="margin:6px 0 0">${t('Source:')} ${link}</p>`;
}
// ---------- official data ----------
// The Pandemonium Institute publishes these files for community toolmakers (release.botc.app, CORS-open).
// Nothing official ships with the app: it is downloaded on request and saved on this device.
const OFFICIAL = 'https://release.botc.app';
const EDITIONS = [['tb', 'Trouble Brewing'], ['bmr', 'Bad Moon Rising'], ['snv', 'Sects & Violets']];
let officialScripts = null; // [{id, name, author}] from the official script list, loaded when the sheet opens
async function loadOfficialLibrary() {
  const get = (f) => ScriptImport.fetchText(OFFICIAL + '/resources/data/' + f).then(ScriptImport.parseLibrary);
  const [roles, ns, jx] = await Promise.all([get('roles.json'), get('nightsheet.json'), get('jinxes.json')]);
  const lib = { roles: roles.data, nightsheet: ns.data, jinxes: jx.data, source: 'official', at: Date.now() };
  store.set('nf_library', lib);
  return lib;
}
async function officialLib() {
  const lib = libStore();
  return lib.source === 'official' && lib.roles.length ? lib : loadOfficialLibrary();
}
function loadOfficialScriptList() {
  if (officialScripts) return;
  officialScripts = [];
  ScriptImport.fetchText(OFFICIAL + '/wc25/data.json').then(txt => {
    const d = JSON.parse(txt);
    officialScripts = (d.scripts || []).map(s => ({ id: String(s.id).replace(/[^a-z0-9]/gi, ''), name: s.name, author: s.author }));
    if (sheet && sheet.type === 'import') renderSheet();
  }).catch(() => { officialScripts = null; });
}
async function importOfficial(kind, id) {
  sheet.busy = true; sheet.offErr = ''; renderSheet();
  try {
    const lib = await officialLib();
    let json, src;
    if (kind === 'edition') {
      const name = (EDITIONS.find(e => e[0] === id) || [id, id])[1];
      json = [{ id: '_meta', name, author: 'The Pandemonium Institute' }, ...lib.roles.filter(r => r.edition === id).map(r => r.id)];
      src = { label: 'release.botc.app · roles.json (edition "' + id + '")', url: OFFICIAL + '/resources/data/roles.json' };
    } else {
      src = { url: OFFICIAL + '/wc25/' + id + '/script.json', label: 'release.botc.app/wc25/' + id + '/script.json' };
      json = await ScriptImport.fetchText(src.url);
    }
    useScript(parseScript(json, lib), src);
  } catch (e) {
    sheet.busy = false; sheet.offErr = e.message; renderSheet();
  }
}
async function importOfficialLibrary() {
  sheet.busy = true; sheet.libErr = ''; renderSheet();
  try {
    const lib = await loadOfficialLibrary();
    toast(t('Official library saved: {n} characters.', { n: lib.roles.length }));
  } catch (e) { sheet.libErr = e.message; }
  sheet.busy = false; renderSheet();
}

async function importScript() {
  const src = sourceOf('scriptUrl', 'scriptText');
  sheet.url = src.url; sheet.text = src.text;
  sheet.busy = true; sheet.err = ''; renderSheet();
  try {
    useScript(parseScript(await readSource(src), libStore()), src.text ? { label: 'pasted JSON or a file' } : { url: src.url });
  } catch (e) {
    sheet.busy = false; sheet.err = e.message; renderSheet();
  }
}
// Official rule: a script with jinxed pairs has the Djinn in play. Add it from the library when the script doesn't list it.
function parseScript(json, lib) {
  const parsed = ScriptImport.parse(json, lib);
  if (!parsed.jinxes.length || parsed.fabled.some(r => r.id === 'djinn') || !(lib.roles || []).some(r => ScriptImport.normId(r.id) === 'djinn')) return parsed;
  const data = typeof json === 'string' ? JSON.parse(json) : json;
  return Array.isArray(data) ? ScriptImport.parse([...data, 'djinn'], lib) : parsed;
}
function useScript(parsed, source) {
  {
    parsed.source = source || null;
    S.script = parsed; applyScript();
    S.selection = []; S.dealt = false; S.bluffs = [];
    // Jinxed pairs on the script bring the Djinn into play, if the library defines it.
    S.fabledOn = parsed.jinxes.length && parsed.fabled.some(r => r.id === 'djinn') ? ['djinn'] : [];
    log(L('Script imported: {name} ({n} characters).', { name: parsed.name, n: parsed.roles.length }));
    toast(t('Imported "{name}": {n} characters', { name: parsed.name, n: parsed.roles.length }) + (parsed.missing.length ? ', ' + t('{n} unknown', { n: parsed.missing.length }) : ''));
    sheet = null; save();
  }
}
async function importLibrary() {
  const src = sourceOf('libUrl', 'libText');
  sheet.busy = true; sheet.libErr = ''; renderSheet();
  try {
    const res = ScriptImport.parseLibrary(await readSource(src));
    const lib = libStore();
    if (res.kind === 'roles') { lib.roles = res.data; toast(t('Library saved: {n} characters. Now import your script.', { n: res.data.length })); }
    else if (res.kind === 'nightsheet') { lib.nightsheet = res.data; toast(t('Night sheet saved.')); }
    else { lib.jinxes = res.data; toast(t('Jinx list saved: {n} entries.', { n: Object.keys(res.data).length })); }
    store.set('nf_library', lib);
    document.getElementById('libText').value = '';
    sheet.busy = false; renderSheet();
  } catch (e) {
    sheet.busy = false; sheet.libErr = e.message; renderSheet();
  }
}

// ---------- events ----------
document.addEventListener('change', (e) => {
  const el = e.target; if (!el.dataset.ch) return;
  if (el.dataset.ch === 'file') {
    const f = el.files && el.files[0]; if (!f) return;
    f.text().then(txt => { document.getElementById(el.dataset.target).value = txt; });
    return;
  }
  const p = S.players[el.dataset.pid]; if (!p) return;
  if (el.dataset.ch === 'role') {
    const was = p.role;
    p.role = el.value || null;
    if (was === 'sleepwalker' && p.role !== 'sleepwalker') p.fakeRole = null;
    if (p.role === 'sleepwalker' && !p.fakeRole) {
      const free = ROLES.find(r => r.team === 'townsfolk' && !seatList().some(x => x.role === r.id));
      p.fakeRole = free ? free.id : null;
    }
    if (S.locked && p.role) {
      const r = role(shownRole(p));
      msg(p.pid, L('Your character is now the {role}. {ability}', { role: R(r), ability: RA(r) }));
      log(L('{name} is now {role}.', { name: p.name, role: roleRef(p.role) }));
    }
  } else if (el.dataset.ch === 'fakeRole') { p.fakeRole = el.value || null; }
  else if (el.dataset.ch === 'alignment') {
    p.alignment = el.value || null;
    if (S.locked) log(L('{name} is now {align}.', { name: p.name, align: L(isEvil(p) ? 'evil' : 'good') }));
  }
  save();
});

document.addEventListener('click', (e) => {
  const stop = e.target.closest('[data-stop]');
  const el = e.target.closest('[data-a]');
  if (!el) return;
  if (stop && !stop.contains(el)) return;
  if (stop && el.dataset.a === 'closeSheet' && el.classList.contains('sheet-bg')) return;
  const d = el.dataset; const a = d.a;
  const st = d.key ? S.steps.find(x => x.key === d.key) : null;
  switch (a) {
    case 'create': if (!creating) createRoom(); break;
    case 'tab': tab = d.k; render(); window.scrollTo(0, 0); break;
    case 'seatUp': case 'seatDown': {
      const i = S.seats.indexOf(d.pid); const j = a === 'seatUp' ? i - 1 : i + 1;
      if (j >= 0 && j < S.seats.length) [S.seats[i], S.seats[j]] = [S.seats[j], S.seats[i]];
      save(); break;
    }
    case 'kick': if (confirm(t('Remove {name}?', { name: pname(d.pid) }))) { net.send({ t: 'kick', pid: d.pid }); } break;
    case 'toggleRole': {
      const i = S.selection.indexOf(d.id);
      if (i >= 0) S.selection.splice(i, 1); else S.selection.push(d.id);
      S.phase = 'setup'; render(); store.set('nf_host_state', S); break;
    }
    case 'randomRoles': randomSelection(); S.phase = 'setup'; save(); break;
    case 'openImport': sheet = { type: 'import' }; loadOfficialScriptList(); renderSheet(); break;
    case 'importEdition': importOfficial('edition', d.id); break;
    case 'importOfficialScript': if (d.id) importOfficial('script', d.id); break;
    case 'importOfficialLibrary': importOfficialLibrary(); break;
    case 'toggleTraveller': {
      const i = S.travellerPids.indexOf(d.pid);
      if (i >= 0) S.travellerPids.splice(i, 1); else S.travellerPids.push(d.pid);
      S.dealt = false; save(); break;
    }
    case 'toggleFabled': {
      const i = S.fabledOn.indexOf(d.id);
      if (i >= 0) S.fabledOn.splice(i, 1);
      else { S.fabledOn.push(d.id); if (S.locked) { msgAll(L('The Storyteller adds the {role}.', { role: roleRef(d.id) })); log(L('Added the {role}.', { role: roleRef(d.id) })); } }
      save(); break;
    }
    case 'openSeatTraveller': sheet = { type: 'seatTraveller', pid: d.pid }; renderSheet(); break;
    case 'seatTraveller': {
      const r = document.getElementById('stRole').value, al = document.getElementById('stAlign').value, after = document.getElementById('stAfter').value;
      sheet = null; seatTraveller(d.pid, r, al, after); break;
    }
    case 'toggleReminder': {
      const p = S.players[d.pid]; p.reminders = p.reminders || [];
      const i = p.reminders.indexOf(d.r);
      if (i >= 0) p.reminders.splice(i, 1); else p.reminders.push(d.r);
      save(); break;
    }
    case 'addReminder': {
      const txt = document.getElementById('customReminder').value.trim(); if (!txt) break;
      const p = S.players[d.pid]; p.reminders = p.reminders || [];
      if (!p.reminders.includes(txt)) p.reminders.push(txt);
      save(); break;
    }
    case 'acceptExile': { const r = S.requests[Number(d.i)]; if (r) openExile(r.pid, r.target); break; }
    case 'manualExile': { const tg = document.getElementById('exT').value; if (tg) openExile(document.getElementById('exC').value || null, tg); break; }
    case 'importScript': importScript(); break;
    case 'importLibrary': importLibrary(); break;
    case 'clearLibrary': if (confirm(t('Remove the saved character library?'))) { store.del('nf_library'); renderSheet(); } break;
    case 'useBuiltin': S.script = null; applyScript(); S.selection = []; S.dealt = false; S.bluffs = []; sheet = null; toast(t('Using the built-in Nightfall set')); save(); break;
    case 'setChoose': if (st) { st.chooseN = Number(d.n); st.choice = st.choice.slice(0, Number(d.n)); save(); } break;
    case 'toggleGhostVotes': S.ghostVotes = !(S.ghostVotes !== false); log(L(S.ghostVotes ? 'Ghost votes on.' : 'Ghost votes off.')); save(); break;
    case 'deal': deal(); break;
    case 'start': startGame(); break;
    case 'sheetPlayer': sheet = { type: 'player', pid: d.pid }; renderSheet(); break;
    case 'closeSheet': sheet = null; renderSheet(); break;
    case 'toggleAlive': {
      const p = S.players[d.pid];
      if (p.alive) killPlayer(p.pid, 'Storyteller'); else { p.alive = true; p.ghostVote = true; log(L('{name} revived.', { name: p.name })); }
      save(); break;
    }
    case 'toggleFlag': { const p = S.players[d.pid]; p[d.f] = !p[d.f]; save(); break; }
    case 'pmsg': { const txt = document.getElementById('pmsg').value.trim(); if (txt) { msg(d.pid, txt); toast(t('Sent')); save(); } break; }
    case 'broadcast': { const txt = document.getElementById('bcast').value.trim(); if (txt) { msgAll('📣 ' + txt); toast(t('Sent to all')); save(); } break; }
    case 'sendMinionInfo': sendMinionInfo(); S.stepIdx++; save(); break;
    case 'sendDemonInfo': sendDemonInfo(); S.stepIdx++; save(); break;
    case 'prompt': promptPlayer(st); break;
    case 'hostChoose': {
      const max = Number(d.max) || 1;
      const i = st.choice.indexOf(d.pid);
      if (i >= 0) st.choice.splice(i, 1); else { st.choice.push(d.pid); if (st.choice.length > max) st.choice.shift(); }
      st.status = 'answered';
      const p = S.players[st.pid]; if (p.prompt && p.prompt.step === st.key) p.prompt = null;
      save(); break;
    }
    case 'sendInfo': {
      const txt = document.getElementById('info-' + d.key).value.trim();
      if (txt) { msg(st.pid, '🌙 ' + txt); st.sent = txt; log(L('Info to {name} ({role}): {text}', { name: pname(st.pid), role: roleRef(st.roleId), text: txt })); toast(t('Info sent')); save(); }
      break;
    }
    case 'nextStep': {
      const cur = S.steps[S.stepIdx];
      if (cur && cur.kind === 'role') { applyImmediateEffects(cur); const p = S.players[cur.pid]; if (p.prompt && p.prompt.step === cur.key) p.prompt = null; }
      S.stepIdx = Math.min(S.steps.length - 1, S.stepIdx + 1);
      if (S.steps[S.stepIdx].kind === 'dawn') S.dawn = null;
      save(); break;
    }
    case 'prevStep': S.stepIdx = Math.max(0, S.stepIdx - 1); save(); break;
    case 'gotoStep': S.stepIdx = Number(d.i); if (S.steps[S.stepIdx].kind === 'dawn') S.dawn = null; save(); break;
    case 'toggleDeath': {
      const i = S.dawn.deaths.indexOf(d.pid);
      if (i >= 0) S.dawn.deaths.splice(i, 1); else S.dawn.deaths.push(d.pid);
      render(); break;
    }
    case 'startDay': startDay(); break;
    case 'acceptNom': { const r = S.requests[Number(d.i)]; if (r) openVote(r.pid, r.target); break; }
    case 'dropReq': { const r = S.requests.splice(Number(d.i), 1)[0]; if (r) msg(r.pid, L('Your request was declined by the Storyteller.')); save(); break; }
    case 'duel': resolveDuel(Number(d.i), d.kill === '1'); break;
    case 'manualNom': openVote(document.getElementById('nomA').value, document.getElementById('nomB').value); break;
    case 'hostVote': if (S.vote) { S.vote.votes[d.pid] = d.v === '1'; save(); } break;
    case 'cancelVote': if (S.vote) {
      if (S.vote.kind === 'exile') S.exiledToday = S.exiledToday.filter(x => x !== S.vote.nominee);
      else { S.players[S.vote.nominator].nominated = false; S.players[S.vote.nominee].wasNominated = false; }
      S.vote = null; S.announce = L('Vote cancelled.'); save();
    } break;
    case 'closeVote': closeVote(); break;
    case 'openEndDay': if (S.vote) toast(t('Close the open vote first.')); else { sheet = { type: 'endDay' }; renderSheet(); } break;
    case 'endDay': sheet = null; endDay(d.mode); break;
    case 'toggleNoms': {
      S.nomsOpen = !S.nomsOpen;
      if (!S.nomsOpen) S.requests = S.requests.filter(r => r.kind !== 'nominate');
      S.announce = L(S.nomsOpen ? 'Nominations are open.' : 'Nominations are closed.');
      msgAll(['📣 ', S.announce]); log(S.announce); save(); break;
    }
    case 'forceNight': if (confirm(t('Skip to night?'))) { S.vote = null; S.block = null; startNight(); } break;
    case 'forceDay': if (confirm(t('Skip to day (applies dawn deaths)?'))) startDay(); break;
    case 'win': if (confirm(t(d.side === 'good' ? 'Declare good the winner?' : 'Declare evil the winner?'))) { endGame(d.side, L('Storyteller decision.')); save(); } break;
    case 'newGame': {
      const keep = { room: S.room, hostToken: S.hostToken, seats: S.seats, players: S.players, script: S.script, ghostVotes: S.ghostVotes, fabledOn: S.fabledOn };
      S = freshState(keep.room, keep.hostToken); S.seats = keep.seats; S.script = keep.script; S.ghostVotes = keep.ghostVotes; S.fabledOn = keep.fabledOn;
      for (const id of keep.seats) S.players[id] = newPlayer(id, keep.players[id].name);
      syncPresence(); tab = 'setup'; S.phase = 'setup'; save(); break;
    }
    case 'endRoom': if (confirm(t('Close this room? The game will be lost.'))) { store.del('nf_host'); store.del('nf_host_state'); location.reload(); } break;
  }
});

render();
