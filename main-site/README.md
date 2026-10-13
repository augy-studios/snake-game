# main-site

What Vercel deploys, served at <https://snek.uwuapps.org>. No build step:
these files are served as they are, and `api/` holds the serverless
functions.

| Path | What it is |
|---|---|
| `index.html` | The game page. Its `<head>` is the template any other page copies. |
| `404.html`, `404.css` | Not-found page, still on the template's own styles. |
| `sw.js` | Service worker: the offline shell, and the update bar's waiting worker. |
| `manifest.json` | PWA manifest. |
| `api/` | The leaderboard and replay API, below. Vercel does not route `api/_lib/`. |
| `css/` | `theme.css` is the uwuapps theme system verbatim; `style.css` is this app's layout. |
| `js/` | ES modules, below. Every file must be in `PRECACHE` in `sw.js`. |
| `fonts/` | Jua, self-hosted, with its licence. |
| `images/` | Manifest screenshots. |

## js

The first five are pure, with no DOM, and the API imports them, so the page
and the server always agree on a game.

| File | What it does |
|---|---|
| `rules.js` | The game: board, speeds, levels, points, timers, party rules, and playing a whole game through. |
| `seed.js` | Seeds, and the integer random numbers fruit placement draws from. |
| `replay-format.js` | The replay format, checking it, and packing it into a link. |
| `bot.js` | Autoplay's steering. |
| `replay.js` | Plays a replay back, with keyframes for stepping back and seeking. |
| `game.js` | The game screen: pre-game, play, input, pause, game over, submit, sharing, replays. |
| `render.js` | Draws the board on the canvas, in the theme's colours. |
| `party.js`, `p2p.js` | Party games, and pairing over PeerJS with STUN only. |
| `qr.js` | QR encoder for the join link, from uwuPromptr, so it works offline. |
| `api.js`, `leaderboard.js`, `settings.js` | The API client, and the leaderboard and settings windows, after MRT Station Guesser's. |
| `theme.js`, `icons.js`, `ui.js`, `update-bar.js`, `app.js` | Theme, inline SVG icons, modal and storage helpers, the update bar, and boot. |

## The game

**The board** is 40 by 40, and every edge wraps: the snake leaves one side
and comes back on the other. The only way out is into a snake or a wall. The
board takes as much of the screen as it can, clear of the stats top left and
the tray on the right.

**The pre-game screen** picks the start level (0 by default, 10, 20, 30 or any
whole number up to 30) and, optionally, a seed. Higher levels move faster and
score more. Difficulty and time limits are in Settings and shown on the screen.
It has a picker for editions, hidden while there is only one: add an entry to
`EDITIONS` in `js/game.js` and it appears.

**Controls:** arrow keys or WASD steer, `Space` pauses, `F1` restarts. On a
touch screen, swipe on the board, as many turns as fit in one touch, or tap
towards an edge: the board is cut into four by its diagonals, so the whole
of each side is a target. The game area takes every touch, so nothing
scrolls, zooms or pulls to refresh. Two turns in one move are queued, and
the snake can never turn straight back into itself.

**Autoplay**, on and off with `F2`, or three quick taps on the game's name on
a touch screen. Not mentioned anywhere on screen. It steers at well over
twice the speed a person could. A game it touched cannot go on the
leaderboard; the mark is on the game, so the next one is clean.

**Levels and points.** A level every 5 fruits, after the start level. Each
level is about 3.5% quicker, to a floor at level 30. A fruit is worth 10
points, times:

| | Multiplier |
|---|---|
| Difficulty | Easy × 0.75, Normal × 1, Hard × 1.5 |
| Level | × 1 at level 0, a tenth more per level, × 4 at 30 |
| How quickly you reached it | × 2 by the shortest way, less with every extra move, × 1 at the shortest way plus 10 plus as many again |
| Game time limit | None × 1, 5 min × 1.1, 3 min × 1.25, 1 min × 1.5 |
| Fruit timer | None × 1, 15 s × 1.15, 10 s × 1.3, 5 s × 1.5 |

A game time limit ends the game when it runs out. A fruit timer moves a
fruit nobody reached in time, worth nothing; each fruit always gives at least
the time to reach it by the shortest way, plus a second.

**Seeds.** A seed decides where every fruit lands, so the same seed and the
same moves are always the same game. It shows on the pause and game over
panels with a Copy button; paste one into the pre-game screen to play it.
Any text is a seed.

**Game over:** score, level, length and time, the seed, and adding the game
to the leaderboard under a name, which is remembered in this browser. Two
boards: best score, and total points. A board's best game can be watched.

**Instant replay:** Watch replay plays the game back on the board, worked out
again from its turns. Play, pause, a move back or forward (`←` `→`), jump
to the start or end (`Home` `End`), or drag the timeline to anywhere, at 0.5×, 1×, 2× or 4× as Word Rain's replay does; the speed
picked last is remembered. A line says what just happened, and the timeline
has a tick at every fruit.

**Sharing a replay:** Share replay makes a link, through the device's share
sheet on a phone and the clipboard otherwise. Online it is short, `/r/<id>`,
stored by the API; a game already on the leaderboard has one from submitting,
marked as checked. Offline, or if storing fails, the whole game travels in a
longer link, `/?replay=...`, as chess-game shares replays. Opening one plays
it, with Play this seed to try the same fruit.

**Full screen:** the button at the foot of the tray, where the browser has
the Fullscreen API. Safari on iPhone does not, so there the button goes;
added to the home screen, the app is full screen already.

**Settings**, kept in this browser's local storage:

| Setting | Default | What it does |
|---|---|---|
| Leaderboard name | not set | Checked by `/api/leaderboard/name`; also saved by every successful submit. |
| Add finished games automatically | off | Submits every finished game under the saved name. Needs a name. |
| Difficulty | Normal | Speed and points, from the next game. |
| Game time limit | None | Ends the game when it runs out; scales the points. |
| Fruit timer | None | Moves a fruit not reached in time; scales the points. |

## Party games

The people button in the tray, or Play with others on the pre-game screen.
One device hosts and shows a six character code, a QR code and a link
(`/join?id=CODE`); up to seven more join with any of them. Up to four play,
and everyone else watches.

- **Together:** one shared score, snakes pass through each other, and the
  game ends when every snake is out.
- **Against each other:** snakes block each other, a head into another
  snake is out, two heads meeting are both out, and the last one in wins.
  Out of time, the highest score still in wins.
- **Watchers** tap or click the board to drop a three cell wall, across or
  down, which lasts six seconds, or an extra fruit. Each has a five second
  cooldown. Nothing lands within three cells of a head, or anywhere a snake
  would reach in the next second and a half.

The host's device runs the game with the host's difficulty and time limits,
and sends the board to everyone on every move. The devices talk directly
over WebRTC, set up through PeerJS's public broker with STUN only, as
`STUN-p2p-spec.md` describes, so they have to be on the same network, or one
on a hotspot from another. Guest wifi that isolates clients will not work. A
guest who reloads or drops gets their seat back with the same code. The host
pausing, or leaving the tab, pauses the game for everybody. Party games never
go on the leaderboard, since the host's device could have played them any
way it liked; they can be replayed and shared like any other.

**Privacy:** in a party game each device learns the others' public IP
addresses, as any peer to peer connection does, and PeerJS's broker sees peer
ids and IP addresses, never the game. The privacy policy should say so.

## Offline

The page, its scripts, the font and the icons are precached, so the game plays
with no connection. Only the leaderboard, short replay links and pairing need
the network. Nothing under `/api/` is ever cached, and neither is PeerJS,
which loads from cdnjs only when somebody hosts or joins. A game started
offline cannot be added to the leaderboard, since its run never started; one
that started online and finished offline keeps its Add button for when the
connection is back. `/join` and `/r/<id>` are rewrites to the game page, in
`vercel.json` and in the worker.

**Updates:** a new service worker installs and waits. The update bar at the
top of the page offers Reload or Not now, and nothing reloads until the
player asks. Bump `VERSION` in `sw.js` on every change to anything here.

**Smooth movement:** between moves each snake glides into the cell it is
heading for, drawn as one rounded body that runs off one edge and back on
the other. It runs ahead of the game rather than behind it, so it adds no
delay: a turn bends the head the moment it is pressed.

**Lag:** the board is redrawn only while something moves or animates, from a backdrop cached once per size and theme. Layout is worked
out on resize, not every frame. Autoplay's search reuses its buffers. Party
snapshots send bodies as flat coordinate lists. The canvas asks the browser
for low latency drawing.

## API

All JSON. `client_key` is a random id the browser keeps in local storage; a
run can only be submitted with the key that started it.

| Endpoint | Body | Returns |
|---|---|---|
| `POST /api/run/start` | `client_key` | `run_id, expires_in` |
| `POST /api/leaderboard/submit` | `run_id, client_key, name, game: { seed, settings, ticks, events }` | `name, score, fruits, length, level, duration_ms, best_score, rank, total, games, total_rank, replay_id` |
| `POST /api/leaderboard/name` | `name` | `name`, cleaned, or a `400` saying why not |
| `GET /api/leaderboard` | `?board=best` (default) or `total` | `board, entries`, cached 30 s |
| `POST /api/replay/create` | `replay` | `id`, for the link `/r/<id>` |
| `GET /api/replay` | `?id=<id>` | `id, kind, verified, created_at, replay`, cached a day |

Errors are `{ "error": code, "message"? }`: `400` bad input, `404` no such
run for this browser, `409` already submitted or seed already used, `410` run
older than three hours, `413` replay too large, `422` a game that does not
play through. The reason a game was refused goes to the logs, not the caller.
There is no login and there are no rate limits. `vercel.json` gives submit
and replay creation up to 60 seconds, since they play a whole game through.

## Environment variables (Vercel)

Documented in `.env.example`. `.vercelignore` keeps every env file out of
deployments, since anything in this directory would otherwise be served.

| Variable | Used for |
|---|---|
| `SUPABASE_URL` | The shared uwuapps project. |
| `SUPABASE_SERVICE_KEY` | Service role key. Server side only, never sent to a browser. |
