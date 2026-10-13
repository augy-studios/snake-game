#!/usr/bin/env node
// Slither's promises: the same seed and inputs make the same world, a
// world restored from a snapshot carries on exactly as the original, the
// whole-number trigonometry is right, and a full world steps fast enough.
//
// Run: node scripts/test-slither.mjs

import { SlitherPlayer } from "../main-site/js/slither-replay.js";
import { planAutoplay } from "../main-site/js/slither-autoplay.js";
import {
  ANG,
  ARENA_R,
  applyEvent,
  autoSteer,
  cosOf,
  iatan2,
  newWorld,
  restore,
  sinOf,
  snapshot,
  snakeOf,
  standings,
  step,
  worldHash,
} from "../main-site/js/slither-rules.js";

let failed = 0;
function check(name, ok, detail = "") {
  if (ok) console.log(`  ok    ${name}`);
  else {
    failed += 1;
    console.error(`  FAIL  ${name} ${detail}`);
  }
}

console.log("Trigonometry");
let worstSin = 0;
for (let a = 0; a < ANG; a += 1) worstSin = Math.max(worstSin, Math.abs(sinOf(a) / 16384 - Math.sin((a / ANG) * 2 * Math.PI)));
check("sines within a table step", worstSin < 0.0002, worstSin);
let worstAtan = 0;
for (let a = 0; a < ANG; a += 7) {
  const back = iatan2(sinOf(a) * 100, cosOf(a) * 100);
  worstAtan = Math.max(worstAtan, Math.abs((((back - a + ANG * 1.5) % ANG) - ANG / 2)));
}
check("atan2 inverts them to within two units", worstAtan <= 2, worstAtan);

// A world with one player steering by a fixed script and the computer
// playing the rest. Events land on the tick they are recorded at.
function run(seed, ticks, { from = null, events = [] } = {}) {
  const world = from ? restore(from) : newWorld(seed);
  const log = [];
  let i = 0;
  while (world.tick < ticks) {
    const t = world.tick;
    const due = [];
    if (t === 0) due.push([0, 2, 0, "Tester", "b.none.3-5", "browser1"]);
    while (i < events.length && events[i][0] < t) i += 1;
    while (i < events.length && events[i][0] === t) due.push(events[i++]);
    if (!events.length && t > 0 && t % 7 === 0 && snakeOf(world, 0)) {
      const steer = autoSteer(world, 0);
      due.push([t, 0, 0, steer.angle], [t, 1, 0, steer.boost ? 1 : 0]);
    }
    if (!events.length && t % 400 === 399 && !snakeOf(world, 0)) due.push([t, 4, 0]);
    for (const e of due) if (applyEvent(world, e)) log.push(e);
    step(world);
  }
  return { world, log };
}

console.log("Determinism");
const t0 = performance.now();
const a = run("SLITHER1", 3000);
const ms = performance.now() - t0;
const b = run("SLITHER1", 3000, { events: a.log });
check("the same seed and inputs make the same world", worldHash(a.world) === worldHash(b.world), `${worldHash(a.world)} vs ${worldHash(b.world)}`);
check("a different seed makes a different world", worldHash(run("OTHER", 300).world) !== worldHash(run("SLITHER1", 300).world));

const mid = run("SLITHER1", 1500, { events: a.log });
const json = JSON.parse(JSON.stringify(snapshot(mid.world)));
const resumed = run("SLITHER1", 3000, { from: json, events: a.log });
check("a world restored from a snapshot carries on the same", worldHash(resumed.world) === worldHash(a.world));
console.log(`        snapshot ${Math.round(JSON.stringify(json).length / 1024)} KB`);

console.log("The world");
const top = standings(a.world);
const deaths = a.world.snakes.length;
check("about twenty snakes alive", top.length >= 16 && top.length <= 20, `${top.length}`);
check("the computer grows", top[0].mass > 60, `top mass ${top[0].mass}`);
console.log(`        after ${a.world.tick} ticks (${Math.round((a.world.tick * 32) / 1000)} s of play): ${top.length} snakes, biggest ${top[0].name} at ${top[0].mass}, ${a.world.dots.size} dots, snake ids up to ${a.world.nextSnake}`);
const perTick = ms / 3000;
check("a tick takes well under its 32 ms", perTick < 4, `${perTick.toFixed(2)} ms`);
console.log(`        ${perTick.toFixed(2)} ms a tick in Node`);


console.log("Replays");
// A life that begins mid-world, recorded as js/slither-game.js records it,
// then played back: from its start it must be this player's snake, and
// every keyframe must match the world as it was.
{
  const live = newWorld("REPLAY1");
  const hashes = new Map();
  let start = null;
  const events = [];
  const from = 700;
  while (live.tick < from + 900) {
    const t = live.tick;
    const due = [];
    if (t === 300) due.push([t, 2, 5, "Early", "b.none.1", "x"]);
    if (t === from) {
      start = { state: JSON.parse(JSON.stringify(snapshot(live))) };
      due.push([t, 2, 0, "Me", "b.none.3", "me"]);
    }
    if (t === from + 400) due.push([t, 2, 9, "Late", "b.none.2", "y"]);
    if (t > from && t % 9 === 0 && snakeOf(live, 0)) due.push([t, 0, 0, (t * 53) % 4096]);
    for (const e of due) if (applyEvent(live, e) && t >= from) events.push(e);
    step(live);
    hashes.set(live.tick, worldHash(live));
  }
  const replay = { v: 1, kind: "slither", seed: "REPLAY1", focus: 0, name: "Me", start, from, to: live.tick, events };
  const player = new SlitherPlayer(replay);
  player.forward();
  const mine = snakeOf(player.world, 0);
  check("a replay starts on the player's own snake", mine && mine.name === "Me", mine?.name);
  check("and matches the world from its first tick", worldHash(player.world) === hashes.get(player.world.tick));
  let all = true;
  for (const t of [from + 1, from + 200, from + 450, from + 899]) {
    player.seek(t);
    if (worldHash(player.world) !== hashes.get(t)) all = false;
  }
  check("dragging anywhere shows the world as it was", all);
  check("a player who joins later still joins in the replay", Object.keys(player.world.players).includes("9") && snakeOf(player.world, 9) !== null);
}

console.log("The computer's snakes");
{
  let windows = 0;
  let loops = 0;
  let botTicks = 0;
  let boosting = 0;
  const w = newWorld("LOOPS");
  const turn = new Map();
  const last = new Map();
  while (w.tick < 3000) {
    step(w);
    for (const s of w.snakes) {
      if (!s.alive || s.player >= 0) continue;
      botTicks += 1;
      if (s.boosting) boosting += 1;
      const prev = last.get(s.id);
      if (prev !== undefined) turn.set(s.id, (turn.get(s.id) ?? 0) + ((((s.angle - prev) % ANG) + ANG + ANG / 2) % ANG) - ANG / 2);
      last.set(s.id, s.angle);
    }
    if (w.tick % 64 === 0) {
      for (const t of turn.values()) {
        windows += 1;
        if (Math.abs(t) > ANG * 1.5) loops += 1;
      }
      turn.clear();
    }
  }
  check("they do not go round in circles", loops / windows < 0.03, `${((loops / windows) * 100).toFixed(1)}%`);
  check("they boost now and then", boosting / botTicks > 0.01 && boosting / botTicks < 0.3, `${((boosting / botTicks) * 100).toFixed(1)}%`);
}

console.log("Autoplay and the edge");
{
  const w = newWorld("EDGE");
  applyEvent(w, [0, 2, 0, "Me", "b.none.3", "me"]);
  let windows = 0;
  let loops = 0;
  let turn = 0;
  let last = null;
  let pinned = 0;
  while (w.tick < 2400) {
    const t = w.tick;
    const s = snakeOf(w, 0);
    if (s && t < 1200) {
      // Straight for the edge, and along it.
      applyEvent(w, [t, 0, 0, iatan2(s.ys[0], s.xs[0])]);
    } else if (s) {
      const p = planAutoplay(w, 0);
      applyEvent(w, [t, 0, 0, p.angle]);
      applyEvent(w, [t, 1, 0, p.boost ? 1 : 0]);
    } else {
      applyEvent(w, [t, 4, 0]);
    }
    step(w);
    const me = snakeOf(w, 0);
    if (me && t < 1200 && me.xs[0] ** 2 + me.ys[0] ** 2 > (ARENA_R - 40 * 16) ** 2) pinned += 1;
    if (me && t >= 1200) {
      if (last !== null) turn += ((((me.angle - last) % ANG) + ANG + ANG / 2) % ANG) - ANG / 2;
      last = me.angle;
    }
    if (t >= 1200 && t % 64 === 0) {
      windows += 1;
      if (Math.abs(turn) > ANG * 1.5) loops += 1;
      turn = 0;
    }
  }
  check("the edge holds a snake in rather than killing it", pinned > 200, `${pinned} ticks at the edge`);
  check("autoplay does not go round in circles", loops / windows < 0.05, `${loops} of ${windows}`);
}

if (failed) {
  console.error(`\n${failed} failed.`);
  process.exit(1);
}
console.log("\nAll passed.");
