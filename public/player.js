/* Nightfall — player client. Only ever receives this player's private view. */
'use strict';
const $app = document.getElementById('app');
const $tabs = document.getElementById('tabs');
const $sheet = document.getElementById('sheet');

let me = store.get('nf_player'); // {room, token, pid, name}
let V = null;                     // view from host
let tab = 'town';
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
mountLangPicker(document.getElementById('lang'));
onLangChange(() => render());

function onMsg(m) {
  if (m.t === 'joined') {
    me = { room: m.room, token: m.token, pid: m.pid, name: m.name, late: !!m.late };
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
function pillH(cls, html) { return `<span class="pill ${cls}">${html}</span>`; } // html must already be escaped
// Characters this phone knows about (its own, the script, Travellers, Fabled, the end-of-game reveal), in its language.
window.roleLookup = (id) => {
  if (!V) return null;
  const sc = V.script || {};
  const all = [V.me && V.me.role, ...(sc.roles || []), ...(sc.travellers || []), ...(sc.fabled || []), ...(V.seats || []).map(s => s.traveller)];
  return locRole(all.find(r => r && r.id === id) || null);
};
window.jinxLookup = () => (V && V.script && V.script.jinxes) || [];
const myRole = () => locRole(V.me.role);

function render() {
  const title = document.getElementById('toptitle');
  if (!me) {
    $tabs.innerHTML = '';
    title.textContent = 'Nightfall';
    document.getElementById('topright').innerHTML = '';
    $app.innerHTML = `
      <div class="card center" style="margin-top:24px"><div style="font-size:3rem">🌘</div><h1>Nightfall</h1>
        <p class="muted">${t("A game of hidden roles. Join the Storyteller's room.")}</p></div>
      <form class="card" id="joinForm">
        <label for="jn">${t('Your name')}</label><input id="jn" maxlength="24" autocomplete="nickname" value="${esc(store.get('nf_name', ''))}" required>
        <label for="jr">${t('Room code')}</label><input id="jr" maxlength="4" autocapitalize="characters" style="text-transform:uppercase;letter-spacing:.2em;font-weight:700" value="${esc(urlRoom)}" required>
        ${joinError ? `<p style="color:var(--evil)">${esc(t(joinError))}</p>` : ''}
        <button class="primary block" style="margin-top:12px" ${pendingName ? 'disabled' : ''}>${pendingName ? t('Joining…') : t('Join')}</button>
      </form>
      <p class="center small muted"><a href="host.html" style="color:var(--muted)">${t("I'm the Storyteller →")}</a></p>`;
    return;
  }
  if (!V || !V.me.role) {
    title.textContent = t('Room {code}', { code: me.room });
    $tabs.innerHTML = '';
    $app.innerHTML = `<div class="card center" style="margin-top:24px"><div style="font-size:2.5rem">🕯️</div><h2>${t('Welcome, {name}', { name: esc(me.name) })}</h2>
      <p class="muted">${me.late ? t('The game is already running. The Storyteller can seat you as a Traveller.') : t('Waiting for the Storyteller to deal characters…')}</p>${hostOnline ? '' : `<p class="small" style="color:var(--warn)">${t('Storyteller is offline.')}</p>`}
      <button class="sm ghost" data-a="leave">${t('Leave room')}</button></div>`;
    return;
  }
  title.textContent = V.phase === 'night' ? '🌙 ' + t('Night {n}', { n: V.night }) : V.phase === 'day' ? '☀️ ' + t('Day {n}', { n: V.day }) : V.phase === 'over' ? t('Game over') : t('Room {code}', { code: V.room });
  document.getElementById('topright').innerHTML = V.me.alive ? '' : pill('dead', V.me.canVote ? t('👻 ghost vote') : t('💀 dead'));
  const unread = Math.max(0, V.msgs.length - seenMsgs);
  if (tab === 'inbox') { seenMsgs = V.msgs.length; store.set('nf_seen', seenMsgs); }
  const tabsDef = [['town', '🏘️', t('Town')], ['role', '🎭', t('Me')], ['script', '📜', t('Script')], ['notes', '📝', t('Notes')], ['inbox', '✉️', t('Inbox')]];
  // Don't rebuild the notes page while the player is typing in it (it would drop focus).
  const typing = tab === 'notes' && document.activeElement && document.activeElement.closest && document.activeElement.closest('#notes');
  $tabs.innerHTML = tabsDef.map(([k, ic, l]) => `<button class="${tab === k ? 'active' : ''}" data-a="tab" data-k="${k}"><span class="ic">${ic}</span>${l}${k === 'inbox' && unread && tab !== 'inbox' ? `<span class="badge">${unread}</span>` : ''}${k === 'town' && V.vote && V.vote.open && V.vote.myVote === null && V.me.canVote && tab !== 'town' ? '<span class="badge">!</span>' : ''}</button>`).join('');

  let top = '';
  if (!hostOnline) top += `<div class="banner small">${t('Storyteller is offline: waiting to reconnect.')}</div>`;
  if (V.winner) {
    top += `<div class="banner ${V.winner}"><h2>${esc(tx(V.announce))}</h2>
      ${(V.reveal || []).map(r => `<div class="row" style="margin-top:4px"><span class="grow">${esc(r.name)}</span>${pillH(r.team, roleArt(r, r.evil, 'xs') + ' ' + esc(fmtVar(r.role)) + infoBtn(r.rid))}${r.thought ? pill('', t('thought {role}', { role: r.thought })) : ''}</div>`).join('')}</div>`;
  }
  else if (V.phase === 'night') top += `<div class="banner small">🌙 ${esc(tx(V.announce))} ${V.prompt ? `<b>${t('The Storyteller is asking you to choose.')}</b>` : t('Keep your eyes closed until woken.')}</div>`;
  if (V.prompt && !sheet) top += `<button class="primary block" style="margin-bottom:12px" data-a="openPrompt">${t('Make your choice')}</button>`;
  if (!typing) $app.innerHTML = top + ({ role: viewRole, town: viewTown, script: viewScript, notes: viewNotes, inbox: viewInbox }[tab] || viewTown)();
  renderSheet();
}

// ---------- seating ----------
function seatingCircle() {
  const n = V.seats.length;
  const chips = V.seats.map((s, i) => {
    const a = (-90 + (i * 360) / n) * Math.PI / 180; // seat 1 at the top, clockwise
    const x = 50 + 40 * Math.cos(a), y = 50 + 40 * Math.sin(a);
    const cls = [s.pid === V.me.pid ? 'me' : '', s.alive ? '' : 'dead'].join(' ');
    return `<div class="chip ${cls}" style="left:${x}%;top:${y}%"><b>${s.alive ? s.seat : '💀'}</b><span>${esc(s.name)}</span></div>`;
  }).join('');
  return `<div class="circle">${chips}<div class="circle-mid small muted">${t('clockwise ↻')}<br>${t('{n} alive', { n: V.seats.filter(s => s.alive).length })}</div></div>`;
}
function neighbours() {
  const n = V.seats.length; const i = V.seats.findIndex(s => s.pid === V.me.pid);
  if (i < 0 || n < 2) return '';
  const prev = V.seats[(i - 1 + n) % n], next = V.seats[(i + 1) % n];
  const livingFrom = (step) => { for (let k = 1; k < n; k++) { const s = V.seats[(i + step * k + n * k) % n]; if (s.alive && s.pid !== V.me.pid) return s; } return null; };
  const lp = livingFrom(-1), ln = livingFrom(1);
  const nm = (s) => s ? `<b>${esc(s.name)}</b>${s.alive ? '' : ' 💀'}` : '—';
  return `<div class="card"><h3>${t('Your neighbours')}</h3>
    <div class="row"><div class="grow">◀ ${nm(prev)}</div><div>${nm(next)} ▶</div></div>
    ${(lp && lp !== prev) || (ln && ln !== next) ? `<div class="small muted" style="margin-top:6px">${t('Nearest living: {a} and {b}', { a: nm(lp), b: nm(ln) })}</div>` : ''}</div>`;
}

// ---------- script ----------
function viewScript() {
  const sc = V.script;
  if (!sc || !sc.roles.length) return `<div class="card muted center">${t("The Storyteller hasn't shared the character list yet.")}</div>`;
  const mine = V.me.role && V.me.role.id;
  const groups = ['townsfolk', 'outsider', 'minion', 'demon'].map(team => {
    const list = sc.roles.filter(r => r.team === team).map(locRole);
    if (!list.length) return '';
    return `<div class="card"><h3>${teamLabel(team, true)}</h3>${list.map(r => `
      <div class="roleline ${r.id === mine && reveal ? 'mine' : ''}"><div class="ri">${roleArt(r)}</div>
        <div><b>${esc(r.name)}</b>${infoBtn(r.id)}<div class="small muted">${esc(r.ability)}</div></div></div>`).join('')}</div>`;
  }).join('');
  const line = (r) => `<div class="roleline"><div class="ri">${roleArt(r)}</div><div><b>${esc(r.name)}</b>${infoBtn(r.id)}<div class="small muted">${esc(r.ability)}</div></div></div>`;
  const fabled = (sc.fabled || []).map(locRole);
  const travellers = (sc.travellers || []).map(locRole);
  const rules = (sc.bootlegger || []).length || (sc.jinxes || []).length || fabled.length ? `<div class="card" style="border-color:var(--accent)"><h3>${t('Special rules in this game')}</h3>
      ${fabled.map(line).join('')}
      ${(sc.bootlegger || []).length ? `<div class="small" style="margin-top:6px"><b>${t('Bootlegger rules:')}</b><ul style="margin:4px 0 0 18px;padding:0">${sc.bootlegger.map(b => `<li>${esc(b)}</li>`).join('')}</ul></div>` : ''}
      ${(sc.jinxes || []).length ? `<div class="small" style="margin-top:6px"><b>${t('Jinxes:')}</b>${sc.jinxes.map(j => `<div style="margin-top:4px">⚡ <b>${esc(j.aName)} + ${esc(j.bName)}</b>${j.reason ? ': ' + esc(j.reason) : ''}</div>`).join('')}</div>` : ''}
    </div>` : '';
  return `<div class="card"><h2 style="margin:0">${esc(sc.name)}</h2>${sc.author ? `<div class="small muted">${t('by {author}', { author: esc(sc.author) })}</div>` : ''}
    <div class="small muted">${t('Every character that might be in this game. Not all of them are in play.')}</div>
    ${sc.almanac ? `<div class="small" style="margin-top:4px"><a href="${esc(sc.almanac)}" target="_blank" rel="noopener" style="color:var(--accent)">${t('Almanac ↗')}</a></div>` : ''}</div>
    ${rules}${groups}
    ${travellers.length ? `<div class="card"><h3>${teamLabel('traveller', true)}</h3>${travellers.map(line).join('')}</div>` : ''}`;
}

// ---------- notes (stored only on this phone) ----------
const notesKey = () => `nf_notes:${me.room}:${me.pid}`;
function viewNotes() {
  const n = store.get(notesKey(), { text: '', players: {} });
  const rows = V.seats.filter(s => s.pid !== V.me.pid).map(s => `
    <div class="item ${s.alive ? '' : 'dead'}" style="gap:8px"><span class="seat">${s.alive ? s.seat : '💀'}</span>
      <div class="main"><div class="name small">${esc(s.name)}</div>
        <input data-note="${s.pid}" value="${esc(n.players[s.pid] || '')}" placeholder="${esc(t('claims… / suspect… / trust…'))}" style="min-height:40px;padding:6px 10px"></div></div>`).join('');
  return `<div id="notes">
    <div class="card small muted">${t('Only you can see these notes. They are saved on this phone.')}</div>
    <div class="card"><h3>${t('About each player')}</h3><div class="list">${rows}</div></div>
    <div class="card"><h3>${t('Notes')}</h3><textarea data-note="_text" style="min-height:200px" placeholder="${esc(t('What you learned, who claimed what, theories…'))}">${esc(n.text)}</textarea></div>
  </div>`;
}
document.addEventListener('input', (e) => {
  const k = e.target.dataset && e.target.dataset.note;
  if (!k || !me) return;
  const n = store.get(notesKey(), { text: '', players: {} });
  if (k === '_text') n.text = e.target.value; else n.players[k] = e.target.value;
  store.set(notesKey(), n);
});
document.addEventListener('focusout', (e) => { if (e.target.dataset && e.target.dataset.note) setTimeout(render, 0); });

function viewRole() {
  const r = myRole();
  if (!r) return `<div class="card center muted">${t('No character yet.')}</div>`;
  const side = V.me.evil ? 'evil' : 'good';
  const card = reveal
    ? `<div class="rolecard ${side}" data-a="hide"><div class="big">${roleArt(r, V.me.evil, 'lg')}</div><div class="rname">${esc(r.name)}${infoBtn(r.id)}</div>
        <div style="margin:6px 0">${pill(r.team, teamLabel(r.team))} ${pill(side, side === 'evil' ? t('Evil') : t('Good'))}</div>
        <p>${esc(r.ability)}</p><p class="small muted">${t('Tap to hide')}</p></div>`
    : `<div class="rolecard hidden" data-a="show"><div><div style="font-size:2.4rem">🂠</div><b>${t('Tap to reveal your character')}</b><div class="small muted">${t('Make sure nobody is looking')}</div></div></div>`;
  const ei = V.me.evilInfo;
  const evil = reveal && ei ? `<div class="card"><h3>${t('Your evil team')}</h3>
      ${ei.demon ? `<div>${t('Demon')}: <b>${ei.demon.map(esc).join(', ')}</b></div>` : ''}
      ${ei.minions && ei.minions.length ? `<div>${teamLabel('minion', true)}: <b>${ei.minions.map(esc).join(', ')}</b></div>` : ''}
      ${ei.bluffs ? `<div style="margin-top:6px">${t('Not in play (bluffs):')} ${ei.bluffs.map(b => pill('good', fmtVar(b))).join(' ')}</div>` : ''}</div>` : '';
  const duel = V.me.canDuel ? `<button class="danger block" data-a="openDuel">${t('⚔️ Challenge a player (once per game)')}</button>` : '';
  const goal = reveal ? `<div class="card small muted">${side === 'evil' ? t('Team goal: keep the Demon alive until only 2 players remain.') : t('Team goal: find and execute the Demon.')}</div>` : '';
  return `${card}<div style="height:12px"></div>${evil}${duel}${goal}`;
}

function viewTown() {
  const v = V.vote;
  let voteCard = '';
  if (v && v.open) {
    const exile = v.kind === 'exile';
    const can = V.me.canVote;
    const elig = (pid) => (v.eligible ? !!v.eligible[pid] : true);
    const why = exile
      ? t('Exile is not a vote: everyone may support it, alive or dead, and no ghost vote is spent.')
      : !V.me.alive
        ? (can ? t('👻 You are dead: voting EXECUTE spends your one ghost vote.') : (V.ghostVotes ? t('💀 You are dead and have used your ghost vote, so you cannot vote.') : t('💀 You are dead, so you cannot vote.')))
        : '';
    const hands = V.seats.map(s => {
      const h = v.hands ? v.hands[s.pid] : undefined;
      const state = !elig(s.pid) ? 'novote' : h === true ? 'yes' : h === false ? 'no' : 'wait';
      const label = { novote: t('💀 cannot vote'), yes: exile ? t('✋ exile') : t('✋ execute'), no: t('no'), wait: '…' }[state];
      return `<div class="hand ${state}"><span>${esc(s.name)}</span><b>${label}</b></div>`;
    }).join('');
    voteCard = `<div class="card ${can ? '' : 'novote'}" style="border-color:var(${exile ? '--warn' : '--accent'})"><h3>${exile ? t('Exile') : t('Vote now')}</h3>
      <h2>${exile ? t('Exile {name}?', { name: esc(v.nominee) }) : t('{a} nominated {b}', { a: esc(v.nominator), b: esc(v.nominee) })}</h2>
      <div class="votebig">${v.yes} <span class="small muted">/ ${t('{n} needed', { n: v.need || V.threshold })}${!exile && V.block ? ' · ' + t('must beat {n}', { n: V.block.votes }) : ''}</span></div>
      ${why ? `<p class="small" style="color:${can ? 'var(--warn)' : 'var(--muted)'}">${why}</p>` : ''}
      <div class="grid2"><button class="${v.myVote === true ? 'okb' : ''}" style="min-height:64px" data-a="vote" data-v="1" ${can ? '' : 'disabled'}>${exile ? t('✋ Exile') : t('✋ Execute')}</button>
        <button class="${v.myVote === false ? 'danger' : ''}" style="min-height:64px" data-a="vote" data-v="0" ${can ? '' : 'disabled'}>${t('No')}</button></div>
      <p class="center small muted">${!can ? t('You are watching this vote.') : v.myVote === null ? t('You have not voted yet.') : (v.myVote ? (exile ? t('You support the exile (you can change it until the Storyteller closes it)') : t('Your vote: EXECUTE (you can change it until the Storyteller closes the vote)')) : t('Your vote: no (you can change it until the Storyteller closes the vote)'))}</p>
      <div class="hands">${hands}</div></div>`;
  }
  const nominate = V.me.canNominate
    ? `<button class="good block" style="margin-bottom:12px" data-a="openNominate" ${V.pendingRequest ? 'disabled' : ''}>${V.pendingRequest ? t('Request sent: waiting for Storyteller') : t('👉 Nominate a player')}</button>`
    : (V.phase === 'day' && !V.vote ? `<div class="card small muted center">${V.nomsOpen ? (V.me.alive ? t('You have already nominated today.') : t('Dead players cannot nominate.')) : t('Nominations are closed. The Storyteller will open them.')}</div>` : '');
  // Any player, alive or dead, may call for a Traveller's exile during the day.
  const exileBtn = V.phase === 'day' && !V.vote && V.seats.some(s => s.traveller && s.alive && s.pid !== V.me.pid)
    ? `<button class="block" style="margin-bottom:12px" data-a="openExile">${t('🧳 Call for a Traveller’s exile')}</button>` : '';
  const seats = V.seats.map(s => `
    <div class="item ${s.alive ? '' : 'dead'}"><span class="seat">${s.alive ? s.seat : '💀'}</span>
      <div class="main"><span class="name">${esc(s.name)}</span>${s.pid === V.me.pid ? ` <span class="small muted">${t('(you)')}</span>` : ''}
        <div class="small ${s.alive ? 'alive-label' : 'muted'}">${s.alive ? t('alive') : (s.canVote ? t('dead · 1 ghost vote left') : t('dead · cannot vote'))}</div></div>
      ${s.traveller ? pill('warn', '🧳 ' + (s.traveller.id ? locRole(s.traveller).name : t('Traveller'))) : ''}
      ${s.exiled ? pill('dead', t('exiled')) : ''}
      ${!s.alive ? pill('dead', s.canVote ? '👻' : '✖') : ''}
      ${V.block && V.block.name === s.name ? pill('evil', t('on the block')) : ''}</div>`).join('');
  return `${voteCard}
    ${V.phase === 'day' ? `<div class="card small">${esc(tx(V.announce))}<div class="muted">${t('{a} alive · {n} votes to execute', { a: V.seats.filter(s => s.alive).length, n: V.threshold })}</div></div>` : ''}
    ${nominate}
    ${exileBtn}
    ${seatingCircle()}
    ${neighbours()}
    <div class="card list" style="padding:4px">${seats}</div>
    ${V.nominations.length ? `<div class="card"><h3>${t("Today's nominations")}</h3>${V.nominations.map(n => `<div class="small" style="margin-bottom:4px">${esc(n.nominator)} → <b>${esc(n.nominee)}</b>: ${t('{n} votes', { n: n.votes })}${n.voters && n.voters.length ? `<div class="muted">✋ ${n.voters.map(esc).join(', ')}</div>` : ''}</div>`).join('')}</div>` : ''}`;
}

function viewInbox() {
  if (!V.msgs.length) return `<div class="card muted center">${t('No messages from the Storyteller yet.')}</div>`;
  return V.msgs.slice().reverse().map(m => `<div class="msg">${esc(tx(m.text))}<time>${new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div>`).join('');
}

function promptText(p) {
  if (p.max > p.min) return t('Choose {a}–{b} players.', { a: p.min, b: p.max });
  return p.min === 1 ? t('Choose 1 player.') : t('Choose {n} players.', { n: p.min });
}
function renderSheet() {
  if (!sheet || !V) { $sheet.innerHTML = ''; return; }
  let title = '', sub = '', min = 1, max = 1, pool = [], btn = '';
  if (sheet.type === 'prompt') {
    if (!V.prompt) { sheet = null; $sheet.innerHTML = ''; return; }
    const p = V.prompt;
    title = `${fmtVar(p.role)}: ${promptText(p)}`; sub = fmtVar(p.ability); min = p.min; max = p.max;
    pool = V.seats.filter(s => !(p.notSelf && s.pid === V.me.pid)); btn = t('Confirm');
  } else if (sheet.type === 'nominate') {
    title = t('Nominate a player'); sub = t('Each player can be nominated once per day.');
    pool = V.seats.filter(s => V.nominatable.includes(s.pid)); btn = t('Nominate');
  } else if (sheet.type === 'exile') {
    title = t('Call for a Traveller’s exile'); sub = t('Everyone, alive or dead, may then support the exile. Say it out loud too.');
    pool = V.seats.filter(s => s.traveller && s.alive && s.pid !== V.me.pid); btn = t('Call for exile');
  } else if (sheet.type === 'duel') {
    title = t('Challenge a player'); sub = t('Announce your challenge out loud too.');
    pool = V.seats.filter(s => s.pid !== V.me.pid && s.alive); btn = t('Challenge');
  }
  const ok = sheet.sel.length >= min && sheet.sel.length <= max;
  $sheet.innerHTML = `<div class="sheet-bg" ${sheet.type === 'prompt' ? '' : 'data-a="closeSheet"'}><div class="sheet" data-stop="1">
    <div class="row"><h2 class="grow">${esc(title)}</h2><button class="sm ghost" data-a="closeSheet">${sheet.type === 'prompt' ? t('Later') : '✕'}</button></div>
    <p class="small muted">${esc(sub)}</p>
    <div class="list">${pool.map(s => `<div class="item tap ${sheet.sel.includes(s.pid) ? 'sel' : ''} ${s.alive ? '' : 'dead'}" data-a="sel" data-pid="${s.pid}" data-max="${max}">
      <span class="seat">${s.seat}</span><div class="main"><span class="name">${esc(s.name)}</span>${s.pid === V.me.pid ? ` <span class="small muted">${t('(you)')}</span>` : ''}</div>${sheet.sel.includes(s.pid) ? '✓' : ''}</div>`).join('')}</div>
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
    case 'leave': if (confirm(t('Leave this room?'))) { net.send({ t: 'leave' }); setTimeout(() => net.disconnect(), 300); store.del('nf_player'); me = null; V = null; } break;
    case 'vote': act({ kind: 'vote', yes: d.v === '1' }); break;
    case 'openPrompt': sheet = { type: 'prompt', sel: [] }; break;
    case 'openNominate': sheet = { type: 'nominate', sel: [] }; break;
    case 'openDuel': sheet = { type: 'duel', sel: [] }; break;
    case 'openExile': sheet = { type: 'exile', sel: [] }; break;
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
      else if (sheet.type === 'exile') act({ kind: 'exile', target: sheet.sel[0] });
      sheet = null; break;
    }
  }
  render();
});

render();
