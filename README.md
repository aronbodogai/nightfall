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

### Rules implemented (official ruleset)

- Setup counts by player count; Travellers are outside the counts, and players beyond 15 must be Travellers.
- Minion info and Demon info (3 bluffs) on the first night only, and only with 7+ players.
- Nominations: Storyteller opens them; living players nominate once per day; each player can be
  nominated once per day; dead players can be nominated.
- Voting: at least half of the living players (rounded up) and more than any earlier nominee; a tie
  clears the block and later nominees must beat the tied count; dead players have one ghost vote
  (can be switched off as a house rule); at most one execution per day, and an execution that doesn't
  kill still counts.
- Travellers: chosen in the lobby or joining mid-game (the Storyteller seats them). Character public,
  alignment secret; an evil Traveller learns the Demon. **Exile**: any player may call it, it needs
  support from half of all players (dead included), spends no ghost votes, can happen any number of
  times per day (each Traveller once) and never uses up the execution.
- Win: good when the Demon dies; evil when only two non-Traveller players are alive.
- Drunk/poisoned, alignment changes, "thinks they are…" and reminder tokens in the grimoire.
- Fabled/Loric (shown to everyone when in play), bootlegger rules and jinxes from imported scripts.

The Grimoire tab lets the Storyteller override anything (character, alignment, alive, ghost vote,
drunk/poisoned, reminders) and send private messages. Refreshing either page is safe: the host's state is saved on
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

### Importing scripts and your own character data

**Characters → Import…** accepts scripts in the official Script Tool format: a JSON array with an
optional `_meta` object (`name`, `author`, `almanac`, `bootlegger`, `firstNight`/`otherNight` order)
and characters as plain ids, deprecated `{ "id": … }` objects, or full custom characters. Ids are
normalised (lowercase, letters and digits only) and `traveler` is read as `traveller`.

**Local copy of the official release**: `public/official/` mirrors The Pandemonium Institute's
toolmaker release (character list, night sheet, jinxes, character icons, edition logos, and the
community scripts with their logos and art; the printable PDFs are left out). The app reads this copy
first and falls back to release.botc.app, so it keeps working if that site changes or goes down, and on
a Wi-Fi without internet. Refresh it with `node scripts/sync-official.mjs`, which records the release
commit in `public/official/manifest.json`. These files are © The Pandemonium Institute and the script
authors, and are not covered by the MIT license; see `public/official/NOTICE.md`.

**Official scripts in one tap**: the import sheet has buttons for Trouble Brewing, Bad Moon Rising and
Sects & Violets, and a list of the community scripts in the official release. These download The
Pandemonium Institute's published toolmaker files from `release.botc.app` (character list, night sheet,
jinxes) at the moment you tap; nothing official is bundled in this repository. A script with jinxes
brings in the Djinn automatically. Characters from the official list show TPI's published icons
(good or evil version by alignment), loaded by each device from `release.botc.app`; custom characters
use the `image` URL from their script. Without internet the team emoji is shown instead. Blood on the Clocktower is © The Pandemonium Institute; this is
unofficial community content under their Community Created Content Policy.

The app ships no official character data. Scripts that list only ids need a **character library**
(the **Load official library** button fills it from the release, or load your own from a file, URL or
paste). It can hold three kinds of file, detected automatically:

- a character list (`id`, `name`, `team`, `ability`, `firstNight`, `otherNight`, `…Reminder`,
  `reminders`, `remindersGlobal`, `setup`, `jinxes`),
- a night sheet (`{ "firstNight": [...], "otherNight": [...] }`, with `dusk`/`minioninfo`/`demoninfo`/`dawn`),
- a jinx list (`[{ "id", "jinx": [{ "id", "reason" }] }]`, or the older `hatred` form).

Night order: the script's `_meta` order first, then the night sheet, then each character's own numbers.
When using The Pandemonium Institute's material, follow their Community Created Content Policy.

## License

MIT
