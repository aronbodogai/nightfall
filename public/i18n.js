// Nightfall i18n. English source strings are the keys; other languages map them to translations.
// System messages travel between devices as { k, v } so each phone renders them in its own language.
// Free text typed by the Storyteller and characters from imported scripts are shown as-is.
'use strict';

window.LANGS = { en: 'English', hu: 'Magyar' };
window.LANG = (() => {
  const saved = store.get('nf_lang');
  if (saved && LANGS[saved]) return saved;
  return /^hu\b/i.test(navigator.language || '') ? 'hu' : 'en';
})();

window.I18N = { hu: {} };     // filled in i18n-hu.js
window.ROLE_I18N = { hu: {} }; // built-in character names/abilities by id, filled in i18n-hu.js

// Translate a key and fill {placeholders}.
window.t = (key, vars) => {
  let s = (LANG !== 'en' && I18N[LANG] && I18N[LANG][key]) || key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? fmtVar(vars[k]) : m));
  return s;
};
// A translatable message: rendered later, on each device, in that device's language.
window.L = (k, v) => ({ k, v });
// Render a message: plain string, { k, v } message, or an array of parts.
window.tx = (m) => {
  if (m == null) return '';
  if (typeof m === 'string') return m;
  if (Array.isArray(m)) return m.map(tx).join('');
  if (m.k) return t(m.k, m.v);
  return String(m);
};
function fmtVar(v) {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map(fmtVar).join(', ');
  if (typeof v === 'object') {
    if (v.$role) return roleName(v.$role, v.n, v.i);
    if (v.$ab) return roleAbility(v.$ab, v.n, v.i);
    if (v.$team) return teamLabel(v.$team);
    if (v.k) return t(v.k, v.v);
  }
  return String(v);
}
window.fmtVar = fmtVar;

// Character references usable inside message vars.
window.R = (r) => (r ? { $role: r.id, n: r.name, i: !!r.imported } : '');
window.RA = (r) => (r ? { $ab: r.id, n: r.ability, i: !!r.imported } : '');

const baseById = () => window._baseById || (window._baseById = Object.fromEntries(BASE_ROLES.map(r => [r.id, r])));
function builtinText(id, field, fallback, imported) {
  if (imported) return fallback;
  const b = baseById()[id];
  if (!b) return fallback;
  const tr = ROLE_I18N[LANG] && ROLE_I18N[LANG][id];
  if (tr && tr[field]) return tr[field];
  return (b._en && b._en[field]) || b[field] || fallback;
}
window.roleName = (id, fallback, imported) => builtinText(id, 'name', fallback, imported);
window.roleAbility = (id, fallback, imported) => builtinText(id, 'ability', fallback, imported);
// Localize a role object received from the host ({ id, name, ability, imported }).
window.locRole = (r) => (r ? Object.assign({}, r, { name: roleName(r.id, r.name, r.imported), ability: roleAbility(r.id, r.ability, r.imported) }) : r);

const TEAMS = { townsfolk: ['Townsfolk', 'Townsfolk'], outsider: ['Outsider', 'Outsiders'], minion: ['Minion', 'Minions'], demon: ['Demon', 'Demons'] };
window.teamLabel = (team, plural) => { const e = TEAMS[team]; return e ? t(e[plural ? 1 : 0] + (plural ? ' (plural)' : '')) : team; };

// Rewrite the built-in characters' visible text in place for the current language.
window.applyRoleLang = () => {
  for (const r of BASE_ROLES) {
    if (!r._en) r._en = { name: r.name, ability: r.ability };
    const tr = ROLE_I18N[LANG] && ROLE_I18N[LANG][r.id];
    r.name = (tr && tr.name) || r._en.name;
    r.ability = (tr && tr.ability) || r._en.ability;
  }
};

const langListeners = [];
window.onLangChange = (fn) => langListeners.push(fn);
window.setLang = (l) => {
  if (!LANGS[l]) return;
  window.LANG = l; store.set('nf_lang', l);
  document.documentElement.lang = l;
  applyRoleLang();
  langListeners.forEach(fn => fn());
};

// Language picker: <select> placed in the top bar.
window.mountLangPicker = (el) => {
  el.innerHTML = `<select id="langPick" aria-label="Language / Nyelv" title="Language / Nyelv" class="langpick">${Object.entries(LANGS)
    .map(([k, n]) => `<option value="${k}" ${k === LANG ? 'selected' : ''} label="${k.toUpperCase()}">${k.toUpperCase()} · ${n}</option>`).join('')}</select>`;
  const sel = el.querySelector('select');
  sel.addEventListener('change', (e) => setLang(e.target.value));
  onLangChange(() => { sel.value = LANG; });
};

document.documentElement.lang = LANG;
// applyRoleLang() runs at the end of the translation files, once their tables are loaded.
