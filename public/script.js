// Script import: reads the community script JSON format used by online script builders,
// e.g. [{ "id": "_meta", "name": "My Script", "author": "me" }, "someid", { "id": "custom", "name": ..., "team": ..., "ability": ... }]
//
// Characters given as full objects (homebrew / custom characters) are imported as-is.
// Characters given only by id are resolved from (1) the character library the Storyteller imported
// (a JSON list of character definitions in the same format) or (2) the built-in Nightfall set.
'use strict';

window.ScriptImport = (() => {
  const CORE_TEAMS = ['townsfolk', 'outsider', 'minion', 'demon'];
  const WORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4 };
  const normId = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

  function guessChoose(ability) {
    const m = String(ability || '').match(/choose (a|an|one|two|three|four|\d+) (?:[a-z]+ ){0,2}players?/i);
    if (!m) return 0;
    const w = m[1].toLowerCase();
    return WORDS[w] || Number(w) || 0;
  }

  // Convert a community-format character definition into the app's role shape.
  function toRole(d) {
    if (d.first !== undefined || d.other !== undefined) return d; // already a Nightfall role
    const team = String(d.team || '').toLowerCase();
    const ability = String(d.ability || '');
    const choose = guessChoose(ability);
    const r = {
      id: normId(d.id), name: String(d.name || d.id), team, ability,
      icon: TEAM_ICON[team] || '❔', setup: !!d.setup, imported: true,
    };
    const fn = Number(d.firstNight) || 0, on = Number(d.otherNight) || 0;
    if (fn > 0) r.first = { order: 10 + fn, choose, reminder: String(d.firstNightReminder || '') };
    if (on > 0) {
      r.other = { order: 10 + on, choose, reminder: String(d.otherNightReminder || '') };
      if (team === 'demon' && /\bdies?\b/i.test(ability) && choose > 0) r.other.effect = 'kill';
    }
    return r;
  }

  function libraryMap(lib) {
    const map = {};
    const list = Array.isArray(lib) ? lib : (lib && typeof lib === 'object' ? Object.values(lib) : []);
    for (const d of list) if (d && d.id && d.name) map[normId(d.id)] = d;
    return map;
  }

  // Returns { name, author, roles, missing, skipped } or throws Error with a readable message.
  function parse(json, library) {
    let data = json;
    if (typeof data === 'string') {
      try { data = JSON.parse(data); } catch { throw new Error('That is not valid JSON.'); }
    }
    if (!Array.isArray(data)) data = data && (data.roles || data.characters || data.script);
    if (!Array.isArray(data)) throw new Error('Expected a script: a JSON list of characters.');
    const lib = libraryMap(library);
    const builtin = Object.fromEntries(BASE_ROLES.map(r => [r.id, r]));
    const out = { name: 'Imported script', author: '', roles: [], missing: [], skipped: [] };
    const seen = new Set();
    for (const el of data) {
      const id = typeof el === 'string' ? el : el && el.id;
      if (!id) continue;
      if (id === '_meta') { out.name = el.name || out.name; out.author = el.author || ''; continue; }
      const key = normId(id);
      if (seen.has(key)) continue;
      seen.add(key);
      let def = (typeof el === 'object' && el.name && el.team && el.ability) ? el : (lib[key] || builtin[key]);
      if (!def) { out.missing.push(id); continue; }
      const role = toRole(def);
      if (!CORE_TEAMS.includes(role.team)) { out.skipped.push(role.name); continue; }
      out.roles.push(role);
    }
    if (!out.roles.length) throw new Error('No usable characters found' + (out.missing.length ? ` (${out.missing.length} unknown ids — import a character library first)` : '') + '.');
    return out;
  }

  // Validates a character library: a JSON list (or id-keyed object) of full character definitions.
  function parseLibrary(json) {
    let data = json;
    if (typeof data === 'string') {
      try { data = JSON.parse(data); } catch { throw new Error('That is not valid JSON.'); }
    }
    const map = libraryMap(data);
    const list = Object.values(map);
    if (!list.length) throw new Error('No character definitions found (each needs at least "id" and "name").');
    return list;
  }

  async function fetchText(url) {
    let res;
    try { res = await fetch(url); } catch { throw new Error('Could not download it. The site may block this; download the JSON and use "Choose file" or paste it instead.'); }
    if (!res.ok) throw new Error('Download failed: HTTP ' + res.status);
    return res.text();
  }

  return { parse, parseLibrary, fetchText, normId, guessChoose };
})();
