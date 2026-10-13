// Autoplay's steering in Slither: how the secret F2 player plays.
//
// It only ever produces inputs, an angle and whether to boost, which go
// into the world like anyone's; it is not part of the world itself. So
// unlike js/slither-rules.js it may use floating point freely, and it can
// look further and think harder than the computer snakes do.
//
// Every tick it:
//   1. picks a goal: a snake it can cut off, or else the biggest cluster of
//      dots near it, which it sticks with until it is eaten
//   2. tries a fan of headings, each played forward under its real turn
//      rate for most of a second, against every other snake's body, where
//      their heads are about to be, and the edge of the world
//   3. takes the heading that stays clear longest and best serves the goal
//   4. boosts when it pays: to get ahead of a snake it is cutting off, or to
//      reach a rich dot first, and only if the faster path is clear too
//
// Cutting off is the kill: get to a point just ahead of another snake's
// head before it does, then turn across its path, so its head runs into
// this snake's body.
//
// It never goes round in circles: food inside its own turning circle,
// which it could only orbit, is not a goal, and if it has still turned more
// than a full circle and a quarter in a second and a half, it goes straight
// for a while, wherever is clear.

import {
  ANG,
  ARENA_R,
  BOOST_MIN_MASS,
  BOOST_SPEED,
  CELL,
  SPEED,
  SUB,
  radiusOf,
  snakeOf,
  turnRateOf,
} from "./slither-rules.js";

const TAU = Math.PI * 2;
const PX = SUB; // sub-units per pixel, for reading distances
const HORIZON = 40; // ticks played forward to judge a heading, about 1.3 s
const BOOST_HORIZON = 30;
const FAN = 28; // headings tried, besides the goal's own
const MARGIN = 12 * PX; // room kept from anything solid
const GRID = 96 * PX;
const CLUSTER = 100 * PX; // the cells dots are added up in
const RIM_FOOD = ARENA_R - 600 * PX; // food further out leads to the rim
const LOOP_TICKS = 48;
const LOOP_TURN = 1.25 * Math.PI * 2;
const STRAIGHT_TICKS = 30;

const toRad = (a) => (a / ANG) * TAU;
const toAng = (rad) => ((Math.round((rad / TAU) * ANG) % ANG) + ANG) % ANG;
const wrapRad = (d) => ((((d + Math.PI) % TAU) + TAU) % TAU) - Math.PI;

// Other snakes' bodies on a fine grid, and their heads with where they are going.
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
    heads.push({ s, x: s.xs[0], y: s.ys[0], ux: Math.cos(a), uy: Math.sin(a), speed: s.boosting ? BOOST_SPEED : SPEED, r });
  }
  return { cells, heads };
}

function bodyHit(obs, x, y, reach) {
  const cx = Math.floor(x / GRID);
  const cy = Math.floor(y / GRID);
  for (let ix = cx - 1; ix <= cx + 1; ix += 1) {
    for (let iy = cy - 1; iy <= cy + 1; iy += 1) {
      const list = obs.cells.get(ix * 8192 + iy);
      if (!list) continue;
      for (let k = 0; k < list.length; k += 3) {
        const lim = reach + list[k + 2];
        const dx = list[k] - x;
        const dy = list[k + 1] - y;
        if (dx * dx + dy * dy < lim * lim) return true;
      }
    }
  }
  return false;
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
// never within the horizon), and how much food it passes through.
function tryHeading(ctx, goal, speed, ticks) {
  const { me, obs, world, r, rate } = ctx;
  let x = me.xs[0];
  let y = me.ys[0];
  let a = toRad(me.angle);
  const seen = new Set();
  let food = 0;
  const edge = ARENA_R - r - MARGIN * 2;
  const reach = r * 0.7 + MARGIN;
  for (let k = 1; k <= ticks; k += 1) {
    a += Math.max(-rate, Math.min(rate, wrapRad(goal - a)));
    x += Math.cos(a) * speed;
    y += Math.sin(a) * speed;
    // The edge holds a snake in rather than killing it, so it only costs:
    // pinned against it, a snake is easy to cut off.
    if (x * x + y * y > edge * edge) return { hit: Infinity, rim: true, food };
    if (bodyHit(obs, x, y, reach)) return { hit: k, food };
    for (const h of obs.heads) {
      const hx = h.x + h.ux * h.speed * k;
      const hy = h.y + h.uy * h.speed * k;
      const lim = r + h.r + MARGIN;
      const dx = hx - x;
      const dy = hy - y;
      // Their head where it will be: meeting it head on is a loss either way.
      if (dx * dx + dy * dy < lim * lim) return { hit: k, food };
    }
    if (k % 2 === 0) food += foodAt(world, x, y, r + 14 * PX, seen);
  }
  return { hit: Infinity, food };
}

/* ---- Goals ---- */

// A snake to cut off: one whose head this snake can beat to a point ahead
// of it. Returns the point to make for, or, once ahead, the heading that
// crosses its path.
function huntGoal(ctx) {
  const { me, obs, r } = ctx;
  if (me.mass < 30) return null;
  const mx = me.xs[0];
  const my = me.ys[0];
  let best = null;
  for (const h of obs.heads) {
    const dx = mx - h.x;
    const dy = my - h.y;
    const d = Math.hypot(dx, dy);
    if (d > 750 * PX) continue;
    // Already just ahead of its head, close to its line: cross it.
    const along = dx * h.ux + dy * h.uy;
    const side = -dx * h.uy + dy * h.ux;
    if (along > 0 && along < 260 * PX && Math.abs(side) < h.r * 3 + r * 3) {
      const nx = -h.uy * Math.sign(side || 1);
      const ny = h.ux * Math.sign(side || 1);
      // Across its line, from the side this snake is on.
      const score = 10_000 + h.s.mass;
      if (!best || score > best.score) best = { score, angle: Math.atan2(-ny, -nx), cutting: true, target: h };
      continue;
    }
    // A point ahead of it, far enough to get there first.
    const lead = Math.max(120 * PX, Math.min(420 * PX, d * 0.7 + r * 3));
    const px = h.x + h.ux * lead;
    const py = h.y + h.uy * lead;
    if (px * px + py * py > RIM_FOOD * RIM_FOOD) continue;
    if (orbitOnly(ctx, px, py)) continue;
    const mine = Math.hypot(px - mx, py - my);
    const theirs = lead / h.speed;
    const normal = mine / SPEED;
    const fast = mine / BOOST_SPEED;
    if (fast > theirs * 0.85) continue;
    const score = (h.s.mass + 40) / (d / PX + 250);
    if (!best || score > best.score) {
      best = { score, angle: Math.atan2(py - my, px - mx), cutting: false, needBoost: normal > theirs * 0.8, target: h };
    }
  }
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

// The biggest cluster of dots near enough: dots added up in cells, each
// cell counted with its neighbours, value against distance. Big dots, where
// a snake died, count for the most.
function clusterGoal(ctx, memory) {
  const { me, world } = ctx;
  const mx = me.xs[0];
  const my = me.ys[0];

  // The cluster it is already after, while enough of it is left.
  const held = memory.cluster;
  if (held && world.tick < held.until && !orbitOnly(ctx, held.x, held.y)) {
    const left = valueNear(world, held.x, held.y, CLUSTER * 1.5);
    if (left >= held.value * 0.35) {
      return { angle: Math.atan2(held.y - my, held.x - mx), big: held.value >= 12, dist: Math.hypot(held.x - mx, held.y - my) };
    }
  }

  const look = 760 * PX;
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
        const c = cells.get(k) ?? { v: 0, x: 0, y: 0 };
        // Big dots weigh more than their value alone: a snake's remains.
        const w = d.v >= 4 ? d.v * 1.5 : d.v;
        c.v += w;
        c.x += d.x * w;
        c.y += d.y * w;
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
    for (let ix = -1; ix <= 1; ix += 1) {
      for (let iy = -1; iy <= 1; iy += 1) {
        const n = cells.get((kx + ix) * 65536 + ky + iy);
        if (!n) continue;
        v += n.v;
        x += n.x;
        y += n.y;
      }
    }
    x /= v;
    y /= v;
    if (orbitOnly(ctx, x, y)) continue;
    const dist = Math.hypot(x - mx, y - my);
    const score = Math.pow(v, 1.2) / (dist / PX + 150);
    if (!best || score > best.score) best = { score, x, y, v, dist };
  }
  if (!best) {
    memory.cluster = null;
    return null;
  }
  memory.cluster = { x: best.x, y: best.y, value: best.v, until: world.tick + 48 };
  return { angle: Math.atan2(best.y - my, best.x - mx), big: best.v >= 12, dist: best.dist };
}

function valueNear(world, x, y, radius) {
  let v = 0;
  const cx = Math.floor(x / CELL);
  const cy = Math.floor(y / CELL);
  for (let ix = cx - 1; ix <= cx + 1; ix += 1) {
    for (let iy = cy - 1; iy <= cy + 1; iy += 1) {
      const set = world.dotGrid.get(ix * 4096 + iy);
      if (!set) continue;
      for (const id of set) {
        const d = world.dots.get(id);
        if (Math.hypot(d.x - x, d.y - y) < radius) v += d.v;
      }
    }
  }
  return v;
}

/* ---- Choosing ---- */

const cache = new WeakMap();
// What autoplay remembers between ticks, per world and player: the cluster
// it is after, its recent headings, and how long to keep going straight.
const memories = new WeakMap();

function memoryOf(world, player) {
  let byPlayer = memories.get(world);
  if (!byPlayer) memories.set(world, (byPlayer = new Map()));
  let m = byPlayer.get(player);
  if (!m) byPlayer.set(player, (m = { cluster: null, turns: [], last: null, straightUntil: 0 }));
  return m;
}

export function planAutoplay(world, player) {
  const me = snakeOf(world, player);
  if (!me) return null;
  const memo = cache.get(world);
  if (memo && memo.tick === world.tick && memo.player === player) return memo.plan;

  const r = radiusOf(me.mass);
  const ctx = { world, me, r, rate: toRad(turnRateOf(r)), obs: obstacles(world, me) };
  const memory = memoryOf(world, player);
  const here = toRad(me.angle);

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
  }
  const straight = world.tick < memory.straightUntil;

  const hunt = straight ? null : huntGoal(ctx);
  const food = hunt || straight ? null : clusterGoal(ctx, memory);
  const goal = hunt ? hunt.angle : food ? food.angle : here;

  // The fan: every direction, plus the goal and either side of it.
  const tries = [goal, goal + 0.25, goal - 0.25, here];
  for (let i = 0; i < FAN; i += 1) tries.push((i / FAN) * TAU);

  let best = null;
  for (const t of tries) {
    const run = tryHeading(ctx, t, SPEED, HORIZON);
    const safe = run.hit === Infinity;
    const score =
      (safe ? 100_000 : run.hit * 1_000) -
      (run.rim ? 30_000 : 0) +
      Math.cos(wrapRad(t - goal)) * (hunt ? 900 : 400) +
      run.food * 25 -
      Math.abs(wrapRad(t - here)) * 40;
    if (!best || score > best.score) best = { score, angle: t, safe };
  }

  // Boost when it pays and the faster path is clear: to beat a snake to the
  // point ahead of it, while crossing its path, or to a rich dot first. It
  // costs length, so never when short of it.
  let boost = false;
  const spare = me.mass >= Math.max(BOOST_MIN_MASS + 15, 40);
  if (spare && best.safe) {
    const wantsIt = (hunt && (hunt.cutting || hunt.needBoost)) || (food && food.big && food.dist > 160 * PX && food.dist < 560 * PX);
    if (wantsIt && Math.abs(wrapRad(best.angle - goal)) < 0.6) {
      boost = tryHeading(ctx, best.angle, BOOST_SPEED, BOOST_HORIZON).hit === Infinity;
    }
  }

  const plan = { angle: toAng(best.angle), boost, hunting: Boolean(hunt) };
  cache.set(world, { tick: world.tick, player, plan });
  return plan;
}
