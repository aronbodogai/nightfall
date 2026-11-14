// Script import. Accepts the official Script Tool format (see the botc-release script-schema.json) and
// older community formats:
//   [ { "id": "_meta", name, author, almanac, bootlegger[], firstNight[], otherNight[] },
//     "officialid",                 // resolved from the character library the Storyteller imported
//     { "id": "officialid" },       // deprecated object form
//     { id, name, team, ability, firstNight, otherNight, ...Reminder, reminders, remindersGlobal, setup, jinxes } ]
//
// The app ships no official character data. The Storyteller imports their own:
//   - a character library: a list of character objects (official roles.json or clocktower.online style),
//   - optionally a night sheet: { firstNight: [ids & markers], otherNight: [...] },
//   - optionally a jinx list: [ { id, jinx: [{ id, reason }] } ] (or clocktower.online "hatred").
'use strict';

window.ScriptImport = (() => {
  const CORE_TEAMS = ['townsfolk', 'outsider', 'minion', 'demon'];
  const ALL_TEAMS = [...CORE_TEAMS, 'traveller', 'fabled', 'loric'];
  const MARKERS = ['dusk', 'minioninfo', 'demoninfo', 'dawn'];
  const WORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4 };
  const normId = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const normTeam = (s) => { const x = String(s || '').toLowerCase(); return x === 'traveler' ? 'traveller' : x; };

  function guessChoose(ability) {
    const m = String(ability || '').match(/choose (a|an|one|two|three|four|\d+) (?:[a-z]+ ){0,2}players?/i);
    if (!m) return 0;
    const w = m[1].toLowerCase();
    return WORDS[w] || Number(w) || 0;
  }

  // ---------- data file detection ----------
  function asJson(x) {
    if (typeof x !== 'string') return x;
    try { return JSON.parse(x); } catch { throw new Error('That is not valid JSON.'); }
  }
  // Figures out what kind of data file this is: a character list, a night sheet, a jinx list, or a script.
  function detect(json) {
    const d = asJson(json);
    if (d && !Array.isArray(d) && Array.isArray(d.firstNight) && Array.isArray(d.otherNight)) return { kind: 'nightsheet', data: d };
    const list = Array.isArray(d) ? d : (d && typeof d === 'object' ? Object.values(d) : []);
    if (list.length && list.every(x => x && typeof x === 'object' && x.id && (Array.isArray(x.jinx) || Array.isArray(x.hatred)))) return { kind: 'jinxes', data: list };
    const meta = list.find(x => x && x.id === '_meta');
    const roleObjs = list.filter(x => x && typeof x === 'object' && x.id && x.name && x.team);
    if (!meta && roleObjs.length && roleObjs.length >= list.length * 0.8) return { kind: 'roles', data: roleObjs };
    return { kind: 'script', data: list };
  }
  function parseLibrary(json) {
    const r = detect(json);
    if (r.kind === 'roles') return { kind: 'roles', data: r.data.map(x => Object.assign({}, x, { id: normId(x.id), team: normTeam(x.team) })) };
    if (r.kind === 'nightsheet') return { kind: 'nightsheet', data: { firstNight: r.data.firstNight.map(normId), otherNight: r.data.otherNight.map(normId) } };
    if (r.kind === 'jinxes') {
      const map = {};
      for (const x of r.data) map[normId(x.id)] = (x.jinx || x.hatred || []).map(j => ({ id: normId(j.id), reason: String(j.reason || '') }));
      return { kind: 'jinxes', data: map };
    }
    throw new Error('Not a character list, night sheet or jinx list.');
  }

  // ---------- script parsing ----------
  // lib = { roles: [...], nightsheet: {firstNight, otherNight} | null, jinxes: {id: [{id, reason}]} }
  function parse(json, lib) {
    lib = lib || {};
    let data = asJson(json);
    if (!Array.isArray(data)) data = data && (data.roles || data.characters || data.script);
    if (!Array.isArray(data)) throw new Error('Expected a script: a JSON list of characters.');
    const libMap = {};
    for (const d of lib.roles || []) if (d && d.id && d.name) libMap[normId(d.id)] = d;
    const builtin = Object.fromEntries(BASE_ROLES.concat(window.BASE_EXTRAS || []).map(r => [r.id, r]));

    const out = { name: 'Imported script', author: '', almanac: '', bootlegger: [], roles: [], travellers: [], fabled: [],
      missing: [], warnings: [], jinxes: [], markers: { first: {}, other: {} } };
    if (data.length > 201) out.warnings.push('More than 200 characters.');
    const meta = data.find(x => x && typeof x === 'object' && x.id === '_meta') || {};
    out.name = String(meta.name || out.name);
    out.author = String(meta.author || '');
    out.almanac = String(meta.almanac || '');
    out.bootlegger = (Array.isArray(meta.bootlegger) ? meta.bootlegger : []).map(String);
    const metaFirst = Array.isArray(meta.firstNight) ? meta.firstNight.map(normId) : null;
    const metaOther = Array.isArray(meta.otherNight) ? meta.otherNight.map(normId) : null;
    const ns = lib.nightsheet || null;

    const defs = [];
    const seen = new Set();
    for (const el of data) {
      const rawId = typeof el === 'string' ? el : el && el.id;
      if (!rawId || rawId === '_meta') continue;
      const key = normId(rawId);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const full = typeof el === 'object' && el.name && el.team && el.ability;
      if (full && libMap[key]) out.warnings.push(`Custom character "${el.name}" reuses the id of a library character; the custom version is used.`);
      const def = full ? el : (libMap[key] || builtin[key]);
      if (!def) { out.missing.push(rawId); continue; }
      defs.push(def);
    }

    // Night order: the script's own _meta order wins, then the imported night sheet, then the characters' numbers.
    const orderOf = (id, num, first) => {
      const arr = first ? metaFirst : metaOther;
      if (arr) { const i = arr.indexOf(id); return i >= 0 ? (i + 1) * 10 : (num > 0 ? 5000 + num : null); }
      const sheet = ns && (first ? ns.firstNight : ns.otherNight);
      if (sheet) { const i = sheet.indexOf(id); if (i >= 0) return (i + 1) * 10; }
      return num > 0 ? num * 10 : null;
    };
    const markerSrc = (first) => (first ? metaFirst : metaOther) || (ns && (first ? ns.firstNight : ns.otherNight)) || null;
    for (const first of [true, false]) {
      const arr = markerSrc(first);
      if (!arr) continue;
      for (const m of MARKERS) { const i = arr.indexOf(m); if (i >= 0) out.markers[first ? 'first' : 'other'][m] = (i + 1) * 10; }
    }

    for (const def of defs) {
      const role = toRole(def, orderOf);
      if (!ALL_TEAMS.includes(role.team)) { out.warnings.push(`Unknown team "${role.team}" for ${role.name}.`); continue; }
      if (CORE_TEAMS.includes(role.team)) out.roles.push(role);
      else if (role.team === 'traveller') out.travellers.push(role);
      else out.fabled.push(role);
    }

    // Jinxes between characters on this script (from the characters themselves and the imported jinx list).
    const ids = new Set([...out.roles, ...out.travellers, ...out.fabled].map(r => r.id));
    const byId = Object.fromEntries([...out.roles, ...out.travellers, ...out.fabled].map(r => [r.id, r]));
    const pairs = new Set();
    const addJinx = (a, b, reason) => {
      if (!ids.has(a) || !ids.has(b)) return;
      const k = [a, b].sort().join('|');
      if (pairs.has(k)) return;
      pairs.add(k);
      out.jinxes.push({ a, b, aName: byId[a].name, bName: byId[b].name, reason: String(reason || '') });
    };
    for (const def of defs) for (const j of def.jinxes || []) addJinx(normId(def.id), normId(j.id), j.reason);
    for (const [a, list] of Object.entries(lib.jinxes || {})) for (const j of list) addJinx(a, j.id, j.reason);

    if (!out.roles.length) throw new Error(out.missing.length ? 'No usable characters found. Import a character library first.' : 'No usable characters found.');
    return out;
  }

  // Convert a character definition into the app's role shape.
  function toRole(d, orderOf) {
    if (d.first !== undefined || d.other !== undefined || (d.team && !d.ability && d.icon)) return d; // built-in Nightfall role
    const team = normTeam(d.team);
    const ability = String(d.ability || '');
    const id = normId(d.id);
    const choose = guessChoose(ability);
    const r = {
      id, name: String(d.name || d.id), team, ability,
      icon: TEAM_ICON[team] || '❔', setup: !!d.setup, imported: true,
      reminders: Array.isArray(d.reminders) ? d.reminders.map(String) : [],
      remindersGlobal: Array.isArray(d.remindersGlobal) ? d.remindersGlobal.map(String) : [],
    };
    const fo = orderOf(id, Number(d.firstNight) || 0, true);
    const oo = orderOf(id, Number(d.otherNight) || 0, false);
    if (fo != null) r.first = { order: fo, choose, reminder: String(d.firstNightReminder || '') };
    if (oo != null) {
      r.other = { order: oo, choose, reminder: String(d.otherNightReminder || '') };
      if (team === 'demon' && /\bdies?\b/i.test(ability) && choose > 0) r.other.effect = 'kill';
    }
    return r;
  }

  async function fetchText(url) {
    let res;
    try { res = await fetch(url); } catch { throw new Error('Could not download it. The site may block this; download the JSON and use "Choose file" or paste it instead.'); }
    if (!res.ok) throw new Error('Download failed: HTTP ' + res.status);
    return res.text();
  }

  return { parse, parseLibrary, detect, fetchText, normId, normTeam, guessChoose };
})();
