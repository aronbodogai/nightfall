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

function freshState(room, hostToken) {
  return {
    v: 1, room, hostToken, locked: false, phase: 'lobby', day: 0, night: 0,
    seats: [], players: {}, selection: [], bluffs: [], steps: [], stepIdx: 0,
    nominations: [], vote: null, block: null, requests: [], executedToday: null, lastExecuted: null,
    debtorNight: false, dawn: null, winner: null, log: [], announce: '', promptSeq: 1,
    script: null,       // imported script { name, author, roles, missing, skipped } or null = built-in set
    ghostVotes: true,   // official rule: each dead player keeps one vote for the rest of the game
  };
}
function applyScript() { setRoles(S && S.script ? S.script.roles : BASE_ROLES); }

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
    toast('Could not create a room: ' + e.message);
  }
  creating = false; render();
}

function onMsg(m) {
  if (m.t === 'resumed') {
    const local = store.get('nf_host_state');
    S = (local && local.room === m.room) ? local : freshState(m.room, store.get('nf_host').hostToken);
    if (S.ghostVotes === undefined) S.ghostVotes = true;
    applyScript();
    presence = m.players || [];
    syncPresence();
    tab = S.locked ? (S.phase === 'day' ? 'day' : S.phase === 'night' ? 'night' : 'grim') : (S.phase === 'setup' ? 'setup' : 'lobby');
    save();
  } else if (m.t === 'error' && m.code === 'no_room') {
    // Room expired or server restarted: start over.
    net.disconnect();
    store.del('nf_host'); store.del('nf_host_state');
    toast('That room no longer exists on the server. Create a new one; players rejoin with the new code.');
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
      if (!S.locked) S.seats.push(p.pid);
    }
    S.players[p.pid].name = p.name;
    S.players[p.pid].connected = p.connected;
  }
  if (!S.locked) {
    const ids = new Set(presence.map(p => p.pid));
    S.seats = S.seats.filter(id => ids.has(id));
    for (const id of Object.keys(S.players)) if (!ids.has(id)) delete S.players[id];
  }
}
function newPlayer(pid, name) {
  return { pid, name, connected: true, role: null, fakeRole: null, alive: true, ghostVote: true,
    cursed: false, protected: false, sentinelUsed: false, luckyUsed: false, duelUsed: false, hollowUsed: false,
    nominated: false, wasNominated: false, msgs: [], prompt: null, evilInfo: null };
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
const isEvil = (p) => p && p.role && isEvilTeam(role(p.role).team);
const shownRole = (p) => p.fakeRole || p.role;
// Sleepwalker, or anyone the Storyteller has set to "thinks they are" another character (Drunk-style roles).
const malfunctioning = (p) => p.cursed || p.role === 'sleepwalker' || (!!p.fakeRole && p.fakeRole !== p.role);
// Living players always vote; dead players only while they still hold their ghost vote (if that rule is on).
const canVote = (p) => !!p && (p.alive || (S.ghostVotes !== false && p.ghostVote));
function tallyYes(v) {
  let n = 0;
  for (const [pid, yes] of Object.entries(v.votes)) { const p = S.players[pid]; if (yes && canVote(p)) n += voteWeight(p); }
  return n;
}

function buildViews() {
  const views = {};
  const seats = seatList().map((p, i) => ({ pid: p.pid, name: p.name, seat: i + 1, alive: p.alive, ghostVote: p.ghostVote, canVote: canVote(p) }));
  // Roles are only revealed to everyone once the game is over.
  const reveal = S.winner ? seatList().map(p => ({ name: p.name, role: role(p.role).name, icon: role(p.role).icon, team: role(p.role).team,
    thought: p.fakeRole ? role(p.fakeRole).name : null })) : null;
  for (const p of seatList()) {
    const r = p.role ? role(shownRole(p)) : null;
    const v = S.vote;
    views[p.pid] = {
      room: S.room, phase: S.phase, day: S.day, night: S.night, winner: S.winner, announce: S.announce, reveal,
      seats, threshold: threshold(),
      me: {
        pid: p.pid, name: p.name, alive: p.alive, ghostVote: p.ghostVote, canVote: canVote(p),
        role: r ? { id: r.id, name: r.name, team: r.team, icon: r.icon, ability: r.ability } : null,
        evil: p.role ? isEvil(p) : null,
        evilInfo: p.evilInfo,
        canNominate: S.phase === 'day' && p.alive && !p.nominated && !S.vote,
        canDuel: S.phase === 'day' && p.alive && shownRole(p) === 'duelist' && !p.duelUsed,
      },
      prompt: p.prompt,
      msgs: p.msgs.slice(-40),
      nominations: S.nominations.map(n => ({ nominator: pname(n.nominator), nominee: pname(n.nominee), nomineePid: n.nominee, votes: n.votes, voters: n.voters })),
      // Voting is public at the table (hands are raised), so every phone sees the live hands.
      vote: v ? { nominator: pname(v.nominator), nominee: pname(v.nominee), nomineePid: v.nominee, open: v.open,
        myVote: v.votes[p.pid] ?? null, yes: tallyYes(v), hands: v.votes } : null,
      ghostVotes: S.ghostVotes !== false,
      block: S.block ? { name: pname(S.block.pid), votes: S.block.votes } : null,
      nominatable: S.phase === 'day' ? seatList().filter(x => !x.wasNominated).map(x => x.pid) : [],
      pendingRequest: S.requests.some(q => q.pid === p.pid),
    };
  }
  return views;
}

function msg(pid, text) {
  const p = S.players[pid]; if (!p) return;
  p.msgs.push({ text, ts: now() });
}
function msgAll(text) { for (const p of seatList()) msg(p.pid, text); }
function log(text) { S.log.push({ text, ts: now(), phase: S.phase === 'night' ? `N${S.night}` : `D${S.day}` }); }

// ---------- setup ----------
function recommended() { return setupFor(S.seats.length); }
function countSel(team) { return S.selection.filter(id => role(id).team === team).length; }
function randomSelection() {
  const [t, o, m, d] = recommended();
  const byTeam = (team) => shuffle(ROLES.filter(r => r.team === team).map(r => r.id));
  S.selection = [...byTeam('townsfolk').slice(0, t), ...byTeam('outsider').slice(0, o), ...byTeam('minion').slice(0, m), ...byTeam('demon').slice(0, d)];
}
function deal() {
  const ps = seatList();
  if (S.selection.length !== ps.length) return toast(`Select exactly ${ps.length} characters (now ${S.selection.length}).`);
  const roles = shuffle(S.selection);
  ps.forEach((p, i) => { Object.assign(p, newPlayer(p.pid, p.name), { connected: p.connected, role: roles[i] }); });
  const notInPlay = ROLES.filter(r => r.team === 'townsfolk' && !S.selection.includes(r.id)).map(r => r.id);
  const sleeper = ps.find(p => p.role === 'sleepwalker');
  if (sleeper) sleeper.fakeRole = pick(notInPlay) || 'archivist';
  // Bluffs: Townsfolk not in play (and not the Sleepwalker's fake character, which would expose them).
  const goodOut = shuffle(notInPlay.filter(id => id !== (sleeper && sleeper.fakeRole)));
  S.bluffs = goodOut.slice(0, 3);
  S.dealt = true;
  save();
}
function startGame() {
  if (!S.dealt) return toast('Deal characters first.');
  S.locked = true;
  for (const p of seatList()) {
    const r = role(shownRole(p));
    msg(p.pid, `You are the ${r.name}. ${r.ability}`);
  }
  log('Game started with ' + seatList().length + ' players.');
  startNight();
}

// ---------- night ----------
function startNight() {
  S.night += 1; S.phase = 'night'; S.vote = null; S.requests = S.requests.filter(r => r.kind !== 'nominate');
  for (const p of seatList()) { p.cursed = false; p.protected = false; p.prompt = null; }
  const first = S.night === 1;
  const steps = [];
  const ps = seatList();
  if (first && ps.length >= 7) {
    steps.push({ key: 'minion_info', kind: 'minion_info', order: -2 });
    steps.push({ key: 'demon_info', kind: 'demon_info', order: -1 });
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
  S.announce = `Night ${S.night}. Close your eyes.`;
  log(`Night ${S.night} begins.`);
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
  p.prompt = { id: S.promptSeq++, step: st.key, role: r.name,
    text: max > choose ? `Choose ${choose}–${max} players.` : `Choose ${choose} player${choose > 1 ? 's' : ''}.`,
    min: choose, max, notSelf: !!n.notSelf, ability: r.ability };
  st.status = 'prompted';
  vibrateNotice();
  save();
}
function vibrateNotice() { /* host-side no-op; players vibrate on prompt */ }

function suggestion(st) {
  const { p, n } = stepDef(st);
  const ch = st.choice.map(id => S.players[id]).filter(Boolean);
  const ps = seatList();
  let s = '';
  switch (n.info) {
    case 'archivist': {
      const inPlay = ps.filter(x => x.pid !== p.pid).map(x => role(x.role).name);
      const out = ROLES.filter(r => !ps.some(x => x.role === r.id)).map(r => r.name);
      s = `${pick(inPlay)} is in play. ${pick(out)} is not in play.`; break;
    }
    case 'twin': { const g = ps.filter(x => x.pid !== p.pid && !isEvil(x)); s = g.length ? `${pick(g).name} is good.` : 'No other good player.'; break; }
    case 'census': {
      const i = S.seats.indexOf(p.pid); let c = 0;
      for (let k = 1; k <= 3 && k < ps.length; k++) if (isEvil(ps[(i + k) % ps.length])) c++;
      s = `${c} evil among the 3 players to your left.`; break;
    }
    case 'cartographer': {
      if (!ch[0]) break;
      const alive = ps.filter(x => x.alive || x.pid === ch[0].pid);
      const i = alive.findIndex(x => x.pid === ch[0].pid);
      const nb = alive.length > 2 ? [alive[(i - 1 + alive.length) % alive.length], alive[(i + 1) % alive.length]] : alive.filter(x => x.pid !== ch[0].pid);
      s = `${nb.filter(isEvil).length} of ${ch[0].name}'s living neighbours ${nb.filter(isEvil).length === 1 ? 'is' : 'are'} evil.`; break;
    }
    case 'oracle': {
      if (ch.length < 2) break;
      s = ch.some(x => role(x.role).team === 'minion') ? `YES — ${ch[0].name} or ${ch[1].name} is a Minion.` : `NO — neither ${ch[0].name} nor ${ch[1].name} is a Minion.`;
      break;
    }
    case 'tracker': {
      if (!ch[0]) break;
      const other = S.steps.find(x => x.kind === 'role' && x.pid === ch[0].pid && x.choice && x.choice.length);
      s = other ? `${ch[0].name} chose ${other.choice.map(pname).join(' and ')}.` : `${ch[0].name} chose nobody (so far tonight).`; break;
    }
    case 'gravedigger': {
      const e = S.lastExecuted && S.players[S.lastExecuted];
      s = e ? `${e.name} (executed) was ${isEvil(e) ? 'EVIL' : 'GOOD'}.` : 'Nobody was executed today.'; break;
    }
    case 'whisperer': { if (ch[0]) s = `${ch[0].name} is the ${role(ch[0].role).name}.`; break; }
  }
  return s;
}
// Storyteller-facing note (never sent to the player): malfunction and Mimic warnings.
function suggestionNote(st) {
  const { p } = stepDef(st);
  const notes = [];
  if (malfunctioning(p)) notes.push('⚠ Malfunctioning (' + (p.role === 'sleepwalker' ? 'Sleepwalker' : 'cursed') + ') — you may give false info.');
  if (seatList().some(x => x.role === 'mimic' && x.alive) && ['census', 'cartographer', 'oracle', 'gravedigger'].includes(stepDef(st).n.info)) notes.push('Mimic in play: may register as good/Townsfolk.');
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
    m.evilInfo = Object.assign(m.evilInfo || {}, { demon: demon.map(d => d.name), minions: minions.filter(x => x !== m).map(x => x.name) });
    msg(m.pid, `Evil team: the Demon is ${demon.map(d => d.name).join(', ')}.` + (minions.length > 1 ? ` Fellow Minions: ${minions.filter(x => x !== m).map(x => x.name).join(', ')}.` : ''));
  }
}
function sendDemonInfo() {
  const { demon, minions } = minionInfoText();
  for (const d of demon) {
    d.evilInfo = { minions: minions.map(x => x.name), bluffs: S.bluffs.map(id => role(id).name) };
    msg(d.pid, `Your Minions: ${minions.map(x => x.name).join(', ') || 'none'}. Not in play (safe bluffs): ${S.bluffs.map(id => role(id).name).join(', ')}.`);
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
    if (malfunctioning(p)) { notes.push(`${p.name} (Demon) is cursed — kill fails.`); continue; }
    for (const id of st.choice) {
      const t = S.players[id];
      if (!t.alive) { notes.push(`${t.name} already dead.`); continue; }
      if (t.protected) { notes.push(`${t.name} protected by Herbalist.`); continue; }
      if (t.role === 'sentinel' && !t.sentinelUsed && !t.cursed) { t.sentinelUsed = true; sentinelHit.v = true; notes.push(`${t.name} is the Sentinel — nobody dies tonight.`); continue; }
      if (t.role === 'lucky' && !t.luckyUsed && !t.cursed) { t.luckyUsed = true; notes.push(`${t.name} is the Lucky One — survives (first time).`); continue; }
      kills.push(id);
    }
  }
  S.dawn = { deaths: sentinelHit.v ? [] : [...new Set(kills)], notes };
}

function killPlayer(pid, cause) {
  const p = S.players[pid]; if (!p || !p.alive) return;
  const aliveBefore = alivePlayers().length;
  p.alive = false;
  log(`${p.name} died (${cause}).`);
  if (p.role === 'witness') {
    const evil = seatList().filter(x => isEvil(x) && x.role !== 'mimic');
    const t = p.cursed ? pick(seatList().filter(x => x.pid !== pid)) : pick(evil);
    if (t) { msg(pid, `Witness: ${t.name} is evil.`); log(`Witness ${p.name} told: ${t.name}` + (p.cursed ? ' (cursed: random)' : '')); }
  }
  if (role(p.role).team === 'demon') {
    const heir = seatList().find(x => x.role === 'heir' && x.alive && !x.cursed);
    if (heir && aliveBefore >= 5) {
      heir.role = p.role;
      msg(heir.pid, `The Demon has fallen. You are now the ${role(p.role).name}: ${role(p.role).ability}`);
      log(`${heir.name} (Heir) becomes the ${role(p.role).name}.`);
      toast(`Heir ${heir.name} becomes the Demon.`);
    }
  }
  checkWin();
}
function checkWin() {
  if (S.winner) return;
  const demonAlive = seatList().some(p => p.alive && role(p.role).team === 'demon');
  if (!demonAlive) return endGame('good', 'The Demon is dead.');
  if (alivePlayers().length <= 2) return endGame('evil', 'Only two players remain.');
}
function endGame(side, why) {
  S.winner = side; S.phase = 'over';
  S.announce = `${side === 'good' ? 'GOOD' : 'EVIL'} WINS — ${why}`;
  for (const p of seatList()) p.prompt = null;
  S.vote = null;
  log(S.announce);
  msgAll(S.announce + '\n' + seatList().map(p => `${p.name}: ${role(p.role).name}${p.fakeRole ? ' (thought ' + role(p.fakeRole).name + ')' : ''}`).join('\n'));
  tab = 'grim';
}

function startDay() {
  if (!S.dawn) computeDawn();
  const died = S.dawn.deaths.slice();
  S.phase = 'day'; S.day += 1;
  for (const p of seatList()) { p.prompt = null; p.nominated = false; p.wasNominated = false; p.protected = false; }
  S.nominations = []; S.vote = null; S.block = null; S.executedToday = null; S.debtorNight = false;
  S.requests = [];
  S.announce = died.length ? `Day ${S.day}. Died in the night: ${died.map(pname).join(', ')}.` : `Day ${S.day}. Nobody died in the night.`;
  msgAll(S.announce);
  log(S.announce);
  for (const id of died) killPlayer(id, 'night');
  tab = S.winner ? 'grim' : 'day';
  save();
}

// ---------- day ----------
function nominationProblem(nominator, nominee) {
  const a = S.players[nominator], b = S.players[nominee];
  if (!a || !b) return 'Unknown player.';
  if (!a.alive) return `${a.name} is dead and cannot nominate.`;
  if (a.nominated) return `${a.name} already nominated today.`;
  if (b.wasNominated) return `${b.name} was already nominated today.`;
  if (S.vote) return 'A vote is already in progress.';
  return '';
}
function openVote(nominator, nominee) {
  const prob = nominationProblem(nominator, nominee);
  if (prob) return toast(prob);
  const a = S.players[nominator], b = S.players[nominee];
  a.nominated = true; b.wasNominated = true;
  S.requests = S.requests.filter(r => !(r.kind === 'nominate' && r.pid === nominator));
  log(`${a.name} nominates ${b.name}.`);
  if (a.role === 'hothead' && !a.cursed && !isEvil(b)) {
    toast(`${a.name} is the Hothead and nominated a good player — they die.`);
    killPlayer(a.pid, 'Hothead');
  }
  if (S.winner) return save();
  S.vote = { nominator, nominee, votes: {}, open: true };
  S.announce = `${a.name} nominated ${b.name}. Vote now! (${threshold()} needed)`;
  save();
}
function voteWeight(p) { return p.role === 'magistrate' && !p.cursed && p.alive ? 2 : 1; }
function closeVote() {
  const v = S.vote; if (!v) return;
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
  if (count >= need && count > best) { S.block = { pid: v.nominee, votes: count }; S.highest = count; result = `${pname(v.nominee)} is on the block with ${count}.`; }
  else if (count >= need && count === best) { S.block = null; result = `Tie at ${count} — nobody is on the block.`; }
  else result = `${count} vote${count === 1 ? '' : 's'} — not enough (${count < need ? need + ' needed' : 'needs more than ' + best}).`;
  log(`Vote on ${pname(v.nominee)}: ${count} (${voters.join(', ') || 'none'}). ${result}`);
  S.announce = result;
  msgAll(`Vote on ${pname(v.nominee)}: ${count}. ${result}`);
  S.vote = null;
  save();
}
function endDay() {
  if (S.vote) return toast('Close the open vote first.');
  if (S.block) {
    const p = S.players[S.block.pid];
    S.executedToday = p.pid; S.lastExecuted = p.pid;
    msgAll(`${p.name} is executed.`);
    if (p.role === 'debtor' && !p.cursed) { S.debtorNight = true; log('Debtor executed: the Demon may kill twice tonight.'); }
    killPlayer(p.pid, 'executed');
  } else {
    S.lastExecuted = null;
    msgAll('Nobody is executed today.');
    log('No execution today.');
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
    toast(`${p.name} chose ${targets.map(pname).join(', ')}`);
    save();
  } else if (a.kind === 'nominate') {
    if (S.phase !== 'day') return;
    const prob = nominationProblem(pid, a.target);
    if (prob) { msg(pid, 'Nomination refused: ' + prob); return save(); }
    S.requests = S.requests.filter(r => r.pid !== pid || r.kind !== 'nominate');
    S.requests.push({ kind: 'nominate', pid, target: a.target, ts: now() });
    toast(`${p.name} wants to nominate ${pname(a.target)}`);
    save();
  } else if (a.kind === 'vote') {
    if (!S.vote || !S.vote.open) return;
    if (!canVote(p)) return; // dead without a ghost vote: ignored
    S.vote.votes[pid] = !!a.yes;
    save();
  } else if (a.kind === 'duel') {
    if (S.phase !== 'day' || p.duelUsed) return;
    S.requests.push({ kind: 'duel', pid, target: a.target, ts: now() });
    toast(`${p.name} (Duelist?) challenges ${pname(a.target)}`);
    save();
  } else if (a.kind === 'cancel_request') {
    S.requests = S.requests.filter(r => r.pid !== pid); save();
  }
}

function resolveDuel(i, kill) {
  const r = S.requests[i]; if (!r) return;
  const p = S.players[r.pid]; p.duelUsed = true;
  S.requests.splice(i, 1);
  const t = S.players[r.target];
  msgAll(`${p.name} challenges ${t.name}... ${kill ? t.name + ' dies!' : 'nothing happens.'}`);
  log(`Duel: ${p.name} → ${t.name}: ${kill ? 'dies' : 'nothing'}.`);
  if (kill) killPlayer(t.pid, 'duel');
  save();
}

// ---------- rendering ----------
function toast(text) {
  const el = document.createElement('div'); el.className = 'toast'; el.textContent = text;
  document.body.appendChild(el); setTimeout(() => el.remove(), 3200);
}
function pill(cls, text) { return `<span class="pill ${cls}">${esc(text)}</span>`; }
function rolePill(id) { if (!id) return ''; const r = role(id); return pill(r.team, r.icon + ' ' + r.name); }

function render() {
  const title = document.getElementById('toptitle');
  if (!S) {
    title.textContent = 'Nightfall — Storyteller';
    const resuming = !!store.get('nf_host');
    $tabs.innerHTML = '';
    $app.innerHTML = `
      <div class="card stack">
        <h1>Host a game</h1>
        <p class="muted">You are the Storyteller. Your device holds the full game state. Keep this page open.</p>
        ${resuming ? '<p class="small muted">Reconnecting to your room…</p>'
          : `<button class="primary block" data-a="create" ${creating ? 'disabled' : ''}>${creating ? 'Creating…' : 'Create room'}</button>`}
      </div>
      <div class="card small muted">Players open <b>${esc(joinBase())}</b>${info.cloud ? '' : ' on the same Wi-Fi'}.</div>`;
    return;
  }
  title.textContent = `Room ${S.room} · ` + (S.phase === 'night' ? `Night ${S.night}` : S.phase === 'day' ? `Day ${S.day}` : S.phase === 'over' ? 'Game over' : 'Setup');
  document.getElementById('topright').innerHTML = `<span class="pill">${seatList().length} 👤</span>`;

  const tabsDef = S.locked
    ? [['grim', '📖', 'Grimoire'], [S.phase === 'day' ? 'day' : 'night', S.phase === 'day' ? '☀️' : '🌙', S.phase === 'day' ? 'Day' : 'Night'], ['log', '🧾', 'Log'], ['more', '⚙️', 'More']]
    : [['lobby', '👥', 'Lobby'], ['setup', '🎭', 'Characters'], ['more', '⚙️', 'More']];
  if (!tabsDef.some(t => t[0] === tab)) tab = tabsDef[0][0];
  if (S.locked && S.phase !== 'over' && (tab === 'night' || tab === 'day')) tab = S.phase;
  const reqCount = S.requests.length;
  $tabs.innerHTML = tabsDef.map(([k, ic, l]) => `<button class="${tab === k ? 'active' : ''}" data-a="tab" data-k="${k}"><span class="ic">${ic}</span>${l}${k === 'day' && reqCount ? `<span class="badge">${reqCount}</span>` : ''}</button>`).join('');

  const banner = S.winner ? `<div class="banner ${S.winner}"><h2>${esc(S.announce)}</h2></div>` : '';
  $app.innerHTML = banner + ({ lobby: viewLobby, setup: viewSetup, grim: viewGrim, night: viewNight, day: viewDay, log: viewLog, more: viewMore }[tab] || viewGrim)();
  renderSheet();
}

function joinBase() {
  if (!info.addresses || !info.addresses.length) return location.origin + '/';
  return `http://${info.addresses[0]}:${info.port || location.port}/`;
}
function viewLobby() {
  const ps = seatList();
  const urls = (info.addresses || []).length
    ? info.addresses.map(a => `http://${a}:${info.port}/?room=${S.room}`)
    : [`${location.origin}/?room=${S.room}`];
  const [t, o, m, d] = recommended();
  return `
    <div class="card center">
      <h3>Room code</h3><div class="code">${S.room}</div>
      <p class="small muted">Players open${info.cloud ? '' : ' (same Wi-Fi)'}:</p>
      ${urls.map(u => `<div><b>${esc(u)}</b></div>`).join('')}
    </div>
    <div class="card">
      <div class="row"><h2 class="grow">Players (${ps.length})</h2></div>
      <p class="small muted">Order = seating order clockwise around the circle. ${ps.length < 5 ? '5–15 players recommended.' : `Setup: ${t} Townsfolk, ${o} Outsider, ${m} Minion, ${d} Demon.`}</p>
      <div class="list">${ps.map((p, i) => `
        <div class="item"><span class="seat">${i + 1}</span>
          <div class="main"><div class="name">${esc(p.name)}</div><div class="small ${p.connected ? 'muted' : ''}">${p.connected ? 'connected' : '⚠ offline'}</div></div>
          <button class="sm" data-a="seatUp" data-pid="${p.pid}" ${i === 0 ? 'disabled' : ''}>▲</button>
          <button class="sm" data-a="seatDown" data-pid="${p.pid}" ${i === ps.length - 1 ? 'disabled' : ''}>▼</button>
          <button class="sm danger" data-a="kick" data-pid="${p.pid}">✕</button>
        </div>`).join('') || '<p class="muted">Waiting for players to join…</p>'}</div>
    </div>
    <button class="primary block" data-a="tab" data-k="setup" ${ps.length < 2 ? 'disabled' : ''}>Choose characters →</button>`;
}

function viewSetup() {
  const ps = seatList();
  const [t, o, m, d] = recommended();
  const target = { townsfolk: t, outsider: o, minion: m, demon: d };
  const groups = ['townsfolk', 'outsider', 'minion', 'demon'].map(team => {
    const c = countSel(team);
    return `<div class="card"><div class="row"><h3 class="grow">${TEAM_LABEL[team]}s</h3>${pill(c === target[team] ? 'ok' : 'warn', `${c} / ${target[team]}`)}</div>
      <div class="grid2">${ROLES.filter(r => r.team === team).map(r => {
        const on = S.selection.includes(r.id);
        return `<button class="${on ? (isEvilTeam(team) ? 'danger' : 'good') : ''}" data-a="toggleRole" data-id="${r.id}" style="text-align:left;min-height:56px" title="${esc(r.ability)}">${r.icon} ${esc(r.name)}${r.setup ? ' <span class="pill warn">setup</span>' : ''}</button>`;
      }).join('')}</div></div>`;
  }).join('');
  const sc = S.script;
  const scriptCard = `<div class="card"><div class="row"><div class="grow"><h3 style="margin:0">Script</h3>
      <b>${esc(sc ? sc.name : 'Nightfall (built-in)')}</b>${sc && sc.author ? ` <span class="small muted">by ${esc(sc.author)}</span>` : ''}
      <div class="small muted">${ROLES.length} characters${sc && sc.missing.length ? ` · ⚠ ${sc.missing.length} unknown` : ''}${sc && sc.skipped.length ? ` · ${sc.skipped.length} travellers/fabled skipped` : ''}</div></div>
      <button class="sm" data-a="openImport" ${S.locked ? 'disabled' : ''}>Import…</button></div>
      ${sc && sc.missing.length ? `<p class="small" style="color:var(--warn);margin:6px 0 0">Unknown: ${esc(sc.missing.join(', '))}. Import a character library that defines them, then import the script again.</p>` : ''}
      ${ROLES.some(r => r.setup) ? '<p class="small muted" style="margin:6px 0 0"><span class="pill warn">setup</span> characters change the Townsfolk/Outsider counts: adjust your selection by hand.</p>' : ''}
    </div>`;
  const dealt = S.dealt ? `
    <div class="card"><h2>Dealt characters</h2>
      <p class="small muted">Players can already see their character. Swap here if needed, then start.</p>
      <div class="list">${ps.map((p, i) => `
        <div class="item"><span class="seat">${i + 1}</span><div class="main"><div class="name">${esc(p.name)}</div>
          <div>${rolePill(p.role)} ${p.fakeRole ? '<span class="small muted">thinks</span> ' + rolePill(p.fakeRole) : ''}</div></div>
          <button class="sm" data-a="sheetPlayer" data-pid="${p.pid}">Edit</button></div>`).join('')}</div>
      <p class="small">Demon bluffs: ${S.bluffs.map(rolePill).join(' ')}</p>
    </div>
    <button class="primary block" data-a="start">Start game — first night 🌙</button>` : '';
  return `${scriptCard}
    <div class="card"><h2>Characters for ${ps.length} players</h2>
      <p class="small muted">Recommended: ${t} Townsfolk · ${o} Outsider · ${m} Minion · ${d} Demon. Selected ${S.selection.length}/${ps.length}.</p>
      <div class="grid2"><button data-a="randomRoles">🎲 Random pick</button><button class="primary" data-a="deal" ${S.selection.length === ps.length ? '' : 'disabled'}>Deal ${S.dealt ? 'again' : ''}</button></div>
    </div>
    ${dealt}${groups}`;
}

function viewGrim() {
  const ps = seatList();
  const alive = alivePlayers().length;
  return `
    <div class="card"><div class="row"><div class="grow"><b>${alive}</b> alive · <b>${threshold()}</b> votes to execute</div>
      ${S.phase !== 'over' ? `<button class="sm" data-a="tab" data-k="${S.phase}">Go to ${S.phase} →</button>` : ''}</div>
      ${S.announce && !S.winner ? `<p class="small muted">${esc(S.announce)}</p>` : ''}</div>
    <div class="card list" style="padding:4px">${ps.map((p, i) => `
      <div class="item tap ${p.alive ? '' : 'dead'}" data-a="sheetPlayer" data-pid="${p.pid}"><span class="seat">${i + 1}</span>
        <div class="main"><div class="name">${esc(p.name)} ${p.connected ? '' : '⚠'}</div>
          <div class="row" style="gap:4px;margin-top:2px">${rolePill(p.role)}${p.fakeRole ? pill('', 'thinks ' + role(p.fakeRole).name) : ''}
          ${p.cursed ? pill('evil', '🕸 cursed') : ''}${p.protected ? pill('good', '🌿 safe') : ''}
          ${!p.alive ? pill('dead', '💀 dead · ' + (canVote(p) ? 'ghost vote left' : 'no vote')) : ''}
          ${p.role === 'sentinel' && p.sentinelUsed ? pill('', 'used') : ''}${p.role === 'lucky' && p.luckyUsed ? pill('', 'luck used') : ''}
          ${p.role === 'duelist' && p.duelUsed ? pill('', 'duel used') : ''}${p.role === 'hollow' && p.hollowUsed ? pill('', 'double used') : ''}</div></div>
      </div>`).join('')}</div>
    <div class="card small">Bluffs given to Demon: ${S.bluffs.map(rolePill).join(' ')}</div>
    ${S.phase === 'over' ? '<button class="primary block" data-a="newGame">New game with same players</button>' : ''}`;
}

function playerChips(st, max) {
  return `<div class="grid2" style="margin-top:8px">${seatList().map(x => {
    const on = st.choice.includes(x.pid);
    return `<button class="sm ${on ? 'primary' : ''}" data-a="hostChoose" data-key="${esc(st.key)}" data-pid="${x.pid}" data-max="${max}">${x.alive ? '' : '💀'}${esc(x.name)}</button>`;
  }).join('')}</div>`;
}

function viewNight() {
  if (S.phase !== 'night') return `<div class="card">Not night.</div>`;
  const steps = S.steps.map((st, i) => {
    const cur = i === S.stepIdx; const done = i < S.stepIdx;
    let head = '', body = '';
    if (st.kind === 'minion_info') {
      const { demon, minions } = minionInfoText();
      head = '😈 Minions wake & learn the Demon';
      body = `<p class="small">Minions: ${minions.map(x => esc(x.name)).join(', ') || '—'} · Demon: ${demon.map(x => esc(x.name)).join(', ')}</p>
        <button class="primary block" data-a="sendMinionInfo">Send to Minions & next</button>`;
    } else if (st.kind === 'demon_info') {
      head = '👹 Demon wakes: learns Minions + 3 bluffs';
      body = `<p class="small">Bluffs: ${S.bluffs.map(rolePill).join(' ')}</p><button class="primary block" data-a="sendDemonInfo">Send to Demon & next</button>`;
    } else if (st.kind === 'dawn') {
      head = '🌅 Dawn';
      if (cur) {
        if (!S.dawn) computeDawn();
        body = `<p class="small muted">Tap to toggle who dies. Notes:</p>
          ${S.dawn.notes.map(n => `<div class="small">• ${esc(n)}</div>`).join('')}
          <div class="grid2" style="margin-top:8px">${alivePlayers().map(x => `<button class="sm ${S.dawn.deaths.includes(x.pid) ? 'danger' : ''}" data-a="toggleDeath" data-pid="${x.pid}">${S.dawn.deaths.includes(x.pid) ? '💀 ' : ''}${esc(x.name)}</button>`).join('')}</div>
          <button class="primary block" style="margin-top:10px" data-a="startDay">Wake everyone — start Day ${S.day + 1} ☀️</button>`;
      }
    } else {
      const { p, r, choose, upTo } = stepDef(st);
      const max = upTo || choose;
      const mal = malfunctioning(p);
      head = `${r.icon} ${esc(r.name)} — ${esc(p.name)} ${p.role === 'sleepwalker' ? pill('warn', 'Sleepwalker') : ''}${p.cursed ? pill('evil', 'cursed') : ''}`;
      if (cur || (done && st.choice.length)) {
        // Cache so random suggestions (Archivist, Twin) stay stable across re-renders.
        if (st.sugFor !== st.choice.join(',') || st.sug == null) { st.sug = suggestion(st); st.sugFor = st.choice.join(','); }
        const sug = st.sug;
        const note = suggestionNote(st);
        const reminder = stepDef(st).n.reminder;
        body = `<p class="small muted">${esc(r.ability)}</p>
          ${reminder ? `<p class="small" style="border-left:3px solid var(--accent);padding-left:8px">${esc(reminder)}</p>` : ''}
          ${!p.alive ? '<p class="small">💀 Dead — skip unless their ability says otherwise.</p>' : ''}
          ${cur ? `<div class="row small muted" style="margin-bottom:6px">Players to choose:
            ${[0, 1, 2, 3].map(k => `<button class="sm ${choose === k && !(upTo > choose) ? 'primary' : ''}" data-a="setChoose" data-key="${esc(st.key)}" data-n="${k}">${k}</button>`).join('')}</div>` : ''}
          ${max ? `<div class="row"><button class="sm ${st.status === 'prompted' ? '' : 'good'}" data-a="prompt" data-key="${esc(st.key)}" ${p.connected ? '' : 'disabled'}>📱 ${st.status === 'prompted' ? 'Re-send' : 'Ask player to choose'}</button>
            <span class="small muted">${st.status === 'prompted' ? 'Waiting for answer…' : st.status === 'answered' ? 'Answered ✓' : ''}</span></div>
            <p class="small muted" style="margin:6px 0 0">Or pick for them (${max > choose ? choose + '–' + max : choose}):</p>${playerChips(st, max)}` : ''}
          ${max && st.choice.length ? `<p><b>Chose:</b> ${st.choice.map(pname).map(esc).join(', ')}${mal && stepDef(st).n.effect ? ' — ⚠ no effect (malfunctioning)' : ''}</p>` : ''}
          ${stepDef(st).n.info || r.imported || stepDef(st).n.reminder ? `
            <label>Info to send ${sug ? '' : '(waiting for choice)'}</label>
            ${sug ? `<p class="small muted">True answer: ${esc(sug)}</p>` : ''}
            ${note ? `<p class="small" style="color:var(--warn)">${esc(note)}</p>` : ''}
            <textarea id="info-${esc(st.key)}" placeholder="Information for ${esc(p.name)}">${esc(st.sent || sug || '')}</textarea>
            <button class="sm good" data-a="sendInfo" data-key="${esc(st.key)}">Send info</button>${st.sent ? ' <span class="small muted">sent ✓</span>' : ''}` : ''}
          ${cur ? `<div class="grid2" style="margin-top:10px"><button data-a="prevStep" ${i === 0 ? 'disabled' : ''}>← Back</button><button class="primary" data-a="nextStep">Done →</button></div>` : ''}`;
      }
    }
    return `<div class="step ${cur ? 'current' : ''} ${done ? 'done' : ''}" ${!cur ? `data-a="gotoStep" data-i="${i}"` : ''}><div class="row"><b class="grow">${head}</b>${done ? '✓' : ''}</div>${cur || (done && body && st.kind === 'role') ? body : ''}</div>`;
  }).join('');
  return `<div class="card small muted">Night ${S.night}. Players should keep eyes closed; wake each in order (tap "Ask player" to put the choice on their phone). ${S.debtorNight ? '<br><b>Debtor executed: Demon may kill twice tonight.</b>' : ''}</div>${steps}`;
}

function viewDay() {
  if (S.phase !== 'day') return `<div class="card">Not day.</div>`;
  const v = S.vote;
  const reqs = S.requests.map((r, i) => r.kind === 'nominate' ? `
      <div class="item"><div class="main"><b>${esc(pname(r.pid))}</b> nominates <b>${esc(pname(r.target))}</b>
        ${nominationProblem(r.pid, r.target) ? `<div class="small" style="color:var(--warn)">${esc(nominationProblem(r.pid, r.target))}</div>` : ''}</div>
        <button class="sm primary" data-a="acceptNom" data-i="${i}">Open vote</button><button class="sm" data-a="dropReq" data-i="${i}">✕</button></div>`
    : `<div class="item"><div class="main"><b>${esc(pname(r.pid))}</b> challenges <b>${esc(pname(r.target))}</b> (claims Duelist)
        <div class="small muted">Real: ${rolePill(S.players[r.pid].role)} → ${rolePill(S.players[r.target].role)}. Suggested: ${S.players[r.pid].role === 'duelist' && !S.players[r.pid].cursed && role(S.players[r.target].role).team === 'minion' ? 'DIES' : 'nothing'}</div></div>
        <button class="sm danger" data-a="duel" data-i="${i}" data-kill="1">Dies</button><button class="sm" data-a="duel" data-i="${i}" data-kill="0">Nothing</button></div>`).join('');
  let votePanel = '';
  if (v) {
    const rows = seatList().map(p => {
      const val = v.votes[p.pid];
      const ok = canVote(p);
      return `<div class="item ${p.alive ? '' : 'dead'} ${ok ? '' : 'novote'}"><div class="main"><span class="name">${esc(p.name)}</span> ${!p.alive ? pill('dead', ok ? '👻 ghost vote' : '💀 cannot vote') : ''}${voteWeight(p) > 1 ? pill('', '×2') : ''}</div>
        <button class="sm ${val === true ? 'okb' : ''}" data-a="hostVote" data-pid="${p.pid}" data-v="1" ${ok ? '' : 'disabled'}>✋ Yes</button>
        <button class="sm ${val === false ? 'danger' : ''}" data-a="hostVote" data-pid="${p.pid}" data-v="0" ${ok ? '' : 'disabled'}>No</button></div>`;
    }).join('');
    const yes = tallyYes(v);
    const voted = seatList().filter(p => canVote(p) && v.votes[p.pid] !== undefined).length;
    const eligible = seatList().filter(canVote).length;
    votePanel = `<div class="card"><h2>${esc(pname(v.nominator))} → ${esc(pname(v.nominee))}</h2>
      <div class="votebig">${yes} <span class="small muted">/ ${threshold()} needed${S.highest ? ` · beat ${S.highest}` : ''}</span></div>
      <p class="center small muted">${voted} of ${eligible} eligible voters have answered</p>
      <div class="list">${rows}</div>
      <div class="grid2" style="margin-top:8px"><button data-a="cancelVote">Cancel</button><button class="primary" data-a="closeVote">Close vote & count</button></div></div>`;
  }
  return `
    <div class="card"><div class="row"><div class="grow small">${esc(S.announce)}</div></div>
      <div class="small muted">${alivePlayers().length} alive · ${threshold()} votes to execute</div>
      ${S.block ? `<div class="banner evil" style="margin:8px 0 0">On the block: <b>${esc(pname(S.block.pid))}</b> (${S.block.votes})</div>` : ''}</div>
    ${reqs ? `<div class="card"><h3>Requests</h3><div class="list">${reqs}</div></div>` : ''}
    ${votePanel}
    ${!v ? `<div class="card"><h3>Start a nomination</h3>
      <label>Nominator</label><select id="nomA">${alivePlayers().filter(p => !p.nominated).map(p => `<option value="${p.pid}">${esc(p.name)}</option>`).join('')}</select>
      <label>Nominee</label><select id="nomB">${seatList().filter(p => !p.wasNominated).map(p => `<option value="${p.pid}">${esc(p.name)}</option>`).join('')}</select>
      <button class="good block" style="margin-top:8px" data-a="manualNom">Open vote</button></div>` : ''}
    ${S.nominations.length ? `<div class="card"><h3>Today's votes</h3>${S.nominations.map(n => `<div class="small">${esc(pname(n.nominator))} → <b>${esc(pname(n.nominee))}</b>: ${n.votes} <span class="muted">(${esc(n.voters.join(', '))})</span></div>`).join('')}</div>` : ''}
    <button class="primary block" data-a="endDay">${S.block ? `Execute ${esc(pname(S.block.pid))} & start night 🌙` : 'End day without execution 🌙'}</button>`;
}

function viewLog() {
  return `<div class="card">${S.log.slice().reverse().map(l => `<div class="small" style="margin-bottom:6px"><span class="pill">${l.phase}</span> ${esc(l.text)}</div>`).join('') || '<p class="muted">Nothing yet.</p>'}</div>`;
}
function viewMore() {
  return `
    <div class="card stack"><h2>Broadcast</h2>
      <textarea id="bcast" placeholder="Message to every player"></textarea>
      <button class="good block" data-a="broadcast">Send to all</button></div>
    ${S.locked && S.phase !== 'over' ? `<div class="card stack"><h2>Phase control</h2>
      <div class="grid2"><button data-a="forceNight">Jump to night</button><button data-a="forceDay">Jump to day</button></div>
      <div class="grid2"><button class="good" data-a="win" data-side="good">Good wins</button><button class="danger" data-a="win" data-side="evil">Evil wins</button></div></div>` : ''}
    <div class="card stack"><h2>Rules</h2>
      <div class="row"><div class="grow"><b>Ghost votes</b><div class="small muted">${S.ghostVotes !== false
        ? 'On (official rule): each dead player may vote once more for the rest of the game.'
        : 'Off (house rule): dead players cannot vote at all.'}</div></div>
        <button class="sm ${S.ghostVotes !== false ? 'okb' : ''}" data-a="toggleGhostVotes">${S.ghostVotes !== false ? 'On' : 'Off'}</button></div></div>
    <div class="card stack"><h2>Room</h2><p class="small muted">Code <b>${S.room}</b>. State is saved on this device; refreshing is safe.</p>
      <button class="danger block" data-a="endRoom">Close room & start over</button></div>`;
}

// ---------- sheets ----------
function renderSheet() {
  if (!sheet) { $sheet.innerHTML = ''; return; }
  if (sheet.type === 'player') {
    const p = S.players[sheet.pid]; if (!p) { sheet = null; $sheet.innerHTML = ''; return; }
    const opts = (cur) => `<option value="">—</option>` + ROLES.map(r => `<option value="${r.id}" ${cur === r.id ? 'selected' : ''}>${r.icon} ${r.name} (${TEAM_LABEL[r.team]})</option>`).join('');
    $sheet.innerHTML = `<div class="sheet-bg" data-a="closeSheet"><div class="sheet" data-stop="1">
      <div class="row"><h2 class="grow">${esc(p.name)}</h2><button class="sm ghost" data-a="closeSheet">✕</button></div>
      <label>Character</label><select data-ch="role" data-pid="${p.pid}">${opts(p.role)}</select>
      <label>Thinks they are <span class="small">(for Drunk-style characters; their phone shows this one)</span></label><select data-ch="fakeRole" data-pid="${p.pid}">${opts(p.fakeRole)}</select>
      ${S.locked ? `<div class="grid2" style="margin-top:10px">
        <button class="${p.alive ? 'danger' : 'okb'}" data-a="toggleAlive" data-pid="${p.pid}">${p.alive ? '💀 Kill' : '❤️ Revive'}</button>
        <button data-a="toggleFlag" data-f="ghostVote" data-pid="${p.pid}">👻 Ghost vote: ${p.ghostVote ? 'yes' : 'used'}</button>
        <button data-a="toggleFlag" data-f="cursed" data-pid="${p.pid}">🕸 Cursed: ${p.cursed ? 'yes' : 'no'}</button>
        <button data-a="toggleFlag" data-f="protected" data-pid="${p.pid}">🌿 Safe: ${p.protected ? 'yes' : 'no'}</button>
      </div>` : ''}
      <label>Private message</label><textarea id="pmsg" placeholder="Only ${esc(p.name)} sees this"></textarea>
      <button class="good block" style="margin-top:6px" data-a="pmsg" data-pid="${p.pid}">Send</button>
      ${p.msgs.length ? `<h3 style="margin-top:12px">Sent to them</h3>${p.msgs.slice(-6).reverse().map(m => `<div class="msg small">${esc(m.text)}</div>`).join('')}` : ''}
    </div></div>`;
  } else if (sheet.type === 'import') {
    const lib = store.get('nf_library', []);
    $sheet.innerHTML = `<div class="sheet-bg" data-a="closeSheet"><div class="sheet" data-stop="1">
      <div class="row"><h2 class="grow">Import a script</h2><button class="sm ghost" data-a="closeSheet">✕</button></div>
      <p class="small muted">Paste or load the JSON exported by an online script builder: a list like
        <code>[{"id":"_meta","name":"…"}, "characterid", {…custom character…}]</code>.
        Custom characters with their own name/team/ability work as-is. Plain ids need a character library (below).</p>
      <label>Script URL (raw JSON)</label><input id="scriptUrl" type="url" placeholder="https://…/script.json" value="${esc(sheet.url || '')}">
      <label>…or a file</label><input type="file" accept=".json,application/json" data-ch="file" data-target="scriptText">
      <label>…or paste JSON</label><textarea id="scriptText" placeholder='[{"id":"_meta","name":"My script"}, …]'>${esc(sheet.text || '')}</textarea>
      ${sheet.err ? `<p class="small" style="color:var(--evil)">${esc(sheet.err)}</p>` : ''}
      <div class="grid2" style="margin-top:8px"><button data-a="useBuiltin">Use built-in set</button><button class="primary" data-a="importScript" ${sheet.busy ? 'disabled' : ''}>Import script</button></div>
      <hr>
      <h3>Character library <span class="pill">${lib.length} characters</span></h3>
      <p class="small muted">A JSON list of character definitions (<code>id, name, team, ability, firstNight, otherNight, …reminder</code>)
        used to look up scripts that only list ids. Saved on this device.</p>
      <label>Library URL</label><input id="libUrl" type="url" placeholder="https://…/characters.json">
      <label>…or a file</label><input type="file" accept=".json,application/json" data-ch="file" data-target="libText">
      <label>…or paste JSON</label><textarea id="libText"></textarea>
      ${sheet.libErr ? `<p class="small" style="color:var(--evil)">${esc(sheet.libErr)}</p>` : ''}
      <div class="grid2" style="margin-top:8px"><button data-a="clearLibrary" ${lib.length ? '' : 'disabled'}>Clear library</button><button class="good" data-a="importLibrary" ${sheet.busy ? 'disabled' : ''}>Import library</button></div>
    </div></div>`;
  }
}

// ---------- script import ----------
// Read the inputs before any re-render (re-rendering the sheet would wipe them).
function sourceOf(urlId, textId) {
  return { url: document.getElementById(urlId).value.trim(), text: document.getElementById(textId).value.trim() };
}
async function readSource({ url, text }) {
  if (text) return text;
  if (url) return ScriptImport.fetchText(url);
  throw new Error('Paste JSON, choose a file, or enter a URL.');
}
async function importScript() {
  const src = sourceOf('scriptUrl', 'scriptText');
  sheet.url = src.url; sheet.text = src.text;
  sheet.busy = true; sheet.err = ''; renderSheet();
  try {
    const parsed = ScriptImport.parse(await readSource(src), store.get('nf_library', []));
    S.script = parsed; applyScript();
    S.selection = []; S.dealt = false; S.bluffs = [];
    log(`Script imported: ${parsed.name} (${parsed.roles.length} characters).`);
    toast(`Imported "${parsed.name}": ${parsed.roles.length} characters` + (parsed.missing.length ? `, ${parsed.missing.length} unknown` : ''));
    sheet = null; save();
  } catch (e) {
    sheet.busy = false; sheet.err = e.message; renderSheet();
  }
}
async function importLibrary() {
  const src = sourceOf('libUrl', 'libText');
  sheet.busy = true; sheet.libErr = ''; renderSheet();
  try {
    const list = ScriptImport.parseLibrary(await readSource(src));
    store.set('nf_library', list);
    toast(`Library saved: ${list.length} characters. Now import your script.`);
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
    f.text().then(t => { document.getElementById(el.dataset.target).value = t; });
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
    if (S.locked && p.role) { const r = role(shownRole(p)); msg(p.pid, `Your character is now the ${r.name}. ${r.ability}`); log(`${p.name} is now ${role(p.role).name}.`); }
  } else if (el.dataset.ch === 'fakeRole') { p.fakeRole = el.value || null; }
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
    case 'kick': if (confirm(`Remove ${pname(d.pid)}?`)) { net.send({ t: 'kick', pid: d.pid }); } break;
    case 'toggleRole': {
      const i = S.selection.indexOf(d.id);
      if (i >= 0) S.selection.splice(i, 1); else S.selection.push(d.id);
      S.phase = 'setup'; render(); store.set('nf_host_state', S); break;
    }
    case 'randomRoles': randomSelection(); S.phase = 'setup'; save(); break;
    case 'openImport': sheet = { type: 'import' }; renderSheet(); break;
    case 'importScript': importScript(); break;
    case 'importLibrary': importLibrary(); break;
    case 'clearLibrary': if (confirm('Remove the saved character library?')) { store.del('nf_library'); renderSheet(); } break;
    case 'useBuiltin': S.script = null; applyScript(); S.selection = []; S.dealt = false; S.bluffs = []; sheet = null; toast('Using the built-in Nightfall set'); save(); break;
    case 'setChoose': if (st) { st.chooseN = Number(d.n); st.choice = st.choice.slice(0, Number(d.n)); save(); } break;
    case 'toggleGhostVotes': S.ghostVotes = !(S.ghostVotes !== false); log(`Ghost votes ${S.ghostVotes ? 'on' : 'off'}.`); save(); break;
    case 'deal': deal(); break;
    case 'start': startGame(); break;
    case 'sheetPlayer': sheet = { type: 'player', pid: d.pid }; renderSheet(); break;
    case 'closeSheet': sheet = null; renderSheet(); break;
    case 'toggleAlive': {
      const p = S.players[d.pid];
      if (p.alive) killPlayer(p.pid, 'Storyteller'); else { p.alive = true; p.ghostVote = true; log(`${p.name} revived.`); }
      save(); break;
    }
    case 'toggleFlag': { const p = S.players[d.pid]; p[d.f] = !p[d.f]; save(); break; }
    case 'pmsg': { const t = document.getElementById('pmsg').value.trim(); if (t) { msg(d.pid, t); toast('Sent'); save(); } break; }
    case 'broadcast': { const t = document.getElementById('bcast').value.trim(); if (t) { msgAll('📣 ' + t); toast('Sent to all'); save(); } break; }
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
      const t = document.getElementById('info-' + d.key).value.trim();
      if (t) { msg(st.pid, '🌙 ' + t); st.sent = t; log(`Info to ${pname(st.pid)} (${role(st.roleId).name}): ${t}`); toast('Info sent'); save(); }
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
    case 'dropReq': { const r = S.requests.splice(Number(d.i), 1)[0]; if (r) msg(r.pid, 'Your request was declined by the Storyteller.'); save(); break; }
    case 'duel': resolveDuel(Number(d.i), d.kill === '1'); break;
    case 'manualNom': openVote(document.getElementById('nomA').value, document.getElementById('nomB').value); break;
    case 'hostVote': if (S.vote) { S.vote.votes[d.pid] = d.v === '1'; save(); } break;
    case 'cancelVote': if (S.vote) { S.players[S.vote.nominator].nominated = false; S.players[S.vote.nominee].wasNominated = false; S.vote = null; S.announce = 'Vote cancelled.'; save(); } break;
    case 'closeVote': closeVote(); break;
    case 'endDay': if (confirm(S.block ? `Execute ${pname(S.block.pid)}?` : 'End the day with no execution?')) endDay(); break;
    case 'forceNight': if (confirm('Skip to night?')) { S.vote = null; S.block = null; startNight(); } break;
    case 'forceDay': if (confirm('Skip to day (applies dawn deaths)?')) startDay(); break;
    case 'win': if (confirm(`Declare ${d.side} the winner?`)) { endGame(d.side, 'Storyteller decision.'); save(); } break;
    case 'newGame': {
      const keep = { room: S.room, hostToken: S.hostToken, seats: S.seats, players: S.players, script: S.script, ghostVotes: S.ghostVotes };
      S = freshState(keep.room, keep.hostToken); S.seats = keep.seats; S.script = keep.script; S.ghostVotes = keep.ghostVotes;
      for (const id of keep.seats) S.players[id] = newPlayer(id, keep.players[id].name);
      syncPresence(); tab = 'setup'; S.phase = 'setup'; save(); break;
    }
    case 'endRoom': if (confirm('Close this room? The game will be lost.')) { store.del('nf_host'); store.del('nf_host_state'); location.reload(); } break;
  }
});

render();
