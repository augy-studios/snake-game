#!/usr/bin/env node
// Compares Slither's autoplay against the computer snakes' own steering:
// lives, length, and kills, over several worlds. Not a pass or fail check;
// run it after changing js/slither-autoplay.js to see whether it plays better.
//
// Run: node scripts/bench-autoplay.mjs

import { applyEvent, autoSteer, newWorld, snakeOf, step } from "../main-site/js/slither-rules.js";
import { planAutoplay } from "../main-site/js/slither-autoplay.js";

const TICKS = 5600; // three minutes of play
const SEEDS = ["BENCH1", "BENCH2", "BENCH3", "BENCH4", "BENCH5", "BENCH6"];

function run(seed, steer) {
  const world = newWorld(seed);
  let deaths = 0;
  let kills = 0;
  let longest = 0;
  let massAtDeath = 0;
  let snakeId = null;
  let last = null;
  let time = 0;
  while (world.tick < TICKS) {
    const t = world.tick;
    const due = t === 0 ? [[0, 2, 0, "Auto", "b.none.3", "b"]] : [];
    const me = snakeOf(world, 0);
    if (me) {
      const want = steer(world);
      if (want) due.push([t, 0, 0, want.angle], [t, 1, 0, want.boost ? 1 : 0]);
    } else if (t > 0) {
      due.push([t, 4, 0]);
    }
    for (const e of due) applyEvent(world, e);
    const t0 = performance.now();
    step(world);
    time += performance.now() - t0;
    const s = snakeOf(world, 0);
    if (s) {
      if (snakeId !== s.id) snakeId = s.id;
      longest = Math.max(longest, s.mass);
      last = s;
    }
    for (const h of world.happened) {
      if (h.type === "death" && h.player === 0) {
        deaths += 1;
        kills += last?.kills ?? 0;
        massAtDeath += last?.mass ?? 0;
      }
    }
  }
  const alive = snakeOf(world, 0);
  if (alive) kills += alive.kills;
  return { deaths, kills, longest, end: alive?.mass ?? 0 };
}

for (const [label, steer] of [
  ["computer's steering", (w) => autoSteer(w, 0)],
  ["autoplay planner", (w) => planAutoplay(w, 0)],
]) {
  let deaths = 0;
  let kills = 0;
  let longest = 0;
  const t0 = performance.now();
  for (const seed of SEEDS) {
    const r = run(seed, steer);
    deaths += r.deaths;
    kills += r.kills;
    longest = Math.max(longest, r.longest);
  }
  const ms = (performance.now() - t0) / (SEEDS.length * TICKS);
  console.log(
    `${label.padEnd(20)} ${SEEDS.length} worlds x 3 min: ${deaths} deaths, ${kills} kills, longest ${longest}, ${ms.toFixed(2)} ms a tick with steering`
  );
}
