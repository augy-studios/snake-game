// Slither replays: one life in a world, as the world when it began and
// every input after, played through js/slither-rules.js again. Shared by
// the page, which records and plays them, and the API, which checks and
// stores them. No DOM.
//
// {
//   v: 1,
//   kind: "slither",
//   at: ISO time,
//   seed: "K7QX2M",
//   focus: 0,                    the player whose life it is
//   name: "Augy",
//   start: { fresh: true }       a new world from the seed, at tick 0
//        | { state: {...} },     or a snapshot (slither-rules.js) at `from`
//   from: 0, to: 2400,           the ticks it covers
//   events: [[t, code, ...]]     slither-rules.js's events, in tick order
// }
//
// Unlike a Classic replay, this one carries the world itself when the life
// began mid-world, so it is tens of kilobytes. It is only ever shared as a
// short link, stored by the API.

import { ARENA_R, MAX_SNAKES, applyEvent, newWorld, restore, snapshot, step } from "./slither-rules.js";
import { cleanSkin } from "./slither-skins.js";
import { cleanSeed } from "./seed.js";

export const SLITHER_REPLAY_VERSION = 1;
export const MAX_REPLAY_TICKS = 60000; // 32 minutes
const MAX_EVENTS = 150000;

const isInt = (n, min, max) => Number.isInteger(n) && n >= min && n <= max;
const text = (v, max) =>
  typeof v === "string"
    ? Array.from(v.normalize("NFKC").replace(/\p{C}/gu, "").replace(/\s+/gu, " ").trim()).slice(0, max).join("")
    : "";

function cleanEvent(e, from, to) {
  if (!Array.isArray(e) || !isInt(e[0], from, to) || !isInt(e[2], 0, 1e6)) return null;
  const [t, code, p] = e;
  switch (code) {
    case 0:
      return isInt(e[3], 0, 4095) ? [t, 0, p, e[3]] : null;
    case 1:
    case 5:
      return isInt(e[3], 0, 1) ? [t, code, p, e[3]] : null;
    case 2:
      // Browser ids are left out of anything shared.
      return [t, 2, p, text(e[3], 20) || "Player", cleanSkin(e[4]), ""];
    case 6:
      return [t, 6, p, cleanSkin(e[3])];
    case 3:
    case 4:
    case 7:
      return [t, code, p];
    default:
      return null;
  }
}

const coord = (v) => isInt(v, -2 * ARENA_R, 2 * ARENA_R);

// A snapshot rebuilt from known fields only, or null if anything is off.
function cleanState(raw, seed, from) {
  if (!raw || typeof raw !== "object" || raw.seed !== seed || raw.tick !== from) return null;
  if (!isInt(raw.nextSnake, 1, 1e7) || !isInt(raw.nextDot, 1, 1e9) || !isInt(raw.foodSpawned, 0, 1e9)) return null;
  const players = {};
  const entries = Object.entries(raw.players ?? {});
  if (entries.length > 256) return null;
  for (const [key, p] of entries) {
    if (!/^\d{1,7}$/.test(key) || !p || typeof p !== "object") return null;
    players[key] = {
      name: text(p.name, 20) || "Player",
      skin: cleanSkin(p.skin),
      browser: "",
      snake: isInt(p.snake, 0, 1e7) ? p.snake : 0,
      connected: p.connected === true,
    };
  }
  if (!Array.isArray(raw.snakes) || raw.snakes.length > MAX_SNAKES + 8) return null;
  const snakes = [];
  for (const s of raw.snakes) {
    if (!s || !Array.isArray(s.xs) || !Array.isArray(s.ys) || s.xs.length !== s.ys.length) return null;
    if (s.xs.length < 1 || s.xs.length > 400 || !s.xs.every(coord) || !s.ys.every(coord)) return null;
    if (!isInt(s.id, 1, 1e7) || !isInt(s.player, -1, 1e6) || !isInt(s.mass, 1, 1e7)) return null;
    if (!isInt(s.angle, 0, 4095) || !isInt(s.target, 0, 4095) || !isInt(s.born, 0, 1e9) || !isInt(s.kills, 0, 1e6)) return null;
    if (!isInt(s.boostTicks ?? 0, 0, 1e9)) return null;
    const brain = s.brain && typeof s.brain === "object" ? s.brain : null;
    if (brain && !(isInt(brain.think, 0, 1e9) && isInt(brain.goal, 0, 4095) && isInt(brain.wander, 0, 4095))) return null;
    snakes.push({
      id: s.id,
      player: s.player,
      name: text(s.name, 20) || "Snake",
      skin: cleanSkin(s.skin),
      xs: [...s.xs],
      ys: [...s.ys],
      angle: s.angle,
      target: s.target,
      boost: s.boost === true,
      boosting: s.boosting === true,
      mass: s.mass,
      alive: s.alive === true,
      born: s.born,
      kills: s.kills,
      boostTicks: s.boostTicks ?? 0,
      brain: brain ? { think: brain.think, goal: brain.goal, wander: brain.wander } : null,
      autopilot: s.autopilot === true,
      autoplay: s.autoplay === true,
      autoplayed: s.autoplayed === true,
      cause: ["edge", "snake", "gone"].includes(s.cause) ? s.cause : null,
      killer: isInt(s.killer, 1, 1e7) ? s.killer : null,
      diedAt: isInt(s.diedAt, 0, 1e9) ? s.diedAt : undefined,
      bestRank: isInt(s.bestRank, 1, 64) ? s.bestRank : MAX_SNAKES,
    });
  }
  if (!Array.isArray(raw.dots) || raw.dots.length > 8000) return null;
  const dots = [];
  for (const d of raw.dots) {
    if (!Array.isArray(d) || d.length !== 5) return null;
    const [id, x, y, v, c] = d;
    if (!isInt(id, 1, 1e9) || !coord(x) || !coord(y) || !isInt(v, 1, 1e6) || !isInt(c, 0, 64)) return null;
    dots.push([id, x, y, v, c]);
  }
  return { seed, tick: from, nextSnake: raw.nextSnake, nextDot: raw.nextDot, foodSpawned: raw.foodSpawned, players, snakes, dots, incoming: [] };
}

export function cleanSlitherReplay(raw) {
  if (!raw || typeof raw !== "object" || raw.v !== SLITHER_REPLAY_VERSION || raw.kind !== "slither") return null;
  const seed = cleanSeed(raw.seed);
  if (!seed || seed !== raw.seed) return null;
  if (!isInt(raw.focus, 0, 1e6) || !isInt(raw.from, 0, 1e9) || !isInt(raw.to, raw.from + 1, raw.from + MAX_REPLAY_TICKS)) return null;
  let start = null;
  if (raw.start?.fresh === true && raw.from === 0) start = { fresh: true };
  else if (raw.start?.state) {
    const state = cleanState(raw.start.state, seed, raw.from);
    if (state) start = { state };
  }
  if (!start) return null;
  if (!Array.isArray(raw.events) || raw.events.length > MAX_EVENTS) return null;
  const events = [];
  let last = raw.from;
  for (const e of raw.events) {
    const clean = cleanEvent(e, last, raw.to);
    if (!clean) return null;
    events.push(clean);
    last = clean[0];
  }
  const at = typeof raw.at === "string" && !Number.isNaN(Date.parse(raw.at)) ? new Date(raw.at).toISOString() : null;
  return { v: SLITHER_REPLAY_VERSION, kind: "slither", at, seed, focus: raw.focus, name: text(raw.name, 20) || "Player", start, from: raw.from, to: raw.to, events };
}

export function startWorld(replay) {
  return replay.start.fresh ? newWorld(replay.seed) : restore(replay.start.state);
}

// Plays a replay through without keeping anything: whether it runs, and
// the focused player's life as it went.
export function playSlitherThrough(replay) {
  const world = startWorld(replay);
  let i = 0;
  while (world.tick < replay.to) {
    while (i < replay.events.length && replay.events[i][0] === world.tick) applyEvent(world, replay.events[i++]);
    step(world);
  }
  return world;
}

/* ---- Playing one back ----
   A copy of the world every KEYFRAME ticks, so stepping back and dragging
   the timeline are quick. Each tick's events are noted for the captions,
   and the ticks the focused player ate a lot, killed or died on, for the
   timeline's marks. */

const KEYFRAME = 128;

export class SlitherPlayer {
  constructor(replay) {
    this.replay = replay;
    this.keyframes = [];
    this.notes = new Map();
    this.marks = [];
    const world = startWorld(replay);
    let i = 0;
    const focus = replay.focus;
    let snake = null;
    while (world.tick < replay.to) {
      if ((world.tick - replay.from) % KEYFRAME === 0) this.keyframes.push({ snap: snapshot(world), event: i });
      while (i < replay.events.length && replay.events[i][0] === world.tick) applyEvent(world, replay.events[i++]);
      step(world);
      snake = world.players[focus]?.snake ?? snake;
      const mine = world.happened.filter(
        (h) => h.player === focus || (h.type === "death" && h.killer === snake && h.player !== focus)
      );
      if (mine.length) {
        this.notes.set(world.tick, mine);
        if (mine.some((h) => h.type === "death")) this.marks.push(world.tick);
      }
    }
    this.seek(replay.from);
  }

  get ticks() {
    return this.replay.to;
  }

  seek(tick) {
    const t = Math.max(this.replay.from, Math.min(this.replay.to, tick));
    const key = this.keyframes[Math.min(this.keyframes.length - 1, Math.floor((t - this.replay.from) / KEYFRAME))];
    this.world = restore(key.snap);
    this.event = key.event;
    this.prev = null;
    while (this.world.tick < t) this.forward(false);
  }

  // One tick on. Keeps the positions from before it, for smooth drawing.
  forward(keepPrev = true) {
    if (this.world.tick >= this.replay.to) return false;
    if (keepPrev) this.prev = new Map(this.world.snakes.map((s) => [s.id, { xs: [...s.xs], ys: [...s.ys] }]));
    const events = this.replay.events;
    while (this.event < events.length && events[this.event][0] === this.world.tick) applyEvent(this.world, events[this.event++]);
    step(this.world);
    return true;
  }
}
