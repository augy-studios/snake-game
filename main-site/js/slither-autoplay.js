// Autoplay's steering in Slither: how the secret F2 player plays.
//
// It only ever produces inputs, an angle and whether to boost, which go
// into the world like anyone's; it is not part of the world itself. So
// unlike js/slither-rules.js it may use floating point freely, and it can
// look further and think harder than the computer snakes do.
//
// Every tick it:
//   1. picks a goal: a snake it has got ahead of and can cut off, or else
//      the richest pile of dots near it, a dead snake's above all, which it
//      sticks with until it is eaten
//   2. tries a fan of headings, each played forward under its real turn
//      rate for over a second, against every other snake's body, the body
//      each head will lay down as it goes, where each head might turn to,
//      and the edge of the world
//   3. takes the heading that stays clear, keeps the most room, eats the
//      most on the way and best serves the goal
//   4. boosts only when it pays: to cross in front of a snake it is cutting
//      off, or to reach a dead snake's dots first, and only if the faster
//      path is clear too
//
// Cutting off is the kill, and how it is done in slither.io: get ahead of
// another snake's head, then cross in front of it at a slant, so its head
// runs into this snake's body. Never head at a snake's face: meeting a
// head is how most snakes die.
//
// It never goes round in circles: food inside its own turning circle,
// which it could only orbit, is not a goal, a cut once begun keeps its
// side rather than flipping back across the other snake's line, and if it
// has still turned more than a full circle and a quarter in a second and a
// half, it goes straight for a while, wherever is clear.

import {
  ANG,
  ARENA_R,
  BOOST_SPEED,
  CELL,
  SPEED,
  SUB,
  radiusOf,
  segmentsFor,
  snakeOf,
  spacingOf,
  turnRateOf,
} from "./slither-rules.js";

const TAU = Math.PI * 2;
const PX = SUB; // sub-units per pixel, for reading distances
const HORIZON = 40; // ticks played forward to judge a heading, about 1.3 s
const BOOST_HORIZON = 30;
const FAN = 32; // headings tried, besides the goal's own
const MARGIN = 12 * PX; // room kept from anything solid
const ROOM = 34 * PX; // further than this from everything counts as open
const GRID = 96 * PX;
const CLUSTER = 100 * PX; // the cells dots are added up in
const RIM_FOOD = ARENA_R - 600 * PX; // food further out leads to the rim
const LOOP_TICKS = 48;
const LOOP_TURN = 1.25 * Math.PI * 2;
const STRAIGHT_TICKS = 30;
const CUT_SLANT = 1.05; // radians off the other snake's heading, crossing it
const CUT_TICKS = 22;
const MIN_HUNT_MASS = 45;
const MIN_BOOST_MASS = 45;
const RICH = 30; // a dead snake's dots, worth boosting for

const toRad = (a) => (a / ANG) * TAU;
const toAng = (rad) => ((Math.round((rad / TAU) * ANG) % ANG) + ANG) % ANG;
const wrapRad = (d) => ((((d + Math.PI) % TAU) + TAU) % TAU) - Math.PI;

// Other snakes' bodies on a fine grid, and their heads with where they are
// going, how fast, how sharply they can turn and how long a body follows.
function obstacles(world, me) {
  const cells = new Map();
  const heads = [];
  for (const s of world.snakes) {
    if (!s.alive || s === me) continue;
    const r = radiusOf(s.mass);
    for (let i = 0; i < s.xs.length; i += 1) {
      const k = Math.floor(s.xs[i] / GRID) * 8192 + Math.floor(s.ys[i] / GRID);
      let list = cells.get(k);
      if (!list) cells.set(k, (list = []));
      list.push(s.xs[i], s.ys[i], r);
    }
    const a = toRad(s.angle);
    heads.push({
      s,
      x: s.xs[0],
      y: s.ys[0],
      ux: Math.cos(a),
      uy: Math.sin(a),
      angle: a,
      speed: s.boosting ? BOOST_SPEED : SPEED,
      r,
      len: segmentsFor(s.mass) * spacingOf(r),
    });
  }
  return { cells, heads };
}

// How close the nearest body is to (x, y), less its radius, up to `cap`.
function bodyGap(obs, x, y, cap) {
  const cx = Math.floor(x / GRID);
  const cy = Math.floor(y / GRID);
  let best = cap;
  for (let ix = cx - 1; ix <= cx + 1; ix += 1) {
    for (let iy = cy - 1; iy <= cy + 1; iy += 1) {
      const list = obs.cells.get(ix * 8192 + iy);
      if (!list) continue;
      for (let k = 0; k < list.length; k += 3) {
        const dx = list[k] - x;
        const dy = list[k + 1] - y;
        const lim = best + list[k + 2];
        const d2 = dx * dx + dy * dy;
        if (d2 < lim * lim) best = Math.sqrt(d2) - list[k + 2];
      }
    }
  }
  return best;
}

// Distance from (x, y) to the segment from (ax, ay) to (bx, by).
function segDist(x, y, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const l2 = vx * vx + vy * vy;
  const t = l2 ? Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / l2)) : 0;
  return Math.hypot(ax + vx * t - x, ay + vy * t - y);
}

function foodAt(world, x, y, reach, seen) {
  let gained = 0;
  const cx = Math.floor(x / CELL);
  const cy = Math.floor(y / CELL);
  for (let ix = cx - 1; ix <= cx + 1; ix += 1) {
    for (let iy = cy - 1; iy <= cy + 1; iy += 1) {
      const set = world.dotGrid.get(ix * 4096 + iy);
      if (!set) continue;
      for (const id of set) {
        if (seen.has(id)) continue;
        const d = world.dots.get(id);
        const dx = d.x - x;
        const dy = d.y - y;
        if (dx * dx + dy * dy < reach * reach) {
          seen.add(id);
          gained += d.v;
        }
      }
    }
  }
  return gained;
}

// Plays a heading forward: when it would first hit something (Infinity if
// never within the horizon), how much room it keeps on the way, and how
// much food it passes through.
//
// Other snakes are not frozen while it looks ahead. Each head goes on the
// way it is going, laying its body down behind it, which is solid as soon
// as it is laid; and since it may turn, where it might be grows wider the
// further ahead it is.
function tryHeading(ctx, goal, speed, ticks) {
  const { me, obs, world, r, rate } = ctx;
  let x = me.xs[0];
  let y = me.ys[0];
  let a = toRad(me.angle);
  const seen = new Set();
  let food = 0;
  let cramped = 0;
  const edge = ARENA_R - r - MARGIN * 2;
  const reach = r * 0.7 + MARGIN;
  for (let k = 1; k <= ticks; k += 1) {
    a += Math.max(-rate, Math.min(rate, wrapRad(goal - a)));
    x += Math.cos(a) * speed;
    y += Math.sin(a) * speed;
    // The edge holds a snake in rather than killing it, so it only costs:
    // pinned against it, a snake is easy to cut off.
    if (x * x + y * y > edge * edge) return { hit: Infinity, rim: true, food, cramped };
    const gap = bodyGap(obs, x, y, reach + ROOM);
    if (gap < reach) return { hit: k, food, cramped };
    // Room matters most soon: a narrow gap now is the one that kills.
    if (k <= 24) cramped += (reach + ROOM - gap) / ROOM;
    const soon = Math.min(k, 14);
    for (const h of obs.heads) {
      const run = h.speed * k;
      const hx = h.x + h.ux * run;
      const hy = h.y + h.uy * run;
      // Where its head might be: meeting it head on is a loss either way.
      const spread = soon * h.speed * 0.45;
      const lim = r + h.r + MARGIN + spread;
      const dx = hx - x;
      const dy = hy - y;
      if (dx * dx + dy * dy < lim * lim) return { hit: k, food, cramped };
      // The body it lays down on the way there.
      const from = Math.max(0, run - h.len);
      if (segDist(x, y, h.x + h.ux * from, h.y + h.uy * from, hx, hy) < reach + h.r) return { hit: k, food, cramped };
    }
    if (k % 2 === 0) food += foodAt(world, x, y, r + 14 * PX, seen);
  }
  return { hit: Infinity, food, cramped };
}

/* ---- Goals ---- */

// A snake to cut off. Only one going the same way as this snake, never one
// coming at it, and only once this snake is ahead of its head: then cross
// in front of it at a slant, keeping to that side until done. Racing to
// get ahead was tried, and burned more length boosting than it won.
function huntGoal(ctx, memory) {
  const { me, obs, r, world, here } = ctx;
  if (me.mass < MIN_HUNT_MASS) {
    memory.cut = null;
    return null;
  }
  const mx = me.xs[0];
  const my = me.ys[0];

  // A cut already begun: keep crossing on the same slant, from the same
  // side, while the other snake is still there.
  const held = memory.cut;
  if (held && world.tick < held.until) {
    const h = obs.heads.find((o) => o.s.id === held.id);
    if (h) return { angle: h.angle + held.sign * CUT_SLANT, cutting: true, boost: held.boost, target: h };
  }
  memory.cut = null;

  const ux = Math.cos(here);
  const uy = Math.sin(here);
  let best = null;
  for (const h of obs.heads) {
    const dx = mx - h.x;
    const dy = my - h.y;
    const d = Math.hypot(dx, dy);
    if (d > 420 * PX) continue;
    // Going the same way, within 60 degrees.
    if (ux * h.ux + uy * h.uy < 0.5) continue;
    const along = dx * h.ux + dy * h.uy;
    const side = -dx * h.uy + dy * h.ux;
    if (Math.abs(side) > 150 * PX) continue;
    // Towards its line, from the side this snake is on.
    const sign = side > 0 ? -1 : 1;
    const worth = (h.s.mass + 30) / (d / PX + 200);
    // Ahead of it: cross now.
    if (along > r + h.r + 26 * PX && along < 240 * PX && (!best || worth > best.score)) {
      best = { score: worth, angle: h.angle + sign * CUT_SLANT, cutting: true, boost: along < 110 * PX || h.speed > SPEED, target: h, sign };
    }
  }
  if (best) memory.cut = { id: best.target.s.id, sign: best.sign, boost: best.boost, until: world.tick + CUT_TICKS };
  return best;
}

// Whether a point lies inside one of the snake's turning circles, where it
// could only go round it.
function orbitOnly(ctx, x, y) {
  const { me, rate } = ctx;
  const a = toRad(me.angle);
  const dx = x - me.xs[0];
  const dy = y - me.ys[0];
  const f = dx * Math.cos(a) + dy * Math.sin(a);
  const l = Math.abs(-dx * Math.sin(a) + dy * Math.cos(a));
  const R = SPEED / rate;
  return f * f + (l - R) * (l - R) < R * R;
}

// The richest pile of dots near enough: dots added up in cells, each cell
// counted with its neighbours, value against distance. A dead snake's dots
// (4 and up; food is 1 to 3) count four times over, so a pile of them is
// worth going a long way for, and a pile other heads are crowding round
// counts for less.
function clusterGoal(ctx, memory) {
  const { me, world, obs } = ctx;
  const mx = me.xs[0];
  const my = me.ys[0];

  // The pile it is already after, while enough of it is left.
  const held = memory.cluster;
  if (held && world.tick < held.until && !orbitOnly(ctx, held.x, held.y)) {
    const left = valueNear(world, held.x, held.y, CLUSTER * 1.5);
    if (left.v >= held.v * 0.35) {
      const dist = Math.hypot(held.x - mx, held.y - my);
      return { angle: Math.atan2(held.y - my, held.x - mx), rich: left.rich, dist };
    }
  }

  const look = 1300 * PX;
  const cells = new Map();
  const c0x = Math.floor((mx - look) / CELL);
  const c1x = Math.floor((mx + look) / CELL);
  const c0y = Math.floor((my - look) / CELL);
  const c1y = Math.floor((my + look) / CELL);
  for (let cx = c0x; cx <= c1x; cx += 1) {
    for (let cy = c0y; cy <= c1y; cy += 1) {
      const set = world.dotGrid.get(cx * 4096 + cy);
      if (!set) continue;
      for (const id of set) {
        const d = world.dots.get(id);
        if (Math.hypot(d.x - mx, d.y - my) > look || d.x * d.x + d.y * d.y > RIM_FOOD * RIM_FOOD) continue;
        const k = Math.floor(d.x / CLUSTER) * 65536 + Math.floor(d.y / CLUSTER);
        const c = cells.get(k) ?? { v: 0, x: 0, y: 0, rich: 0 };
        const w = d.v >= 4 ? d.v * 4 : d.v;
        c.v += w;
        c.x += d.x * w;
        c.y += d.y * w;
        if (d.v >= 4) c.rich += d.v;
        cells.set(k, c);
      }
    }
  }
  let best = null;
  for (const [k, c] of cells) {
    const kx = Math.floor(k / 65536);
    const ky = k - kx * 65536;
    let v = 0;
    let x = 0;
    let y = 0;
    let rich = 0;
    for (let ix = -1; ix <= 1; ix += 1) {
      for (let iy = -1; iy <= 1; iy += 1) {
        const n = cells.get((kx + ix) * 65536 + ky + iy);
        if (!n) continue;
        v += n.v;
        x += n.x;
        y += n.y;
        rich += n.rich;
      }
    }
    x /= v;
    y /= v;
    if (orbitOnly(ctx, x, y)) continue;
    const dist = Math.hypot(x - mx, y - my);
    let crowd = 0;
    for (const h of obs.heads) {
      if (Math.hypot(h.x - x, h.y - y) < 220 * PX) crowd += h.s.mass > me.mass ? 1 : 0.5;
    }
    const score = Math.pow(v, 1.5) / (dist / PX + 200) / (1 + crowd * 0.35);
    if (!best || score > best.score) best = { score, x, y, v, rich, dist };
  }
  if (!best) {
    memory.cluster = null;
    return null;
  }
  memory.cluster = { x: best.x, y: best.y, v: best.v, until: world.tick + 48 };
  return { angle: Math.atan2(best.y - my, best.x - mx), rich: best.rich, dist: best.dist };
}

// The value of the dots within `radius` of a point, counted as the pile
// counts it, and how much of it is a dead snake's.
function valueNear(world, x, y, radius) {
  let v = 0;
  let rich = 0;
  const cx = Math.floor(x / CELL);
  const cy = Math.floor(y / CELL);
  for (let ix = cx - 1; ix <= cx + 1; ix += 1) {
    for (let iy = cy - 1; iy <= cy + 1; iy += 1) {
      const set = world.dotGrid.get(ix * 4096 + iy);
      if (!set) continue;
      for (const id of set) {
        const d = world.dots.get(id);
        if (Math.hypot(d.x - x, d.y - y) >= radius) continue;
        v += d.v >= 4 ? d.v * 4 : d.v;
        if (d.v >= 4) rich += d.v;
      }
    }
  }
  return { v, rich };
}

/* ---- Choosing ---- */

const cache = new WeakMap();
// What autoplay remembers between ticks, per world and player: the pile it
// is after, the cut it is making, its recent headings, and how long to keep
// going straight.
const memories = new WeakMap();

function memoryOf(world, player) {
  let byPlayer = memories.get(world);
  if (!byPlayer) memories.set(world, (byPlayer = new Map()));
  let m = byPlayer.get(player);
  if (!m) byPlayer.set(player, (m = { cluster: null, cut: null, turns: [], last: null, straightUntil: 0 }));
  return m;
}

export function planAutoplay(world, player) {
  const me = snakeOf(world, player);
  if (!me) return null;
  const memo = cache.get(world);
  if (memo && memo.tick === world.tick && memo.player === player) return memo.plan;

  const r = radiusOf(me.mass);
  const here = toRad(me.angle);
  const ctx = { world, me, r, here, rate: toRad(turnRateOf(r)), obs: obstacles(world, me) };
  const memory = memoryOf(world, player);

  // How far it has turned lately. A full circle and a quarter in a second
  // and a half is going round in circles: straight on for a while.
  if (memory.last !== null) memory.turns.push(wrapRad(here - memory.last));
  memory.last = here;
  if (memory.turns.length > LOOP_TICKS) memory.turns.shift();
  const turned = Math.abs(memory.turns.reduce((a, b) => a + b, 0));
  if (turned > LOOP_TURN) {
    memory.straightUntil = world.tick + STRAIGHT_TICKS;
    memory.turns.length = 0;
    memory.cluster = null;
    memory.cut = null;
  }
  const straight = world.tick < memory.straightUntil;

  const hunt = straight ? null : huntGoal(ctx, memory);
  const food = hunt || straight ? null : clusterGoal(ctx, memory);
  const goal = hunt ? hunt.angle : food ? food.angle : here;

  // The fan: every direction, plus the goal and either side of it.
  const tries = [goal, goal + 0.2, goal - 0.2, here];
  for (let i = 0; i < FAN; i += 1) tries.push((i / FAN) * TAU);

  let best = null;
  for (const t of tries) {
    const run = tryHeading(ctx, t, SPEED, HORIZON);
    const safe = run.hit === Infinity;
    const score =
      (safe ? 100_000 : run.hit * 1_000) -
      (run.rim ? 30_000 : 0) -
      run.cramped * 120 +
      Math.cos(wrapRad(t - goal)) * (hunt ? 900 : 400) +
      run.food * 25 -
      Math.abs(wrapRad(t - here)) * 40;
    if (!best || score > best.score) best = { score, angle: t, safe };
  }

  // A cut that cannot be made safely is given up, rather than steered round.
  if (hunt && Math.abs(wrapRad(best.angle - goal)) > 0.6) memory.cut = null;

  // Boost when it pays and the faster path is clear: crossing in front of a
  // snake, or to a dead snake's dots before anyone else. It costs length, so never when short of it, and never
  // just for ordinary food.
  let boost = false;
  if (me.mass >= MIN_BOOST_MASS && best.safe && Math.abs(wrapRad(best.angle - goal)) < 0.35) {
    const wantsIt = hunt ? hunt.boost : Boolean(food && food.rich >= RICH && food.dist > 150 * PX && food.dist < 700 * PX);
    if (wantsIt) boost = tryHeading(ctx, best.angle, BOOST_SPEED, BOOST_HORIZON).hit === Infinity;
  }

  const plan = { angle: toAng(best.angle), boost, hunting: Boolean(hunt), safe: best.safe };
  cache.set(world, { tick: world.tick, player, plan });
  return plan;
}
