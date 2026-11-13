# Nightfall

A mobile-first companion for hidden-role social deduction games (Blood on the Clocktower style).
The Storyteller's device holds the game state; each player's phone only receives that player's own
private view.

It runs two ways, with the same front end:

| | Where | Players need |
|---|---|---|
| **Cloudflare Workers** (`src/worker.js`) | Public URL, e.g. `nightfall.example.com` | Internet |
| **LAN server** (`server.js`) | A laptop/phone on the local network | Same Wi-Fi or hotspot |

It is not a backend-less SPA: phones can't talk to each other directly, so a small relay forwards
messages between the Storyteller and players. On Workers that relay is one Durable Object per room
(WebSocket Hibernation, so idle rooms cost nothing; rooms expire after 24 h).

## Deploy to Cloudflare Workers

```bash
npm install
npx wrangler login
npm run deploy
```

That publishes to `https://nightfall.<your-subdomain>.workers.dev`. To use your own subdomain, the
parent domain must be a zone in the same Cloudflare account. Uncomment and edit in `wrangler.jsonc`:

```jsonc
"routes": [{ "pattern": "nightfall.example.com", "custom_domain": true }],
```

and run `npm run deploy` again. Cloudflare creates the DNS record and certificate automatically.

Local Workers dev server: `npm run dev` (http://localhost:8787).

## Run on a local network instead

Needs Node 18+, no dependencies:

```bash
node server.js
```

The server prints the Storyteller URL (`/host.html`) and the LAN URLs players open. With no router,
turn on a phone hotspot and run the server on a device joined to it. (Browsers can't talk to each other
over Bluetooth, see `PLAN.md`.)

## How a game flows

1. **Lobby**: the Storyteller opens `/host.html` and creates a room. Players open `/`, enter a name and
   the 4-letter code (the lobby shows a link with the code pre-filled). Reorder seats to match the real
   circle (clockwise).
2. **Characters**: pick characters (or 🎲 random) to match the recommended counts, then **Deal**.
   Players reveal their character by tapping the card.
3. **Night**: the app lists who wakes, in order. For each step, tap **Ask player to choose** to put a
   picker on their phone (or pick for them), read the suggested true answer, edit it if they are
   malfunctioning, and **Send info**. With 7+ players the first night sends Minion/Demon info and 3 bluffs.
4. **Dawn**: the app proposes deaths (respecting Herbalist, Sentinel, Lucky One, curses); toggle and
   start the day.
5. **Day**: players request nominations from their phone; open the vote; everyone votes on their
   phone (dead players spend their one ghost vote); close the vote; end the day to execute whoever is
   on the block. Win checks run automatically, and the end screen reveals every character.

The Grimoire tab lets the Storyteller override anything (character, alive, ghost vote, curse,
protection) and send private messages. Refreshing either page is safe: the host's state is saved on
its device, and players reconnect automatically.

## Languages

English and Hungarian, picked per device from the top bar (defaults to the browser language).
System messages and built-in characters are shown in each phone's own language; text the Storyteller
types and characters from imported scripts appear as written. Translations live in
`public/i18n-hu.js` (keys are the English strings); add a language by adding a file like it and an
entry in `LANGS` in `public/i18n.js`.

The lobby shows a QR code of the join link, generated locally
(`public/vendor/qrcode.js`, MIT, by Kazuhiko Arase), so it also works on a Wi-Fi without internet.

## Characters

An original set in `public/roles.js` (the official characters and texts are The Pandemonium
Institute's property). Add or change characters there: `first`/`other` set night order and how many
players they choose, `effect` (`kill`, `protect`, `curse`) is applied automatically, `info` enables an
answer helper.

See `PLAN.md` for the rules implemented.

## License

MIT
