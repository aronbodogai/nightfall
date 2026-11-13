# Nightfall — local hidden-role game companion

A mobile-first web app for running a Blood on the Clocktower–style social deduction game
(hidden roles, a Storyteller, night actions, nominations and votes) across phones on one Wi-Fi network.

## Rules implemented (genre core)

- **Teams:** Good (Townsfolk + Outsiders) vs Evil (Minions + one Demon).
- **Setup by player count** (Townsfolk / Outsiders / Minions / Demon):

  | Players | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 |
  |---|---|---|---|---|---|---|---|---|---|---|---|
  | Townsfolk | 3 | 3 | 5 | 5 | 5 | 7 | 7 | 7 | 9 | 9 | 9 |
  | Outsiders | 0 | 1 | 0 | 1 | 2 | 0 | 1 | 2 | 0 | 1 | 2 |
  | Minions | 1 | 1 | 1 | 1 | 1 | 2 | 2 | 2 | 3 | 3 | 3 |
  | Demon | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 |

- **First night:** Minions learn who the Demon is; the Demon learns its Minions and 3 good
  characters not in play (bluffs). Roles then wake in night order.
- **Each later night:** roles wake in order; the Demon kills.
- **Day:** deaths are announced. Each living player may nominate once per day; each player may be
  nominated once per day. Dead players cannot nominate.
- **Voting:** living players vote freely; each dead player has one ghost vote for the rest of the game.
  A nominee goes on the block when votes ≥ half the living players (rounded up) and the count beats the
  current block. A tie with the current block clears it (nobody is executed on a tie).
- **Execution:** at most one per day, at the end of the day, of whoever is on the block.
- **Win:** Good wins when the Demon dies. Evil wins when only 2 players are alive.
- The Storyteller (host) may override anything: kill/revive, change roles, give false info to
  malfunctioning players.

## Characters

The official game's characters, names and ability texts belong to The Pandemonium Institute, so this
app ships an **original character set** ("Nightfall") with the same team structure and similar
mechanics. Characters live in `public/roles.js` and can be replaced or extended.

## Networking — viability

| Option | Verdict |
|---|---|
| Browser ↔ browser over **Bluetooth** | **Not viable.** Web Bluetooth can only connect *to* a peripheral; a browser cannot advertise or run a GATT server, so two phones' browsers can't talk over Bluetooth. iOS Safari has no Web Bluetooth at all. |
| Browser hosts a server on Wi-Fi | **Not possible.** Browsers can't open listening sockets. |
| **Small Node server on the LAN** (laptop, or a phone running Termux) | **Supported.** Zero dependencies, serves the app and a WebSocket relay. Everyone opens `http://<host-ip>:3000`. |
| **Cloudflare Workers + Durable Objects** | **Supported (recommended).** Same protocol; one Durable Object per room relays WebSockets. Players only need internet, not the same Wi-Fi. |

Bluetooth fallback: a phone/laptop **Bluetooth PAN** or **Wi-Fi hotspot** puts devices on one IP
network, after which the same server URL works. No app change needed.

## Architecture

- `server.js` — static file server + hand-written WebSocket relay. Rooms keyed by 4-letter code.
  The server never computes game logic; it routes messages and caches the host's last state snapshot
  and each player's last view, so refreshes and reconnects recover.
- **Host (`/host.html`)** — holds the authoritative game state, runs setup, grimoire, night order,
  day/nominations/voting, win checks. After every change it builds a *private view per player*
  and sends only that to each player (players never receive other players' roles).
- **Player (`/`)** — joins with name + room code, sees own role (hold-to-reveal), evil team info,
  night prompts (pick players), nominations, voting, and private messages from the Storyteller.
