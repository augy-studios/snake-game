# Snake Game

Classic Snake with edges that wrap around: leave the board on one side and
come back on the other. Grow long, climb the levels, and play with friends
on the same network. Plays offline, with a keyboard or by swiping on a phone.

Live at <https://snek.uwuapps.org>.

## What runs where

| Part | Runs on |
|---|---|
| `main-site/`, the PWA and its API (`main-site/api/`) | Vercel, root directory `main-site` |
| Database, `uwusnek_*` tables | The shared uwuapps Supabase project |
| Party games | The players' own devices, peer to peer over WebRTC, paired through PeerJS's public broker |

The game runs entirely in the browser and needs no server. The server is
for the leaderboard and short replay links: it starts a clock when a game
begins, plays a finished game through again to score it, and stores replays.

## Layout

```
README.md
migrations/      SQL to run in the Supabase SQL editor
scripts/         pre-deploy checks and the engine's tests
main-site/       the site Vercel deploys, including api/
```

The specs at the root are what this is built to:

| File | Covers |
|---|---|
| `uwuapps-theme.md`, `uwuapps-retrofit-time-mode.md` | The uwuapps theme system, with time-based mode |
| `update-bar-spec.md` | The update prompt bar |
| `edge-tray-spec.md` | The menu tray on the right edge |
| `STUN-p2p-spec.md` | Party games' peer to peer pairing, STUN only |

## First setup

1. Run every file in `migrations/`, in number order, in the Supabase SQL
   editor. Never edit a file once it has been run: every change is a new
   file with the next number.
2. On the Vercel project, set `SUPABASE_URL` and `SUPABASE_SERVICE_KEY`, from
   the Supabase dashboard's Data API settings. See `main-site/.env.example`.
3. Point `snek.uwuapps.org` at the Vercel project and deploy `main-site`.

## Before every deploy

1. Bump `VERSION` in `main-site/sw.js`. Without it, returning visitors keep
   the previous build and never see the update bar.
2. Run the checks:

```
node scripts/test-rules.mjs
node scripts/check-sw.mjs
node scripts/check-precache.mjs
node scripts/check-theme.mjs
```

`test-rules.mjs` plays games with the autoplay bot and checks that each one
replays to the same result, which is what the leaderboard and every replay
link depend on. Run it after any change to `js/rules.js`, `js/bot.js`,
`js/seed.js` or `js/replay-format.js`. A change to the rules also changes
how old replay links play back, so treat one as a new version of the game.

## Leaderboard integrity

A browser game cannot prove its score. What this one does instead: the whole
game is a pure function of its seed, its settings and its turns
(`main-site/js/rules.js`), so the page submits the turns, not the score.
The server plays them through the same module and scores the game itself,
then refuses:

- a game that did not end where it says, or has turns out of order
- a game autoplay touched, or with anything but the player's own turns
- a game longer, in game time, than the server has known about its run, which is
  what a page with its clock sped up produces
- a seed this name already has on the board at the same settings
- a second submission of the same run, one from another browser, or one
  more than three hours old

This bounds cheating; it does not prevent it. A cheat who writes a bot of
their own and plays at real speed gets through, as they would anywhere.
