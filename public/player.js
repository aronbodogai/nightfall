/* Nightfall — player client. Only ever receives this player's private view. */
'use strict';
const $app = document.getElementById('app');
const $tabs = document.getElementById('tabs');
const $sheet = document.getElementById('sheet');

let me = store.get('nf_player'); // {room, token, pid, name}
let V = null;                     // view from host
let tab = 'role';
let online = false, hostOnline = true;
let joinError = '';
let sheet = null;                 // {type:'nominate'|'duel'|'prompt', sel:[]}
let seenMsgs = store.get('nf_seen', 0);
let reveal = false;
let lastPromptId = null, lastVoteKey = null;

const params = new URLSearchParams(location.search);
const urlRoom = (params.get('room') || '').toUpperCase();
if (me && urlRoom && me.room !== urlRoom) me = null;

let pendingName = null;
const net = Net(onMsg, (on) => { online = on; document.getElementById('netdot').className = 'dot' + (on && hostOnline ? ' on' : ''); render(); });
net.onOpen(() => {
  if (me && me.token) net.send({ t: 'join', room: me.room, token: me.token });
  else if (pendingName) net.send({ t: 'join', room: net.room, name: pendingName });
});
if (me && me.room) net.connect(me.room);

function onMsg(m) {
  if (m.t === 'joined') {
    me = { room: m.room, token: m.token, pid: m.pid, name: m.name };
    store.set('nf_player', me); joinError = ''; pendingName = null;
    history.replaceState(null, '', '/?room=' + m.room);
  } else if (m.t === 'error') {
    joinError = m.msg;
    if (m.code === 'no_room') { net.disconnect(); me = null; V = null; store.del('nf_player'); }
    if (!me) pendingName = null;
  } else if (m.t === 'view') {
    const prev = V; V = m.view;
    if (V.prompt && V.prompt.id !== lastPromptId) { lastPromptId = V.prompt.id; sheet = { type: 'prompt', sel: [] }; vibrate([80, 60, 80]); }
    if (!V.prompt && sheet && sheet.type === 'prompt') sheet = null;
    const vk = V.vote && V.vote.open ? V.vote.nomineePid + ':' + V.day : null;
    if (vk && vk !== lastVoteKey) { lastVoteKey = vk; tab = 'town'; vibrate(120); }
    if (prev && V.msgs.length > prev.msgs.length && tab !== 'inbox') vibrate(40);
    if (V.phase === 'night' && prev && prev.phase !== 'night') reveal = false;
  } else if (m.t === 'kicked') {
    net.disconnect(); me = null; V = null; store.del('nf_player'); joinError = 'You were removed from the game.';
  } else if (m.t === 'host_status') {
    hostOnline = m.online;
    document.getElementById('netdot').className = 'dot' + (online && hostOnline ? ' on' : '');
  }
  render();
}

function act(a) { net.send({ t: 'act', act: a }); }
function pill(cls, text) { return `<span class="pill ${cls}">${esc(text)}</span>`; }

function render() {
  const title = document.getElementById('toptitle');
  if (!me) {
    $tabs.innerHTML = '';
    title.textContent = 'Nightfall';
    document.getElementById('topright').innerHTML = '';
    $app.innerHTML = `
      <div class="card center" style="margin-top:24px"><div style="font-size:3rem">🌘</div><h1>Nightfall</h1>
        <p class="muted">A game of hidden roles. Join the Storyteller's room on this Wi-Fi.</p></div>
      <form class="card" id="joinForm">
        <label for="jn">Your name</label><input id="jn" maxlength="24" autocomplete="nickname" value="${esc(store.get('nf_name', ''))}" required>
        <label for="jr">Room code</label><input id="jr" maxlength="4" autocapitalize="characters" style="text-transform:uppercase;letter-spacing:.2em;font-weight:700" value="${esc(urlRoom)}" required>
        ${joinError ? `<p style="color:var(--evil)">${esc(joinError)}</p>` : ''}
        <button class="primary block" style="margin-top:12px" ${pendingName ? 'disabled' : ''}>${pendingName ? 'Joining…' : 'Join'}</button>
      </form>
      <p class="center small muted"><a href="host.html" style="color:var(--muted)">I'm the Storyteller →</a></p>`;
    return;
  }
  if (!V || !V.me.role) {
    title.textContent = `Room ${me.room}`;
    $tabs.innerHTML = '';
    $app.innerHTML = `<div class="card center" style="margin-top:24px"><div style="font-size:2.5rem">🕯️</div><h2>Welcome, ${esc(me.name)}</h2>
      <p class="muted">Waiting for the Storyteller to deal characters…</p>${hostOnline ? '' : '<p class="small" style="color:var(--warn)">Storyteller is offline.</p>'}
      <button class="sm ghost" data-a="leave">Leave room</button></div>`;
    return;
  }
  title.textContent = V.phase === 'night' ? `🌙 Night ${V.night}` : V.phase === 'day' ? `☀️ Day ${V.day}` : V.phase === 'over' ? 'Game over' : `Room ${V.room}`;
  document.getElementById('topright').innerHTML = V.me.alive ? '' : pill('dead', V.me.ghostVote ? '👻 ghost vote' : '👻 dead');
  const unread = Math.max(0, V.msgs.length - seenMsgs);
  if (tab === 'inbox') { seenMsgs = V.msgs.length; store.set('nf_seen', seenMsgs); }
  const tabsDef = [['role', '🎭', 'Character'], ['town', '🏘️', 'Town'], ['inbox', '✉️', 'Messages']];
  $tabs.innerHTML = tabsDef.map(([k, ic, l]) => `<button class="${tab === k ? 'active' : ''}" data-a="tab" data-k="${k}"><span class="ic">${ic}</span>${l}${k === 'inbox' && unread && tab !== 'inbox' ? `<span class="badge">${unread}</span>` : ''}${k === 'town' && V.vote && V.vote.open && V.vote.myVote === null && tab !== 'town' ? '<span class="badge">!</span>' : ''}</button>`).join('');

  let top = '';
  if (!hostOnline) top += `<div class="banner small">Storyteller is offline — waiting to reconnect.</div>`;
  if (V.winner) {
    top += `<div class="banner ${V.winner}"><h2>${esc(V.announce)}</h2>
      ${(V.reveal || []).map(r => `<div class="row" style="margin-top:4px"><span class="grow">${esc(r.name)}</span>${pill(r.team, r.icon + ' ' + r.role)}${r.thought ? pill('', 'thought ' + r.thought) : ''}</div>`).join('')}</div>`;
  }
  else if (V.phase === 'night') top += `<div class="banner small">🌙 ${esc(V.announce)} ${V.prompt ? '<b>The Storyteller is asking you to choose.</b>' : 'Keep your eyes closed until woken.'}</div>`;
  if (V.prompt && !sheet) top += `<button class="primary block" style="margin-bottom:12px" data-a="openPrompt">Make your choice</button>`;
  $app.innerHTML = top + ({ role: viewRole, town: viewTown, inbox: viewInbox }[tab])();
  renderSheet();
}

function viewRole() {
  const r = V.me.role;
  if (!r) return `<div class="card center muted">No character yet.</div>`;
  const side = V.me.evil ? 'evil' : 'good';
  const card = reveal
    ? `<div class="rolecard ${side}" data-a="hide"><div class="big">${r.icon}</div><div class="rname">${esc(r.name)}</div>
        <div style="margin:6px 0">${pill(r.team, TEAM_LABEL[r.team])} ${pill(side, side === 'evil' ? 'Evil' : 'Good')}</div>
        <p>${esc(r.ability)}</p><p class="small muted">Tap to hide</p></div>`
    : `<div class="rolecard hidden" data-a="show"><div><div style="font-size:2.4rem">🂠</div><b>Tap to reveal your character</b><div class="small muted">Make sure nobody is looking</div></div></div>`;
  const ei = V.me.evilInfo;
  const evil = reveal && ei ? `<div class="card"><h3>Your evil team</h3>
      ${ei.demon ? `<div>Demon: <b>${ei.demon.map(esc).join(', ')}</b></div>` : ''}
      ${ei.minions && ei.minions.length ? `<div>Minions: <b>${ei.minions.map(esc).join(', ')}</b></div>` : ''}
      ${ei.bluffs ? `<div style="margin-top:6px">Not in play (bluffs): ${ei.bluffs.map(b => pill('good', b)).join(' ')}</div>` : ''}</div>` : '';
  const duel = V.me.canDuel ? `<button class="danger block" data-a="openDuel">⚔️ Challenge a player (once per game)</button>` : '';
  const goal = reveal ? `<div class="card small muted">Team goal: ${side === 'evil' ? 'Keep the Demon alive until only 2 players remain.' : 'Find and execute the Demon.'}</div>` : '';
  return `${card}<div style="height:12px"></div>${evil}${duel}${goal}`;
}

function viewTown() {
  const v = V.vote;
  let voteCard = '';
  if (v && v.open) {
    const can = V.me.canVote;
    const why = !V.me.alive
      ? (can ? '👻 You are dead: voting EXECUTE spends your one ghost vote.' : (V.ghostVotes ? '💀 You are dead and have used your ghost vote, so you cannot vote.' : '💀 You are dead, so you cannot vote.'))
      : '';
    const hands = V.seats.map(s => {
      const h = v.hands ? v.hands[s.pid] : undefined;
      const state = !s.canVote ? 'novote' : h === true ? 'yes' : h === false ? 'no' : 'wait';
      const label = { novote: '💀 cannot vote', yes: '✋ execute', no: 'no', wait: '…' }[state];
      return `<div class="hand ${state}"><span>${esc(s.name)}</span><b>${label}</b></div>`;
    }).join('');
    voteCard = `<div class="card ${can ? '' : 'novote'}" style="border-color:var(--accent)"><h3>Vote now</h3>
      <h2>${esc(v.nominator)} nominated ${esc(v.nominee)}</h2>
      <div class="votebig">${v.yes} <span class="small muted">/ ${V.threshold} needed${V.block ? ` · must beat ${V.block.votes}` : ''}</span></div>
      ${why ? `<p class="small" style="color:${can ? 'var(--warn)' : 'var(--muted)'}">${why}</p>` : ''}
      <div class="grid2"><button class="${v.myVote === true ? 'okb' : ''}" style="min-height:64px" data-a="vote" data-v="1" ${can ? '' : 'disabled'}>✋ Execute</button>
        <button class="${v.myVote === false ? 'danger' : ''}" style="min-height:64px" data-a="vote" data-v="0" ${can ? '' : 'disabled'}>No</button></div>
      <p class="center small muted">${!can ? 'You are watching this vote.' : v.myVote === null ? 'You have not voted yet.' : 'Your vote: ' + (v.myVote ? 'EXECUTE' : 'no') + ' (you can change it until the Storyteller closes the vote)'}</p>
      <div class="hands">${hands}</div></div>`;
  }
  const nominate = V.me.canNominate ? `<button class="good block" style="margin-bottom:12px" data-a="openNominate" ${V.pendingRequest ? 'disabled' : ''}>${V.pendingRequest ? 'Request sent — waiting for Storyteller' : '👉 Nominate a player'}</button>` : '';
  const seats = V.seats.map(s => `
    <div class="item ${s.alive ? '' : 'dead'}"><span class="seat">${s.alive ? s.seat : '💀'}</span>
      <div class="main"><span class="name">${esc(s.name)}</span>${s.pid === V.me.pid ? ' <span class="small muted">(you)</span>' : ''}
        <div class="small ${s.alive ? 'alive-label' : 'muted'}">${s.alive ? 'alive' : 'dead · ' + (s.canVote ? '1 ghost vote left' : 'cannot vote')}</div></div>
      ${!s.alive ? pill('dead', s.canVote ? '👻' : '✖') : ''}
      ${V.block && V.block.name === s.name ? pill('evil', 'on the block') : ''}</div>`).join('');
  return `${voteCard}
    ${V.phase === 'day' ? `<div class="card small">${esc(V.announce)}<div class="muted">${V.seats.filter(s => s.alive).length} alive · ${V.threshold} votes to execute</div></div>` : ''}
    ${nominate}
    <div class="card list" style="padding:4px">${seats}</div>
    ${V.nominations.length ? `<div class="card"><h3>Today's nominations</h3>${V.nominations.map(n => `<div class="small" style="margin-bottom:4px">${esc(n.nominator)} → <b>${esc(n.nominee)}</b>: ${n.votes} votes${n.voters && n.voters.length ? `<div class="muted">✋ ${n.voters.map(esc).join(', ')}</div>` : ''}</div>`).join('')}</div>` : ''}`;
}

function viewInbox() {
  if (!V.msgs.length) return `<div class="card muted center">No messages from the Storyteller yet.</div>`;
  return V.msgs.slice().reverse().map(m => `<div class="msg">${esc(m.text)}<time>${new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div>`).join('');
}

function renderSheet() {
  if (!sheet || !V) { $sheet.innerHTML = ''; return; }
  let title = '', sub = '', min = 1, max = 1, pool = [], btn = '';
  if (sheet.type === 'prompt') {
    if (!V.prompt) { sheet = null; $sheet.innerHTML = ''; return; }
    const p = V.prompt;
    title = `${p.role}: ${p.text}`; sub = p.ability; min = p.min; max = p.max;
    pool = V.seats.filter(s => !(p.notSelf && s.pid === V.me.pid)); btn = 'Confirm';
  } else if (sheet.type === 'nominate') {
    title = 'Nominate a player'; sub = 'Each player can be nominated once per day.';
    pool = V.seats.filter(s => V.nominatable.includes(s.pid)); btn = 'Nominate';
  } else if (sheet.type === 'duel') {
    title = 'Challenge a player'; sub = 'Announce your challenge out loud too.';
    pool = V.seats.filter(s => s.pid !== V.me.pid && s.alive); btn = 'Challenge';
  }
  const ok = sheet.sel.length >= min && sheet.sel.length <= max;
  $sheet.innerHTML = `<div class="sheet-bg" ${sheet.type === 'prompt' ? '' : 'data-a="closeSheet"'}><div class="sheet" data-stop="1">
    <div class="row"><h2 class="grow">${esc(title)}</h2>${sheet.type === 'prompt' ? '<button class="sm ghost" data-a="closeSheet">Later</button>' : '<button class="sm ghost" data-a="closeSheet">✕</button>'}</div>
    <p class="small muted">${esc(sub)}</p>
    <div class="list">${pool.map(s => `<div class="item tap ${sheet.sel.includes(s.pid) ? 'sel' : ''} ${s.alive ? '' : 'dead'}" data-a="sel" data-pid="${s.pid}" data-max="${max}">
      <span class="seat">${s.seat}</span><div class="main"><span class="name">${esc(s.name)}</span>${s.pid === V.me.pid ? ' <span class="small muted">(you)</span>' : ''}</div>${sheet.sel.includes(s.pid) ? '✓' : ''}</div>`).join('')}</div>
    <button class="primary block" style="margin-top:12px" data-a="confirmSheet" ${ok ? '' : 'disabled'}>${btn}${max > 1 ? ` (${sheet.sel.length}/${max})` : ''}</button>
  </div></div>`;
}

document.addEventListener('submit', (e) => {
  if (e.target.id !== 'joinForm') return;
  e.preventDefault();
  const name = document.getElementById('jn').value.trim();
  const room = document.getElementById('jr').value.trim().toUpperCase();
  if (!name || !room) return;
  store.set('nf_name', name);
  me = null; joinError = '';
  pendingName = name;
  if (net.room === room) net.send({ t: 'join', room, name });
  else net.connect(room);
  render();
});

document.addEventListener('click', (e) => {
  const stop = e.target.closest('[data-stop]');
  const el = e.target.closest('[data-a]');
  if (!el) return;
  if (stop && !stop.contains(el)) return;
  const d = el.dataset;
  switch (d.a) {
    case 'tab': tab = d.k; window.scrollTo(0, 0); break;
    case 'show': reveal = true; break;
    case 'hide': reveal = false; break;
    case 'leave': if (confirm('Leave this room?')) { net.send({ t: 'leave' }); setTimeout(() => net.disconnect(), 300); store.del('nf_player'); me = null; V = null; } break;
    case 'vote': act({ kind: 'vote', yes: d.v === '1' }); break;
    case 'openPrompt': sheet = { type: 'prompt', sel: [] }; break;
    case 'openNominate': sheet = { type: 'nominate', sel: [] }; break;
    case 'openDuel': sheet = { type: 'duel', sel: [] }; break;
    case 'closeSheet': sheet = null; break;
    case 'sel': {
      const max = Number(d.max) || 1; const i = sheet.sel.indexOf(d.pid);
      if (i >= 0) sheet.sel.splice(i, 1); else { sheet.sel.push(d.pid); if (sheet.sel.length > max) sheet.sel.shift(); }
      break;
    }
    case 'confirmSheet': {
      if (sheet.type === 'prompt') act({ kind: 'answer', promptId: V.prompt.id, targets: sheet.sel });
      else if (sheet.type === 'nominate') act({ kind: 'nominate', target: sheet.sel[0] });
      else if (sheet.type === 'duel') act({ kind: 'duel', target: sheet.sel[0] });
      sheet = null; break;
    }
  }
  render();
});

render();
