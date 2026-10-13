#!/usr/bin/env node
// Slither's promises: the same seed and inputs make the same world, a
// world restored from a snapshot carries on exactly as the original, the
// whole-number trigonometry is right, and a full world steps fast enough.
//
// Run: node scripts/test-slither.mjs

import {
  ANG,
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

if (failed) {
  console.error(`\n${failed} failed.`);
  process.exit(1);
}
console.log("\nAll passed.");
