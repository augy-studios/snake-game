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
| `bot.js` | Autoplay's steering: a loop through every cell, with shortcuts that never pass its own tail, so it can fill the board. |
| `replay.js` | Plays a replay back, with keyframes for stepping back and seeking. |
| `game.js` | The game screen: pre-game, play, input, pause, game over, submit, sharing, replays. |
| `render.js` | Draws the board on the canvas, in the theme's colours. |
| `party.js`, `p2p.js` | Party games, and pairing over PeerJS with STUN only. |
| `qr.js` | QR encoder for the join link, from uwuPromptr, so it works offline. |
| `api.js`, `leaderboard.js`, `settings.js` | The API client, and the leaderboard and settings windows, after MRT Station Guesser's. |
| `theme.js`, `icons.js`, `ui.js`, `update-bar.js`, `app.js` | Theme, inline SVG icons, modal and storage helpers, the update bar, and boot. |
| `slither-rules.js` | Slither's world: whole-number movement and trigonometry, dots, boosting, collisions, the computer snakes, snapshots. Pure. |
| `slither-replay.js` | Slither's replay format, checking it, and playing one back. Pure; the API imports it. |
| `slither-skins.js` | The palette, patterns, outfits and ready-made skins, and skin codes. |
| `slither-render.js` | Draws a Slither world, in high or low quality. |
| `slither-game.js` | Slither on screen: steering, boosting, hosting and joining, host migration, dying, replays, the skin builder. |
| `slither-autoplay.js` | Autoplay's steering in Slither: plans headings ahead, cuts snakes off, seeks dead snakes' dots. Inputs only, never part of the world. |
| `wordfilter.js` | The word filter, shared by the leaderboard API and Slither's names. |

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
twice the speed a person could, and does not crash: it follows a loop through
every cell of the board, cutting across it towards the fruit but never past
its own tail, so it can fill the whole board. A game it touched cannot go on
the leaderboard; the mark is on the game, so the next one is clean.

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

## Slither

Pick Slither on the pre-game screen, set a skin and a name if you like, and
press Play. You land in a new round world, 5,200 pixels across, of glowing
dots and nineteen computer snakes, each named from `wordlist.json`: its words
of four to nine letters that pass the word filter, plus a stricter list of
words no snake should be called.

**Playing:** your snake heads for the pointer, or for your finger on a
touch screen; `←` `→` steer too. Hold the mouse button, `Space` or `↑`, or on
a touch screen the Boost button or a second finger, to go twice as fast;
boosting burns length, dropped behind as dots. Run into another snake's body
and you are out: your snake turns into a trail of big dots for everyone else.
The edge of the world only holds you in; you slide along it. So boost across in front of another snake and it
becomes yours to eat. The biggest five show top left with your length and
rank, and a minimap bottom right. A big snake is fatter, turns more slowly,
and sees further: the camera zooms out as it grows.

**Others joining:** the world is open to others from its first second. The
join code shows top left; tap it for the QR code and the link. Anyone on the
same network joins with Play with others, then Join and the code, or the
link or QR code, at any time, up to twelve of them. Each joiner takes a
computer snake's place, so a world holds about twenty snakes however many
people are in it. Everyone runs the world on their own device in step from
everyone's inputs, so only inputs travel, and a joiner who drops or reloads
gets their snake back; the computer steers it meanwhile. When the host
leaves, the first person to have joined carries on hosting the world under
the same code, and everyone else is moved over to them.

**Dying:** a panel with your length, kills, best rank and time, and Play
again, which drops a new snake into the same world. Watch replay plays your
life back with the same controls as Classic's, a quarter second a step;
Share replay stores it for a short `/r/<id>` link, online only, since it
carries the world it began in. The seed shows there too; paste it on the
pre-game screen for the same world, the same dots and computer snakes, for
as long as nobody else joins.

**The computer's snakes** go for the best food they can actually reach, and
never orbit a dot inside their own turning circle. Now and then one hunts a
nearby snake, boosting to cut across its head, or boosts for a rich dot.
And now and then one is careless and does not see a player's body, and may
run into it: big dots for whoever it hit.

**Autoplay:** `F2`, or three quick taps on the game's name on a touch
screen, as in Classic. It plays better than the computer's snakes: every
tick it tries a fan of headings forward under the snake's real turn rate,
against every body, the body each head lays down as it goes, and where each
head might turn to, and takes the one that stays clear, keeps the most room
and best serves its goal. The goal is a snake it has got ahead of, which it
cuts off by crossing in front of it at a slant, or else the richest pile of
dots near it, a dead snake's above all. It boosts only to cross in front of
a snake or to reach a dead snake's dots first. If it has still turned more
than a full circle in a second and a half, it goes straight for a while. A
life it touched does not count towards your best.
`node scripts/bench-autoplay.mjs` compares it with the computer's steering.

**Skins:** Skin and name, on the pre-game screen and the death panel. Pick a
ready-made one, or build your own from forty colours, some starred, up to
twelve in a row that repeat down the body; lay them in bands, stripes or
spots, and add an outfit: a crown, a party hat, a top hat, a bow, shades or
a halo. Everyone in the world sees it. **Graphics** are in Settings: high
quality has the glowing dots that pop in and get pulled into the mouth that
eats them, the light running down a boosting snake, shading and the floor
pattern; low quality draws flat shapes at the screen's plain pixel density,
for older phones.

**Pausing:** only while nobody else is in the world. Leaving the tab then
pauses it too.

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

**Smooth movement:** each cell of a snake is drawn from the edge it came in
by to the edge it leaves by, straight across or round a quarter circle, so
the body is one rounded path that curves at every turn and runs off one
edge and back on the other. Between moves the head crosses its own cell
along that path, its eyes turning with it, and the tail leaves its cell the
same way. The way out of the head's cell is the move being made, always
known in time (the turn queued next, autoplay's choice worked out as the
move starts, or a replay's), so the head curves into a turn rather than
running on and jumping across, and a turn bends it the moment it is pressed.

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
| `POST /api/replay/create` | `replay`, Classic's or Slither's | `id`, for the link `/r/<id>` |
| `GET /api/replay` | `?id=<id>` | `id, kind, verified, created_at, replay`, cached a day |

Slither replays need `migrations/002`, may be up to 1 MB, have every name
run through the leaderboard's word filter and every browser id dropped, and
are played through before they are stored.

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
