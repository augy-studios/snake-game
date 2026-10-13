// Snake Game's rules: the whole game as a pure function of a seed, the
// settings, and a list of inputs, each stamped with the tick it lands on.
//
// The page plays by it, the replay player re-runs it, the host of a party
// game runs it for everybody, and the leaderboard API replays a submitted
// game through it to work the score out for itself. No DOM, no fetch, no
// storage, no clock, and no Math.random: the same inputs give the same game
// to the bit in every browser and in Node.
//
// A tick is one move of every snake. Its length in milliseconds comes from
// the difficulty and the level, so the game's time is the sum of its ticks
// and never the wall clock.

import { seededInts } from "./seed.js";

export const GRID = 40;
export const START_LENGTH = 3;
export const MAX_SNAKES = 4;

/* ---- Speed and levels ---- */

// Every FRUITS_PER_LEVEL fruits is a level. Speed and the level multiplier
// both stop growing at LEVEL_CAP, where the quickest difficulty is already
// at the floor; the level number itself keeps counting.
export const FRUITS_PER_LEVEL = 5;
export const MAX_START_LEVEL = 30;
export const LEVEL_CAP = 30;
export const MIN_TICK_MS = 45;
const SPEED_STEP = 0.965;

// Autoplay moves well beyond what a person could steer.
export const AUTOPLAY_TICK_SHARE = 0.4;
export const AUTOPLAY_MIN_TICK_MS = 20;

export const DIFFICULTIES = {
  easy: { label: "Easy", tickMs: 160, mult: 0.75 },
  normal: { label: "Normal", tickMs: 130, mult: 1 },
  hard: { label: "Hard", tickMs: 105, mult: 1.5 },
};

// Built by repeated multiplication rather than Math.pow, whose last bit can
// differ between JavaScript engines; plain multiplication cannot.
const TICK_TABLE = Object.fromEntries(
  Object.entries(DIFFICULTIES).map(([id, d]) => {
    const row = [];
    let ms = d.tickMs;
    for (let level = 0; level <= LEVEL_CAP; level += 1) {
      row.push(Math.max(MIN_TICK_MS, Math.round(ms)));
      ms *= SPEED_STEP;
    }
    return [id, row];
  })
);

export function tickMs(difficulty, level, autoplay = false) {
  const human = TICK_TABLE[difficulty][Math.min(level, LEVEL_CAP)];
  return autoplay ? Math.max(AUTOPLAY_MIN_TICK_MS, Math.round(human * AUTOPLAY_TICK_SHARE)) : human;
}

/* ---- Time limits ----
   Like MRT Station Guesser's: none, or a limit that scales the points. The
   game limit ends the game; the fruit timer, a limit per turn, moves a fruit
   nobody reached in time somewhere else, worth nothing. */

export const GAME_LIMITS = { 0: 1, 300: 1.1, 180: 1.25, 60: 1.5 };
export const FRUIT_LIMITS = { 0: 1, 15: 1.15, 10: 1.3, 5: 1.5 };

// Every fruit gives at least the time it takes to reach it by the shortest
// way at the current speed, plus this.
export const FRUIT_GRACE_MS = 1000;

/* ---- Points ---- */

export const BASE_POINTS = 10;
// A fruit reached in the fewest moves possible doubles; every move over that
// takes off a share, gone by QUICK_SLACK moves plus the shortest distance.
export const QUICK_SLACK = 10;

export function levelMultiplier(level) {
  return 1 + Math.min(level, LEVEL_CAP) * 0.1;
}

export function quickness(moves, par) {
  const extra = Math.max(0, moves - par);
  return 1 + Math.max(0, 1 - extra / (par + QUICK_SLACK));
}

export function fruitPoints({ difficulty, level, moves, par, gameSeconds, fruitSeconds }) {
  return Math.round(
    BASE_POINTS *
      DIFFICULTIES[difficulty].mult *
      levelMultiplier(level) *
      quickness(moves, par) *
      GAME_LIMITS[gameSeconds] *
      FRUIT_LIMITS[fruitSeconds]
  );
}

/* ---- Watchers' tools, in party games ---- */

export const WALL_LENGTH = 3;
export const WALL_MS = 6000;
export const MAX_WALLS = 12;
export const EXTRA_FRUIT_MS = 10000;
export const MAX_EXTRA_FRUITS = 8;
// Nothing a watcher drops lands this close to a head, or anywhere straight
// ahead that the snake would reach within SAFE_AHEAD_MS at its speed, so a
// wall can block a snake's way but never appear too late to turn from.
export const SAFE_DISTANCE = 3;
export const SAFE_AHEAD_MS = 1500;

/* ---- Directions and settings ---- */

// Up, right, down, left. Opposites are two apart.
export const DIRS = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];
export const DIR_NAMES = ["up", "right", "down", "left"];

export const MODES = ["solo", "coop", "versus"];

// Settings from anywhere (storage, a link, a request) made safe to play.
export function cleanSettings(raw = {}) {
  const level = Math.round(Number(raw.start_level));
  const game = Number(raw.game_seconds) || 0;
  const fruit = Number(raw.fruit_seconds) || 0;
  return {
    difficulty: DIFFICULTIES[raw.difficulty] ? raw.difficulty : "normal",
    start_level: Number.isFinite(level) ? Math.max(0, Math.min(MAX_START_LEVEL, level)) : 0,
    game_seconds: game in GAME_LIMITS ? game : 0,
    fruit_seconds: fruit in FRUIT_LIMITS ? fruit : 0,
  };
}

/* ---- The board ---- */

const wrap = (v, n) => ((v % n) + n) % n;

export function distance(grid, ax, ay, bx, by) {
  const dx = Math.abs(ax - bx);
  const dy = Math.abs(ay - by);
  return Math.min(dx, grid - dx) + Math.min(dy, grid - dy);
}

// Where each snake starts. Alone, in the middle and standing still until the
// first move; a party's lone snake moves off at once, since others are
// watching. More than one, near the corners, already moving round the board
// so no two meet head on at the start.
function starts(count, grid, party) {
  if (count === 1) return [{ x: grid >> 1, y: grid >> 1, dir: party ? 1 : -1 }];
  const lo = Math.round(grid * 0.2);
  const hi = grid - 1 - lo;
  return [
    { x: lo, y: lo, dir: 1 },
    { x: hi, y: hi, dir: 3 },
    { x: hi, y: lo, dir: 2 },
    { x: lo, y: hi, dir: 0 },
  ].slice(0, count);
}

/* ---- A game ----

   Events are arrays, the tick they land on first:
     [t, 0, snake, dir]   a snake turns (dir 0 to 3, DIRS)
     [t, 1, on]           autoplay on (1) or off (0); solo only
     [t, 2, x, y, h]      a watcher's wall, three cells from x,y, across if h
     [t, 3, x, y]         a watcher's extra fruit
   An event is applied when the game has made t moves, before move t + 1. */

export function newGame({ seed, mode = "solo", players = 1, settings, grid = GRID }) {
  const s = cleanSettings(settings);
  const count = Math.max(1, Math.min(MAX_SNAKES, players));
  const party = mode !== "solo";
  const state = {
    grid,
    seed: String(seed),
    mode: MODES.includes(mode) ? mode : "solo",
    settings: s,
    tick: 0,
    timeMs: 0,
    level: s.start_level,
    eaten: 0,
    started: party,
    autoplay: false,
    autoplayed: false,
    spawned: 0,
    snakes: starts(count, grid, party).map((p, i) => ({
      id: i,
      body: [[p.x, p.y]],
      dir: p.dir,
      moved: p.dir,
      grow: START_LENGTH - 1,
      alive: true,
      score: 0,
      fruits: 0,
      longest: 1,
      cause: null,
      diedAt: null,
    })),
    fruits: [],
    walls: [],
    missed: 0,
    over: false,
    reason: null,
    winner: null,
    // What happened on the last move, for captions: the inputs applied just
    // before it (gathered in `incoming`), then what the move itself did.
    happened: [],
    incoming: [],
  };
  for (let i = 0; i < count; i += 1) spawnFruit(state);
  return state;
}

export function currentTickMs(state) {
  return tickMs(state.settings.difficulty, state.level, state.autoplay);
}

export function teamScore(state) {
  return state.snakes.reduce((sum, s) => sum + s.score, 0);
}

// Which cell holds what: 0 empty, 1 + i snake i, -1 wall, -2 fruit.
function occupancy(state) {
  const { grid } = state;
  const cells = new Int8Array(grid * grid);
  for (const w of state.walls) for (const [x, y] of w.cells) cells[y * grid + x] = -1;
  for (const f of state.fruits) cells[f.y * grid + f.x] = -2;
  for (const s of state.snakes) {
    if (!s.alive) continue;
    for (const [x, y] of s.body) cells[y * grid + x] = 1 + s.id;
  }
  return cells;
}

function nearHead(state, x, y) {
  const { grid } = state;
  return state.snakes.some((s) => {
    if (!s.alive) return false;
    const [hx, hy] = s.body[0];
    if (distance(grid, hx, hy, x, y) <= SAFE_DISTANCE) return true;
    if (s.dir < 0) return false;
    const [dx, dy] = DIRS[s.dir];
    const ahead = Math.min(grid - 1, Math.ceil(SAFE_AHEAD_MS / currentTickMs(state)));
    for (let k = 1; k <= ahead; k += 1) {
      if (wrap(hx + dx * k, grid) === x && wrap(hy + dy * k, grid) === y) return true;
    }
    return false;
  });
}

function parFor(state, x, y) {
  return state.snakes.map((s) => (s.alive ? distance(state.grid, s.body[0][0], s.body[0][1], x, y) : 0));
}

function fruitLimitMs(state, par) {
  const seconds = state.settings.fruit_seconds;
  if (!seconds) return 0;
  const shortest = Math.min(...par.filter((p, i) => state.snakes[i].alive), state.grid);
  return Math.max(seconds * 1000, shortest * currentTickMs(state) + FRUIT_GRACE_MS);
}

function addFruit(state, x, y, extra) {
  const par = parFor(state, x, y);
  state.fruits.push({
    x,
    y,
    extra,
    bornTick: state.tick,
    bornMs: state.timeMs,
    par,
    limitMs: extra ? EXTRA_FRUIT_MS : fruitLimitMs(state, par),
  });
}

// A main fruit on a free cell. Each one draws from its own stream, keyed on
// the seed and its number, so the same seed deals the same places as long as
// they are free. Never on a head's doorstep, where it would be a free point.
function spawnFruit(state) {
  const { grid } = state;
  const n = state.spawned;
  state.spawned += 1;
  const next = seededInts(`${state.seed}/f/${n}`);
  const cells = occupancy(state);
  const free = (i) => cells[i] === 0 && !nearHead(state, i % grid, Math.floor(i / grid));
  let at = -1;
  for (let tries = 0; tries < 64 && at < 0; tries += 1) {
    const i = next(grid * grid);
    if (free(i)) at = i;
  }
  if (at < 0) {
    // A crowded board: the first free cell on from a random one, then any
    // empty one at all.
    const from = next(grid * grid);
    for (let k = 0; k < grid * grid && at < 0; k += 1) if (free((from + k) % (grid * grid))) at = (from + k) % (grid * grid);
    for (let k = 0; k < grid * grid && at < 0; k += 1) if (cells[k] === 0) at = k;
  }
  if (at >= 0) addFruit(state, at % grid, Math.floor(at / grid), false);
}

function wallCells(grid, x, y, h) {
  return Array.from({ length: WALL_LENGTH }, (_, k) => [wrap(x + (h ? k : 0), grid), wrap(y + (h ? 0 : k), grid)]);
}

// Whether a watcher could put a wall or a fruit there now. The host asks
// before sending, and applyEvent asks again, so a replay agrees.
export function canPlace(state, tool, x, y, h) {
  const { grid } = state;
  if (state.over || !Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= grid || y >= grid) return false;
  const cells = occupancy(state);
  if (tool === "wall") {
    if (state.walls.length >= MAX_WALLS) return false;
    return wallCells(grid, x, y, h).every(([cx, cy]) => cells[cy * grid + cx] === 0 && !nearHead(state, cx, cy));
  }
  if (tool === "fruit") {
    if (state.fruits.filter((f) => f.extra).length >= MAX_EXTRA_FRUITS) return false;
    return cells[y * grid + x] === 0 && !nearHead(state, x, y);
  }
  return false;
}

// Applies one event at the current tick. Returns whether it changed
// anything; an event that would not (a turn back on itself, a wall where
// there is no room) is ignored, the same way everywhere.
export function applyEvent(state, event) {
  if (state.over) return false;
  const [, code, a, b, c] = event;
  const note = (what) => state.incoming.push(what);

  if (code === 0) {
    const snake = state.snakes[a];
    if (!snake?.alive || !Number.isInteger(b) || b < 0 || b > 3) return false;
    if (b === snake.dir) return false;
    // Never straight back into the neck. Checked against the way it last
    // moved, so two quick presses within one tick cannot turn it round.
    if (snake.moved >= 0 && snake.body.length > 1 && (b + 2) % 4 === snake.moved) return false;
    snake.dir = b;
    state.started = true;
    note({ type: "turn", snake: a, dir: b });
    return true;
  }
  if (code === 1) {
    const on = a === 1;
    if (on === state.autoplay) return false;
    state.autoplay = on;
    if (on) state.autoplayed = true;
    note({ type: "autoplay", on });
    return true;
  }
  if (code === 2) {
    if (!canPlace(state, "wall", a, b, c === 1)) return false;
    state.walls.push({ cells: wallCells(state.grid, a, b, c === 1), untilMs: state.timeMs + WALL_MS });
    note({ type: "wall", x: a, y: b, h: c === 1 });
    return true;
  }
  if (code === 3) {
    if (!canPlace(state, "fruit", a, b)) return false;
    addFruit(state, a, b, true);
    note({ type: "drop", x: a, y: b });
    return true;
  }
  return false;
}

function kill(state, snake, cause) {
  snake.alive = false;
  snake.cause = cause;
  snake.diedAt = state.tick;
  // In a party the body clears, so the others get the room back. Alone it
  // stays, to show where it went wrong.
  if (state.snakes.length > 1) snake.body = [];
  state.happened.push({ type: "crash", snake: snake.id, cause });
}

// One move of every snake. Nothing moves before the first turn of a solo game.
export function step(state) {
  state.happened = state.incoming;
  state.incoming = [];
  if (state.over || !state.started) return;
  const { grid } = state;
  const ms = currentTickMs(state);
  const versus = state.mode === "versus" && state.snakes.length > 1;

  const cells = occupancy(state);
  const fruitAt = new Map(state.fruits.map((f) => [f.y * grid + f.x, f]));
  const moving = [];

  for (const s of state.snakes) {
    if (!s.alive || s.dir < 0) continue;
    const [hx, hy] = s.body[0];
    const [dx, dy] = DIRS[s.dir];
    const x = wrap(hx + dx, grid);
    const y = wrap(hy + dy, grid);
    const fruit = fruitAt.get(y * grid + x) ?? null;
    moving.push({ s, x, y, fruit, keepsTail: Boolean(fruit) || s.grow > 0 });
  }

  // A tail about to move on leaves its cell free for whoever moves into it.
  for (const m of moving) {
    if (m.keepsTail) continue;
    const [tx, ty] = m.s.body[m.s.body.length - 1];
    if (cells[ty * grid + tx] === 1 + m.s.id) cells[ty * grid + tx] = 0;
  }

  const dying = new Map();
  for (const m of moving) {
    const here = cells[m.y * grid + m.x];
    if (here === -1) dying.set(m.s, "wall");
    else if (here === 1 + m.s.id) dying.set(m.s, "self");
    else if (here > 0 && versus) dying.set(m.s, "snake");
  }
  if (versus) {
    for (const a of moving) {
      for (const b of moving) {
        if (a !== b && a.x === b.x && a.y === b.y) dying.set(a.s, "head");
      }
    }
  }

  const eaten = new Set();
  for (const m of moving) {
    if (dying.has(m.s)) continue;
    const s = m.s;
    s.body.unshift([m.x, m.y]);
    s.moved = s.dir;
    const fruit = m.fruit && !eaten.has(m.fruit) ? m.fruit : null;
    if (fruit) {
      eaten.add(fruit);
      s.grow += 1;
      const moves = state.tick + 1 - fruit.bornTick;
      const points = fruitPoints({
        difficulty: state.settings.difficulty,
        level: state.level,
        moves,
        par: fruit.par[s.id] || moves,
        gameSeconds: state.settings.game_seconds,
        fruitSeconds: state.settings.fruit_seconds,
      });
      s.score += points;
      s.fruits += 1;
      state.eaten += 1;
      state.happened.push({ type: "eat", snake: s.id, points, extra: fruit.extra, moves, par: fruit.par[s.id] });
    }
    if (s.grow > 0) s.grow -= 1;
    else s.body.pop();
    s.longest = Math.max(s.longest, s.body.length);
  }
  for (const [s, cause] of dying) kill(state, s, cause);

  state.tick += 1;
  state.timeMs += ms;

  const level = state.settings.start_level + Math.floor(state.eaten / FRUITS_PER_LEVEL);
  if (level !== state.level) {
    state.level = level;
    state.happened.push({ type: "level", level });
  }

  state.fruits = state.fruits.filter((f) => !eaten.has(f));
  state.walls = state.walls.filter((w) => w.untilMs > state.timeMs);
  // Fruit nobody reached in time: an extra one goes, a main one moves.
  state.fruits = state.fruits.filter((f) => {
    if (!f.limitMs || state.timeMs - f.bornMs < f.limitMs) return true;
    if (!f.extra) {
      state.missed += 1;
      state.happened.push({ type: "timeout" });
    }
    return false;
  });
  const mains = state.fruits.filter((f) => !f.extra).length;
  for (let k = mains; k < state.snakes.length; k += 1) spawnFruit(state);

  const alive = state.snakes.filter((s) => s.alive);
  const limit = state.settings.game_seconds * 1000;
  if (alive.length === 0) end(state, "crash");
  else if (versus && alive.length === 1) end(state, "last");
  else if (limit && state.timeMs >= limit) end(state, "time");
}

function end(state, reason) {
  state.over = true;
  state.reason = reason;
  if (state.mode === "versus" && state.snakes.length > 1) {
    // The last one alive. Out of time, or all out on the same move, the
    // highest score among those still in at the end; level scores draw.
    const alive = state.snakes.filter((s) => s.alive);
    const lastTick = Math.max(...state.snakes.map((s) => s.diedAt ?? -1));
    const pool = alive.length ? alive : state.snakes.filter((s) => s.diedAt === lastTick);
    const best = Math.max(...pool.map((s) => s.score));
    const top = pool.filter((s) => s.score === best);
    state.winner = top.length === 1 ? top[0].id : null;
  }
  state.happened.push({ type: "end", reason });
}

/* ---- Whole games ---- */

export const MAX_TICKS = 250000;
export const MAX_EVENTS = 60000;

// A leaderboard run can be submitted for this long after it started.
export const RUN_TTL_MS = 3 * 60 * 60 * 1000;
// Vercel's clock and Supabase's, and a slow request, all in one allowance.
export const CLOCK_SLACK_MS = 15000;

export function summary(state) {
  const lead = state.snakes[0];
  return {
    score: teamScore(state),
    fruits: state.snakes.reduce((n, s) => n + s.fruits, 0),
    length: lead.longest,
    level: state.level,
    durationMs: state.timeMs,
    ticks: state.tick,
    missed: state.missed,
    over: state.over,
    reason: state.reason,
    winner: state.winner,
    autoplayed: state.autoplayed,
    snakes: state.snakes.map((s) => ({ score: s.score, fruits: s.fruits, length: s.longest, cause: s.cause })),
  };
}

// The game a replay describes (js/replay-format.js), played through.
// `onTick(state)` runs after every move, for the replay player's keyframes.
// Returns the final state, or a reason it is not a game these rules could
// have played: events out of order, or a solo game that never started.
export function playThrough(replay, { onTick } = {}) {
  const state = newGame({
    seed: replay.seed,
    mode: replay.mode,
    players: replay.players.length,
    settings: replay.settings,
    grid: replay.grid,
  });
  const events = replay.events;
  let i = 0;
  while (!state.over && state.tick < replay.ticks) {
    while (i < events.length && events[i][0] === state.tick) applyEvent(state, events[i++]);
    if (i < events.length && events[i][0] < state.tick) return { error: "event_order" };
    if (!state.started) return { error: "never_started" };
    step(state);
    onTick?.(state);
  }
  if (i < events.length) return { error: "events_after_end", state };
  return { state };
}
