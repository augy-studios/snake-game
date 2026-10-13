// Slither: a big round world of glowing dots, snakes steering towards a
// point rather than turning on a grid, boosting to cut each other off, and
// every snake that dies turning into a trail of bigger dots.
//
// Like js/rules.js, the whole world is a pure function of its seed and the
// inputs stamped with the tick they land on, the same to the bit in every
// browser. That is what lets everyone in a world run it side by side from
// the inputs alone, lets any of them carry on hosting it when the host
// leaves, and keeps a replay to a starting point and a list of inputs.
//
// So nothing here uses floating point where its last bit could differ
// between JavaScript engines: positions are whole numbers of sixteenths of
// a pixel, angles are whole numbers of 4096ths of a turn, sines come from a
// table built once with plain arithmetic, and the only square root is
// Math.sqrt on whole numbers, which IEEE 754 rounds the same way everywhere.

import { seededInts } from "./seed.js";

/* ---- Units ---- */

// Bump on any change to how the world plays: devices in one world must all
// run the same rules, and a joiner on other rules is told to reload.
export const RULES_VERSION = 2;

export const SUB = 16; // sub-units per pixel
export const TICK_MS = 32;
export const ANG = 4096; // a whole turn
const HALF = ANG / 2;
const QUARTER = ANG / 4;
const TRIG = 16384; // sines scaled to whole numbers

export const ARENA_R = 2600 * SUB;
export const MAX_SNAKES = 32;
export const BOT_FILL = 20;
export const MAX_HUMANS = 13;
export const FOOD_TARGET = 2600;
const FOOD_PER_TICK = 10;

export const START_MASS = 10;
export const BOOST_MIN_MASS = 20;
const BOOST_DROP_TICKS = 6;
export const SPEED = 88; // sub-units a tick: about 170 px a second
export const BOOST_SPEED = 180;
const MAX_SEGMENTS = 320;
export const CELL = 160 * SUB; // the collision grid's cell
const RESPAWN_BOT_TICKS = 12;

/* ---- Trigonometry in whole numbers ---- */

// sin(x) for x in [0, pi/2] by its Taylor series. Only + and *, which round
// identically everywhere, so every engine builds the same table.
function sinSeries(x) {
  const x2 = x * x;
  let term = x;
  let sum = x;
  for (let n = 1; n < 12; n += 1) {
    term = (-term * x2) / ((2 * n) * (2 * n + 1));
    sum += term;
  }
  return sum;
}

const SIN = new Int32Array(ANG);
for (let i = 0; i <= QUARTER; i += 1) {
  const v = Math.round(sinSeries((i * 3.141592653589793) / HALF) * TRIG);
  SIN[i] = v;
  SIN[HALF - i] = v;
  if (i > 0) SIN[ANG - i] = -v;
  SIN[(HALF + i) % ANG] = -v;
}

export const sinOf = (a) => SIN[a & (ANG - 1)];
export const cosOf = (a) => SIN[(a + QUARTER) & (ANG - 1)];

// atan over the first octant: for a ratio r in 0..1024 (opposite over
// adjacent, times 1024), the angle in 4096ths, from the table above.
const ATAN = new Int32Array(1025);
{
  let a = 0;
  for (let r = 0; r <= 1024; r += 1) {
    // The largest angle whose tangent is at most r / 1024.
    while (a < ANG / 8 && SIN[a + 1] * 1024 <= r * SIN[a + 1 + QUARTER]) a += 1;
    ATAN[r] = a;
  }
}

// The angle from the origin to (dx, dy), 0 along +x, turning towards +y.
export function iatan2(dy, dx) {
  if (dx === 0 && dy === 0) return 0;
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  const o = ax >= ay ? ATAN[Math.floor((ay * 1024) / ax)] : QUARTER - ATAN[Math.floor((ax * 1024) / ay)];
  if (dx >= 0) return dy >= 0 ? o : (ANG - o) & (ANG - 1);
  return dy >= 0 ? HALF - o : HALF + o;
}

// The shortest signed turn from a to b, in -2048..2047.
export const angleDiff = (a, b) => ((((b - a) % ANG) + ANG + HALF) % ANG) - HALF;

export function isqrt(n) {
  let s = Math.floor(Math.sqrt(n));
  while (s * s > n) s -= 1;
  while ((s + 1) * (s + 1) <= n) s += 1;
  return s;
}

/* ---- Sizes ---- */

// Radius in sub-units: about 9 px to start, 18 px at 500, 32 px at 3000.
export function radiusOf(mass) {
  return 128 + ((isqrt(mass * 256) * 7) >> 4);
}
export const spacingOf = (r) => (r * 9) >> 4;
export const segmentsFor = (mass) => Math.min(MAX_SEGMENTS, 10 + Math.floor(mass / 4));
// A big snake turns more slowly, in 4096ths of a turn per tick.
export const turnRateOf = (r) => Math.max(44, 150 - Math.floor((r * 3) / SUB));

/* ---- The world ----

   Events, each [tick, code, ...]:
     [t, 0, player, angle]                    steer towards an angle
     [t, 1, player, boost]                    boost on (1) or off (0)
     [t, 2, player, name, skin, browserId]    a player joins and spawns
     [t, 3, player]                           a player leaves: the computer takes their snake
     [t, 4, player]                           a player spawns again after dying
     [t, 5, player, on]                       autoplay on or off, for the record
     [t, 6, player, skin]                     a new skin
     [t, 7, player]                           a player is back, and takes their snake again */

export function newWorld(seed) {
  const world = {
    seed: String(seed),
    tick: 0,
    nextSnake: 1,
    nextDot: 1,
    foodSpawned: 0,
    snakes: [],
    dots: new Map(),
    players: {},
    happened: [],
    incoming: [],
  };
  buildDotGrid(world);
  // A world starts full: its dots, and its computer snakes.
  for (let i = 0; i < FOOD_TARGET; i += 1) spawnFood(world);
  for (let i = 0; i < BOT_FILL - 1; i += 1) spawnBot(world);
  return world;
}

const rngFor = (world, ...key) => seededInts(`${world.seed}/${key.join("/")}`);

/* -- Dots -- */

const cellKey = (x, y) => Math.floor(x / CELL) * 4096 + Math.floor(y / CELL);

function buildDotGrid(world) {
  world.dotGrid = new Map();
  for (const d of world.dots.values()) gridAdd(world, d);
}

function gridAdd(world, d) {
  const k = cellKey(d.x, d.y);
  let set = world.dotGrid.get(k);
  if (!set) world.dotGrid.set(k, (set = new Set()));
  set.add(d.id);
}

function addDot(world, x, y, value, color) {
  const d = { id: world.nextDot++, x, y, v: value, c: color };
  world.dots.set(d.id, d);
  gridAdd(world, d);
  return d;
}

function removeDot(world, d) {
  world.dots.delete(d.id);
  world.dotGrid.get(cellKey(d.x, d.y))?.delete(d.id);
}

// A random point inside the arena, at most `within` of its radius out.
function randomPoint(rng, within = 1) {
  for (;;) {
    const x = rng(2 * ARENA_R) - ARENA_R;
    const y = rng(2 * ARENA_R) - ARENA_R;
    const lim = Math.floor(ARENA_R * within) - 40 * SUB;
    if (x * x + y * y < lim * lim) return [x, y];
  }
}

function spawnFood(world) {
  const rng = rngFor(world, "f", world.foodSpawned++);
  const [x, y] = randomPoint(rng);
  const roll = rng(100);
  addDot(world, x, y, roll < 70 ? 1 : roll < 93 ? 2 : 3, rng(DOT_COLORS));
}
export const DOT_COLORS = 12;

/* -- Snakes -- */

// Names for the computer snakes, until the word list has loaded.
let BOT_NAMES = [
  "Noodle", "Wiggles", "Slinky", "Zigzag", "Pickle", "Doodle", "Squiggle", "Mango", "Biscuit", "Pretzel",
  "Ziggy", "Sprout", "Loop", "Twist", "Sunny", "Pebble", "Maple", "Comet", "Bubbles", "Tofu",
  "Kiwi", "Rascal", "Nugget", "Scoot", "Tango", "Jelly", "Ribbon", "Sprinkle", "Waffle", "Cosmo",
];

// The computer snakes' names from the word list (js/slither-game.js loads
// it). Names are only shown, never played by: the world plays the same
// whichever list a device has, so one still loading costs nothing but the
// names.
export function setBotNames(list) {
  if (Array.isArray(list) && list.length > 0) BOT_NAMES = list;
}

function spawnSnake(world, { player = -1, name, skin, rng }) {
  // Of a few places, the one furthest from any other head.
  let best = null;
  for (let i = 0; i < 8; i += 1) {
    const [x, y] = randomPoint(rng, 0.75);
    let near = Infinity;
    for (const s of world.snakes) {
      if (!s.alive) continue;
      const dx = s.xs[0] - x;
      const dy = s.ys[0] - y;
      near = Math.min(near, dx * dx + dy * dy);
    }
    if (!best || near > best.near) best = { x, y, near };
  }
  const angle = rng(ANG);
  const mass = START_MASS;
  const r = radiusOf(mass);
  const n = segmentsFor(mass);
  const sp = spacingOf(r);
  const xs = [];
  const ys = [];
  for (let i = 0; i < n; i += 1) {
    xs.push(best.x - ((cosOf(angle) * sp * i) >> 14));
    ys.push(best.y - ((sinOf(angle) * sp * i) >> 14));
  }
  const snake = {
    id: world.nextSnake++,
    player,
    name,
    skin,
    xs,
    ys,
    angle,
    target: angle,
    boost: false,
    mass,
    alive: true,
    born: world.tick,
    kills: 0,
    boostTicks: 0,
    brain: player < 0 ? newBrain(angle) : null,
    autopilot: player < 0,
    autoplay: false,
    cause: null,
    killer: null,
    bestRank: MAX_SNAKES,
  };
  world.snakes.push(snake);
  return snake;
}

function spawnBot(world) {
  const rng = rngFor(world, "bot", world.nextSnake);
  const name = BOT_NAMES[rng(BOT_NAMES.length)];
  const skin = botSkin(rng);
  return spawnSnake(world, { name, skin, rng });
}

// A skin code (js/slither-skins.js) for a computer snake: two or three
// colours, banded or striped.
function botSkin(rng) {
  const count = 1 + rng(3);
  const colors = Array.from({ length: count }, () => rng(40));
  return `${["b", "s", "b", "d"][rng(4)]}.none.${colors.join("-")}`;
}

/* -- Players -- */

function playerSnake(world, player) {
  const id = world.players[player]?.snake;
  return world.snakes.find((s) => s.id === id && s.alive) ?? null;
}

export function snakeOf(world, player) {
  return playerSnake(world, player);
}

/* ---- Events ---- */

export function applyEvent(world, e) {
  const [, code, p] = e;
  const note = (what) => world.incoming.push(what);
  if (!Number.isInteger(p) || p < 0 || p > 1e6) return false;
  const player = world.players[p];

  if (code === 0 || code === 1) {
    const s = player && playerSnake(world, p);
    if (!s || s.autopilot) return false;
    if (code === 0) s.target = e[3] & (ANG - 1);
    else s.boost = e[3] === 1;
    return true;
  }
  if (code === 2 || code === 4) {
    if (code === 2) {
      if (player) return false;
      world.players[p] = { name: String(e[3]).slice(0, 20), skin: String(e[4]).slice(0, 80), browser: String(e[5] ?? "").slice(0, 24), snake: 0, connected: true };
    } else if (!player || playerSnake(world, p)) {
      return false;
    }
    const pl = world.players[p];
    // The newcomer takes a computer snake's place, so the world stays at
    // about BOT_FILL snakes however many people are in it.
    trimBots(world, 1);
    const s = spawnSnake(world, { player: p, name: pl.name, skin: pl.skin, rng: rngFor(world, "spawn", p, world.tick) });
    s.autopilot = false;
    s.brain = null;
    pl.snake = s.id;
    note({ type: code === 2 ? "join" : "spawn", player: p, name: pl.name });
    return true;
  }
  if (code === 3) {
    if (!player) return false;
    player.connected = false;
    const s = playerSnake(world, p);
    if (s) {
      s.autopilot = true;
      s.boost = false;
      s.brain = newBrain(s.angle);
    }
    note({ type: "leave", player: p, name: player.name });
    return true;
  }
  if (code === 5) {
    const s = player && playerSnake(world, p);
    if (!s) return false;
    s.autoplay = e[3] === 1;
    if (s.autoplay) s.autoplayed = true;
    return true;
  }
  if (code === 6) {
    if (!player) return false;
    player.skin = String(e[3]).slice(0, 80);
    const s = playerSnake(world, p);
    if (s) s.skin = player.skin;
    return true;
  }
  if (code === 7) {
    if (!player) return false;
    player.connected = true;
    const s = playerSnake(world, p);
    if (s) {
      s.autopilot = false;
      s.brain = null;
    }
    note({ type: "back", player: p, name: player.name });
    return true;
  }
  return false;
}

// Takes `count` computer snakes out, the smallest first, leaving their dots.
function trimBots(world, count) {
  const alive = world.snakes.filter((s) => s.alive);
  let over = alive.length + count - BOT_FILL;
  if (over <= 0) return;
  const bots = alive.filter((s) => s.player < 0).sort((a, b) => a.mass - b.mass || a.id - b.id);
  for (const b of bots) {
    if (over <= 0) break;
    die(world, b, "gone", null);
    over -= 1;
  }
}

/* ---- The computer's steering ----
   Every computer snake, and the player's own on autoplay, thinks every few
   ticks: away from the edge, away from any body just ahead, otherwise
   towards the richest dots near it, boosting now and then for a big one. */

function dangerAhead(world, s, angle, reach, grid, careless = false) {
  const r = radiusOf(s.mass);
  for (let k = 1; k <= 4; k += 1) {
    const dist = r + ((reach * k) >> 2);
    const px = s.xs[0] + ((cosOf(angle) * dist) >> 14);
    const py = s.ys[0] + ((sinOf(angle) * dist) >> 14);
    if (px * px + py * py > (ARENA_R - r * 2) ** 2) return true;
    const hit = grid.near(px, py, s.id, r + 24 * SUB, careless);
    if (hit) return true;
  }
  return false;
}

// What a computer snake keeps in mind between thoughts: where it wanders,
// the dot it is after and until when, and a heading it is escaping on.
export function newBrain(angle) {
  return { think: 0, goal: angle, wander: angle, dot: 0, until: 0, escape: angle, escapeUntil: 0, home: 0, boostUntil: 0, hunt: 0, huntUntil: 0 };
}

// Where the rim begins, where a snake heading home counts as home again,
// and how far out food is still worth going for.
const RIM = ARENA_R - 450 * SUB;
const HOME = ARENA_R - 950 * SUB;
const FOOD_LIMIT = ARENA_R - 600 * SUB;

// How far round a snake's tightest turn reaches, in sub-units: anything
// inside the circle it turns on, either side, it can only orbit, never reach.
function turnRadius(r) {
  return Math.floor((SPEED * ANG * 1000) / (turnRateOf(r) * 6283));
}

// Whether a point is somewhere a snake can steer to from its heading now,
// rather than inside one of its turning circles.
function reachable(s, x, y, r) {
  const dx = x - s.xs[0];
  const dy = y - s.ys[0];
  const c = cosOf(s.angle);
  const sn = sinOf(s.angle);
  const f = Math.trunc((dx * c + dy * sn) / 16384);
  const l = Math.abs(Math.trunc((-dx * sn + dy * c) / 16384));
  const R = turnRadius(r);
  return f * f + (l - R) * (l - R) >= R * R;
}

function think(world, s, grid, sharp) {
  const b = s.brain ?? (s.brain = newBrain(s.angle));
  if (b.home === undefined) Object.assign(b, newBrain(s.angle), { wander: b.wander ?? s.angle });
  if (!sharp && (world.tick + s.id) % 4 !== 0) return;
  const rng = rngFor(world, "think", s.id, world.tick);
  const hx = s.xs[0];
  const hy = s.ys[0];
  const r = radiusOf(s.mass);
  const reach = (sharp ? 260 : 200) * SUB + r * 4;
  // Now and then a computer snake does not notice a player's snake in its
  // way, and may run into it: a gift of big dots. Never on autoplay's
  // sharp steering, which always looks.
  const careless = !sharp && rng(100) < 16;
  // A burst of boost lasts its time, unless something is in the way.
  s.boost = b.boostUntil > world.tick && s.mass > 30;

  // Near the rim: back towards the middle, and keep going until well
  // inside. Turning back the moment it crosses a line had snakes swinging
  // in and out across it, round and round.
  const fromCentre = isqrt(hx * hx + hy * hy);
  if (fromCentre > RIM) b.home = 1;
  else if (fromCentre < HOME) b.home = 0;
  if (b.home) {
    s.target = iatan2(-hy, -hx);
    s.boost = false;
    b.dot = 0;
    b.hunt = 0;
    return;
  }

  // Escaping: keep the heading picked, while it stays clear, rather than
  // picking a new one off the current heading every thought, which turns
  // a snake round and round.
  if (b.escapeUntil > world.tick && !dangerAhead(world, s, b.escape, reach, grid, careless)) {
    s.target = b.escape;
    s.boost = false;
    return;
  }

  // Something in the way: the nearest clear heading, trying first the side
  // it wanted to go anyway.
  const dot = b.dot ? world.dots.get(b.dot) : null;
  const wanted = dot ? iatan2(dot.y - hy, dot.x - hx) : b.wander;
  if (dangerAhead(world, s, s.angle, reach, grid, careless)) {
    s.boost = false;
    b.boostUntil = 0;
    b.hunt = 0;
    const side = angleDiff(s.angle, wanted) >= 0 ? 1 : -1;
    for (const step of [384, 768, 1152, 1536]) {
      for (const sign of [side, -side]) {
        const a = (s.angle + sign * step) & (ANG - 1);
        if (!dangerAhead(world, s, a, reach, grid, careless)) {
          b.escape = a;
          b.escapeUntil = world.tick + 16;
          s.target = a;
          b.dot = 0;
          return;
        }
      }
    }
    s.target = (s.angle + side * 1024) & (ANG - 1);
    return;
  }

  // Hunting, now and then: a snake whose head is near, cut off by getting
  // to a point ahead of it first, with a burst of boost.
  let prey = b.hunt && world.tick < b.huntUntil ? world.snakes.find((o) => o.id === b.hunt && o.alive) : null;
  if (!prey && s.mass > 40 && rng(100) < (sharp ? 40 : 12)) {
    let near = null;
    for (const o of world.snakes) {
      if (!o.alive || o === s) continue;
      const dx = o.xs[0] - hx;
      const dy = o.ys[0] - hy;
      const d2 = dx * dx + dy * dy;
      if (d2 < (360 * SUB) ** 2 && (!near || d2 < near.d2)) near = { o, d2 };
    }
    if (near) {
      prey = near.o;
      b.hunt = prey.id;
      b.huntUntil = world.tick + 48;
      b.boostUntil = world.tick + 24 + rng(16);
    }
  }
  if (prey) {
    const lead = 200 * SUB;
    const px = prey.xs[0] + ((cosOf(prey.angle) * lead) >> 14);
    const py = prey.ys[0] + ((sinOf(prey.angle) * lead) >> 14);
    const a = iatan2(py - hy, px - hx);
    if (px * px + py * py < FOOD_LIMIT * FOOD_LIMIT && reachable(s, px, py, r) && !dangerAhead(world, s, a, reach, grid, careless)) {
      s.target = a;
      s.boost = b.boostUntil > world.tick && s.mass > 30;
      return;
    }
    b.hunt = 0;
    b.boostUntil = 0;
    s.boost = false;
  }

  // Food: the dot it is after, while it is still there and reachable;
  // otherwise the best reachable one near enough, value over distance.
  let goal = dot && world.tick < b.until && reachable(s, dot.x, dot.y, r) ? dot : null;
  if (!goal) {
    let best = null;
    const look = (sharp ? 520 : 380) * SUB;
    const c0x = Math.floor((hx - look) / CELL);
    const c1x = Math.floor((hx + look) / CELL);
    const c0y = Math.floor((hy - look) / CELL);
    const c1y = Math.floor((hy + look) / CELL);
    for (let cx = c0x; cx <= c1x; cx += 1) {
      for (let cy = c0y; cy <= c1y; cy += 1) {
        const set = world.dotGrid.get(cx * 4096 + cy);
        if (!set) continue;
        for (const id of set) {
          const d = world.dots.get(id);
          const dx = d.x - hx;
          const dy = d.y - hy;
          const dist = isqrt(dx * dx + dy * dy);
          if (dist > look || !reachable(s, d.x, d.y, r)) continue;
          // Food by the rim would only lead back out to it.
          if (d.x * d.x + d.y * d.y > FOOD_LIMIT * FOOD_LIMIT) continue;
          const score = Math.floor((d.v * 1_000_000) / (dist + 400 * SUB));
          if (!best || score > best.score) best = { d, score };
        }
      }
    }
    goal = best?.d ?? null;
    b.dot = goal ? goal.id : 0;
    b.until = world.tick + 64;
  }
  if (goal) {
    const a = iatan2(goal.y - hy, goal.x - hx);
    if (!dangerAhead(world, s, a, reach, grid, careless)) {
      const dx = goal.x - hx;
      const dy = goal.y - hy;
      const dist = isqrt(dx * dx + dy * dy);
      s.target = a;
      // A rich dot a little way off is worth a burst, sometimes.
      if (!s.boost && s.mass > 35 && goal.v >= 3 && dist > 140 * SUB && rng(100) < (sharp ? 60 : 25)) {
        b.boostUntil = world.tick + 12 + rng(16);
        s.boost = true;
      }
      return;
    }
    b.dot = 0;
  }

  // Nothing worth it: wander, mostly straight on.
  if (rng(100) < 6) b.wander = (s.angle + rng(1024) - 512) & (ANG - 1);
  s.target = b.wander;
  s.boost = false;
}

// What autoplay would do for a player's snake this tick: the computer's
// steering, thinking every tick and looking further.
export function autoSteer(world, player) {
  const s = playerSnake(world, player);
  if (!s) return null;
  const grid = bodyGrid(world);
  // Thinking writes to the snake; put it all back, since this runs on one
  // device only and the world has to stay the same on all of them.
  const was = { target: s.target, boost: s.boost, brain: s.brain };
  s.brain = was.brain ? { ...was.brain } : null;
  think(world, s, grid, true);
  const out = { angle: s.target, boost: s.boost };
  s.target = was.target;
  s.boost = was.boost;
  s.brain = was.brain;
  return out;
}

/* ---- Bodies on a grid, for collisions and looking ahead ---- */

function bodyGrid(world) {
  const cells = new Map();
  for (const s of world.snakes) {
    if (!s.alive) continue;
    const r = radiusOf(s.mass);
    for (let i = 0; i < s.xs.length; i += 1) {
      const k = cellKey(s.xs[i], s.ys[i]);
      let list = cells.get(k);
      if (!list) cells.set(k, (list = []));
      list.push(s, i, r);
    }
  }
  return {
    // Whether any segment of a snake other than `self` is within `reach` of
    // (x, y), counting that segment's own radius. The snake it belongs to.
    near(x, y, self, reach, skipPlayers = false) {
      const cx = Math.floor(x / CELL);
      const cy = Math.floor(y / CELL);
      for (let ix = cx - 1; ix <= cx + 1; ix += 1) {
        for (let iy = cy - 1; iy <= cy + 1; iy += 1) {
          const list = cells.get(ix * 4096 + iy);
          if (!list) continue;
          for (let k = 0; k < list.length; k += 3) {
            const o = list[k];
            if (o.id === self) continue;
            if (skipPlayers && o.player >= 0 && !o.autopilot) continue;
            const i = list[k + 1];
            const lim = reach + list[k + 2];
            const dx = o.xs[i] - x;
            const dy = o.ys[i] - y;
            if (dx * dx + dy * dy < lim * lim) return o;
          }
        }
      }
      return null;
    },
  };
}

/* ---- Death ---- */

// A snake out turns into dots along its body, worth most of its mass.
function die(world, s, cause, killer) {
  s.alive = false;
  s.cause = cause;
  s.killer = killer?.id ?? null;
  s.diedAt = world.tick;
  if (killer) killer.kills += 1;
  const rng = rngFor(world, "die", s.id);
  const drops = Math.max(1, Math.floor(s.xs.length / 2));
  const share = Math.max(2, Math.floor((s.mass * 4) / 5 / drops));
  const color = Number(String(s.skin).split(".")[2]?.split("-")[0]) % DOT_COLORS || 0;
  for (let i = 0; i < s.xs.length; i += 2) {
    const jx = rng(16 * SUB) - 8 * SUB;
    const jy = rng(16 * SUB) - 8 * SUB;
    addDot(world, s.xs[i] + jx, s.ys[i] + jy, share, color);
  }
  world.incoming.push({ type: "death", snake: s.id, player: s.player, cause, killer: killer?.id ?? null, killerName: killer?.name ?? null, name: s.name });
}

/* ---- One tick ---- */

export function step(world) {
  world.happened = world.incoming;
  world.incoming = [];
  const grid = bodyGrid(world);

  // Steering: the computer's snakes think; everyone turns towards their target.
  for (const s of world.snakes) {
    if (!s.alive) continue;
    if (s.autopilot) think(world, s, grid, false);
    const r = radiusOf(s.mass);
    const diff = angleDiff(s.angle, s.target);
    const rate = turnRateOf(r);
    s.angle = (s.angle + Math.max(-rate, Math.min(rate, diff))) & (ANG - 1);
  }

  // Moving: the head goes forwards, and each segment follows the one before
  // at its spacing, like beads on a string.
  for (const s of world.snakes) {
    if (!s.alive) continue;
    const boosting = s.boost && s.mass >= BOOST_MIN_MASS;
    const speed = boosting ? BOOST_SPEED : SPEED;
    s.xs[0] += (cosOf(s.angle) * speed) >> 14;
    s.ys[0] += (sinOf(s.angle) * speed) >> 14;
    const r = radiusOf(s.mass);
    // The edge of the world holds a snake in: a head that would go past it
    // is put back just inside, so the snake slides along the edge.
    const lim = ARENA_R - r;
    const d2 = s.xs[0] * s.xs[0] + s.ys[0] * s.ys[0];
    if (d2 > lim * lim) {
      const d = isqrt(d2);
      s.xs[0] = Math.trunc((s.xs[0] * lim) / d);
      s.ys[0] = Math.trunc((s.ys[0] * lim) / d);
    }
    const sp = spacingOf(r);
    for (let i = 1; i < s.xs.length; i += 1) {
      const dx = s.xs[i - 1] - s.xs[i];
      const dy = s.ys[i - 1] - s.ys[i];
      const d2 = dx * dx + dy * dy;
      if (d2 <= sp * sp) continue;
      const d = isqrt(d2);
      s.xs[i] = s.xs[i - 1] - Math.trunc((dx * sp) / d);
      s.ys[i] = s.ys[i - 1] - Math.trunc((dy * sp) / d);
    }
    // Boosting burns mass, dropped behind as dots.
    s.boosting = boosting;
    if (boosting) {
      s.boostTicks += 1;
      if (s.boostTicks % BOOST_DROP_TICKS === 0) {
        s.mass -= 1;
        const t = s.xs.length - 1;
        addDot(world, s.xs[t], s.ys[t], 1, DOT_COLORS - 1);
      }
    }
  }

  // Eating: every dot within reach of a head.
  for (const s of world.snakes) {
    if (!s.alive) continue;
    const r = radiusOf(s.mass);
    const hx = s.xs[0];
    const hy = s.ys[0];
    const reach = r + 14 * SUB;
    const cx = Math.floor(hx / CELL);
    const cy = Math.floor(hy / CELL);
    let gained = 0;
    for (let ix = cx - 1; ix <= cx + 1; ix += 1) {
      for (let iy = cy - 1; iy <= cy + 1; iy += 1) {
        const set = world.dotGrid.get(ix * 4096 + iy);
        if (!set) continue;
        for (const id of [...set]) {
          const d = world.dots.get(id);
          const dx = d.x - hx;
          const dy = d.y - hy;
          if (dx * dx + dy * dy < reach * reach) {
            gained += d.v;
            removeDot(world, d);
          }
        }
      }
    }
    if (gained) {
      s.mass += gained;
      if (s.player >= 0) world.happened.push({ type: "eat", snake: s.id, player: s.player, gained });
    }
    // Growing or shrinking to the length its mass asks for.
    const want = segmentsFor(s.mass);
    while (s.xs.length < want) {
      s.xs.push(s.xs[s.xs.length - 1]);
      s.ys.push(s.ys[s.ys.length - 1]);
    }
    if (s.xs.length > want) {
      s.xs.length = want;
      s.ys.length = want;
    }
  }

  // Collisions, all decided before any is applied: a head into another
  // snake's body. The edge only holds snakes in.
  const after = bodyGrid(world);
  const dying = [];
  for (const s of world.snakes) {
    if (!s.alive) continue;
    const r = radiusOf(s.mass);
    const hx = s.xs[0];
    const hy = s.ys[0];
    const hit = after.near(hx, hy, s.id, (r * 5) >> 3);
    if (hit) dying.push([s, "snake", hit]);
  }
  for (const [s, cause, killer] of dying) die(world, s, cause, killer);
  world.happened.push(...world.incoming);
  world.incoming = [];

  // The dead are cleared away once their dots are down.
  world.snakes = world.snakes.filter((s) => s.alive || world.tick - s.diedAt < 2);

  // The world keeps itself topped up: dots, and computer snakes.
  for (let i = 0; i < FOOD_PER_TICK && world.dots.size < FOOD_TARGET; i += 1) spawnFood(world);
  if (world.tick % RESPAWN_BOT_TICKS === 0 && world.snakes.filter((s) => s.alive).length < BOT_FILL) spawnBot(world);

  world.tick += 1;
}

/* ---- Standings ---- */

export const lengthOf = (s) => s.mass;

export function standings(world) {
  return world.snakes.filter((s) => s.alive).sort((a, b) => b.mass - a.mass || a.id - b.id);
}

/* ---- Snapshots ----
   The whole world as plain JSON and back, exactly: whoever joins a world
   starts from one, and a replay of a life that began mid-world starts from
   one too. Map order is kept, since the order dots are checked in is part
   of the world. */

export function snapshot(world) {
  return {
    seed: world.seed,
    tick: world.tick,
    nextSnake: world.nextSnake,
    nextDot: world.nextDot,
    foodSpawned: world.foodSpawned,
    // Copies, not the world's own: a snapshot kept while the world goes on
    // (a replay's keyframes) must not change with it. Sharing these let a
    // later join or spawn reach back into an earlier keyframe, so playing
    // from it skipped the player's own spawn.
    players: structuredClone(world.players),
    snakes: world.snakes.map((s) => ({ ...s, xs: [...s.xs], ys: [...s.ys], brain: s.brain ? { ...s.brain } : null })),
    dots: [...world.dots.values()].map((d) => [d.id, d.x, d.y, d.v, d.c]),
    incoming: structuredClone(world.incoming),
  };
}

export function restore(snap) {
  const world = {
    seed: String(snap.seed),
    tick: snap.tick,
    nextSnake: snap.nextSnake,
    nextDot: snap.nextDot,
    foodSpawned: snap.foodSpawned,
    players: structuredClone(snap.players ?? {}),
    snakes: snap.snakes.map((s) => ({ ...s, xs: [...s.xs], ys: [...s.ys], brain: s.brain ? { ...s.brain } : null })),
    dots: new Map(snap.dots.map(([id, x, y, v, c]) => [id, { id, x, y, v, c }])),
    happened: [],
    incoming: [...(snap.incoming ?? [])],
  };
  buildDotGrid(world);
  return world;
}

// A short fingerprint of the world, to notice two copies drifting apart.
export function worldHash(world) {
  let h = 0x811c9dc5 ^ world.tick;
  const mixIn = (v) => {
    h = Math.imul(h ^ (v | 0), 16777619) >>> 0;
  };
  for (const s of world.snakes) {
    mixIn(s.id);
    mixIn(s.mass);
    mixIn(s.xs[0]);
    mixIn(s.ys[0]);
    mixIn(s.angle);
    mixIn(s.alive ? 1 : 0);
  }
  mixIn(world.dots.size);
  mixIn(world.nextDot);
  return h >>> 0;
}
