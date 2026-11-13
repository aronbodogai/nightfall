// Nightfall character set (original). Replace or extend freely.
// team: townsfolk | outsider | minion | demon
// first / other: when the character wakes. `order` = position in the night. `choose` = players to pick.
// `effect`: what the app does with the choice at dawn (kill | protect | curse). `info`: suggestion helper key.
window.ROLES = [
  // ---------- Townsfolk ----------
  { id: 'archivist', name: 'Archivist', team: 'townsfolk', icon: '📜',
    ability: 'On the first night, you learn one character that is in play and one that is not.',
    first: { order: 40, info: 'archivist' } },
  { id: 'twin', name: 'Twin', team: 'townsfolk', icon: '🪞',
    ability: 'On the first night, you learn one other player who is good.',
    first: { order: 41, info: 'twin' } },
  { id: 'censustaker', name: 'Census Taker', team: 'townsfolk', icon: '🧮',
    ability: 'On the first night, you learn how many evil players sit among the 3 players to your left.',
    first: { order: 42, info: 'census' } },
  { id: 'cartographer', name: 'Cartographer', team: 'townsfolk', icon: '🗺️',
    ability: 'Each night, choose a player: you learn how many of their living neighbours are evil.',
    first: { order: 43, choose: 1, info: 'cartographer' }, other: { order: 60, choose: 1, info: 'cartographer' } },
  { id: 'oracle', name: 'Oracle', team: 'townsfolk', icon: '🔮',
    ability: 'Each night, choose 2 players: you learn whether either of them is a Minion.',
    first: { order: 44, choose: 2, info: 'oracle' }, other: { order: 61, choose: 2, info: 'oracle' } },
  { id: 'herbalist', name: 'Herbalist', team: 'townsfolk', icon: '🌿',
    ability: 'Each night except the first, choose another player: the Demon cannot kill them tonight.',
    other: { order: 20, choose: 1, notSelf: true, effect: 'protect' } },
  { id: 'tracker', name: 'Tracker', team: 'townsfolk', icon: '👣',
    ability: 'Each night except the first, choose a player: you learn which player they chose tonight, if any.',
    other: { order: 62, choose: 1, info: 'tracker' } },
  { id: 'gravedigger', name: 'Gravedigger', team: 'townsfolk', icon: '⚰️',
    ability: 'Each night except the first, you learn the alignment of the player executed today.',
    other: { order: 63, info: 'gravedigger' } },
  { id: 'witness', name: 'Witness', team: 'townsfolk', icon: '👁️',
    ability: 'When you die, you learn one player who is evil.' },
  { id: 'sentinel', name: 'Sentinel', team: 'townsfolk', icon: '🛡️',
    ability: 'The first time the Demon chooses you, nobody dies that night.' },
  { id: 'duelist', name: 'Duelist', team: 'townsfolk', icon: '⚔️', dayAbility: true,
    ability: 'Once per game, during the day, publicly challenge a player: if they are a Minion, they die.' },
  { id: 'magistrate', name: 'Magistrate', team: 'townsfolk', icon: '⚖️',
    ability: 'Your vote counts as two votes.' },

  // ---------- Outsiders ----------
  { id: 'sleepwalker', name: 'Sleepwalker', team: 'outsider', icon: '💤',
    ability: 'You believe you are a Townsfolk, but your ability does not work and your information may be false.' },
  { id: 'hothead', name: 'Hothead', team: 'outsider', icon: '🔥',
    ability: 'If you nominate a good player, you die immediately.' },
  { id: 'lucky', name: 'Lucky One', team: 'outsider', icon: '🍀',
    ability: 'The first time you would die, you do not. (You do not learn when this happens.)' },
  { id: 'debtor', name: 'Debtor', team: 'outsider', icon: '🪙',
    ability: 'If you are executed, the Demon may kill twice tonight.' },

  // ---------- Minions ----------
  { id: 'hexer', name: 'Hexer', team: 'minion', icon: '🕸️',
    ability: "Each night, choose a player: their ability malfunctions tonight and tomorrow.",
    first: { order: 10, choose: 1, effect: 'curse' }, other: { order: 10, choose: 1, effect: 'curse' } },
  { id: 'whisperer', name: 'Whisperer', team: 'minion', icon: '🗝️',
    ability: 'Each night, choose a player: you learn their character.',
    first: { order: 30, choose: 1, info: 'whisperer' }, other: { order: 40, choose: 1, info: 'whisperer' } },
  { id: 'mimic', name: 'Mimic', team: 'minion', icon: '🎭',
    ability: 'You may register as good and as a Townsfolk to other abilities.' },
  { id: 'heir', name: 'Heir', team: 'minion', icon: '👑',
    ability: 'If the Demon dies while 5 or more players are alive, you become the Demon.' },

  // ---------- Demons ----------
  { id: 'shade', name: 'Shade', team: 'demon', icon: '🌑',
    ability: 'Each night except the first, choose a player: they die.',
    other: { order: 30, choose: 1, effect: 'kill' } },
  { id: 'hollow', name: 'Hollow', team: 'demon', icon: '🕳️',
    ability: 'Each night except the first, choose a player: they die. Once per game, you may choose 2 players instead.',
    other: { order: 30, choose: 1, upTo: 2, effect: 'kill' } },
];

window.BASE_ROLES = window.ROLES;
window.ROLE = Object.fromEntries(window.ROLES.map(r => [r.id, r]));
// Swap the active character list (e.g. after importing a script). Mutates in place so references stay valid.
window.setRoles = (list) => {
  window.ROLES = list;
  window.ROLE = Object.fromEntries(list.map(r => [r.id, r]));
};
window.TEAM_ICON = { townsfolk: '🏠', outsider: '🌀', minion: '🗡️', demon: '😈' };
window.TEAM_LABEL = { townsfolk: 'Townsfolk', outsider: 'Outsider', minion: 'Minion', demon: 'Demon' };
window.isEvilTeam = (team) => team === 'minion' || team === 'demon';

// Setup counts by player count: [townsfolk, outsiders, minions, demons]
window.SETUP = {
  5: [3, 0, 1, 1], 6: [3, 1, 1, 1], 7: [5, 0, 1, 1], 8: [5, 1, 1, 1], 9: [5, 2, 1, 1],
  10: [7, 0, 2, 1], 11: [7, 1, 2, 1], 12: [7, 2, 2, 1], 13: [9, 0, 3, 1], 14: [9, 1, 3, 1], 15: [9, 2, 3, 1],
};
window.setupFor = (n) => window.SETUP[Math.min(15, Math.max(5, n))];
