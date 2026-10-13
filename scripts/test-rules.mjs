#!/usr/bin/env node
// The engine's promises, checked: a game recorded as the page records it
// plays back identically, the bot survives a while, walls wrap, the snake
// cannot turn back on itself, timers and versus end games as documented, and
// a replay survives the long link. Run before every deploy that touches
// js/rules.js, js/bot.js or js/replay-format.js.
//
// Run: node scripts/test-rules.mjs

import {
  GRID,
  applyEvent,
  currentTickMs,
  newGame,
  playThrough,
  step,
  summary,
  tickMs,
} from "../main-site/js/rules.js";
import { botMove } from "../main-site/js/bot.js";
import { cleanReplay, packReplay, unpackReplay } from "../main-site/js/replay-format.js";

let failed = 0;
function check(name, ok, detail = "") {
  if (ok) console.log(`  ok    ${name}`);
  else {
    failed += 1;
    console.error(`  FAIL  ${name} ${detail}`);
  }
}

// Plays a solo game the way js/game.js does: inputs land on the tick they
// are applied at, and only the ones the engine takes are recorded.
function botGame(seed, settings, maxTicks = 20000, autoplayEvent = false) {
  const state = newGame({ seed, settings });
  const events = [];
  const record = (e) => applyEvent(state, e) && events.push(e);
  if (autoplayEvent) record([0, 1, 1]);
  while (!state.over && state.tick < maxTicks) {
    const dir = botMove(state, 0);
    if (dir >= 0) record([state.tick, 0, 0, dir]);
    step(state);
  }
  return {
    state,
    replay: { v: 1, kind: "solo", at: null, mode: "solo", grid: GRID, seed, settings, players: ["Bot"], ticks: state.tick, events },
  };
}

console.log("Determinism");
const settings = { difficulty: "normal", start_level: 0, game_seconds: 0, fruit_seconds: 0 };
const a = botGame("TESTA1", settings, 6000);
const again = playThrough(cleanReplay(a.replay));
check("a recorded game cleans as a replay", cleanReplay(a.replay) !== null);
check(
  "replaying it gives the same result",
  JSON.stringify(summary(again.state)) === JSON.stringify(summary(a.state)),
  JSON.stringify([summary(again.state).score, summary(a.state).score])
);
check("the bot eats plenty", a.state.snakes[0].fruits >= 30, `ate ${a.state.snakes[0].fruits}`);
console.log(`        bot: ${a.state.snakes[0].fruits} fruits, score ${summary(a.state).score}, level ${a.state.level}, ${a.state.tick} ticks, over: ${a.state.over}`);

const b1 = newGame({ seed: "SAME", settings });
const b2 = newGame({ seed: "SAME", settings });
check("the same seed places the same first fruit", b1.fruits[0].x === b2.fruits[0].x && b1.fruits[0].y === b2.fruits[0].y);

console.log("Movement");
const w = newGame({ seed: "WRAP", settings });
w.fruits = [];
applyEvent(w, [0, 0, 0, 3]);
for (let i = 0; i < GRID / 2 + 1; i += 1) step(w);
check("left through the edge comes back on the right", w.snakes[0].body[0][0] === GRID - 1, `x=${w.snakes[0].body[0][0]}`);
check("a solo snake waits for its first move", (() => {
  const g = newGame({ seed: "IDLE", settings });
  step(g);
  return g.tick === 0;
})());
const r = newGame({ seed: "REV", settings });
applyEvent(r, [0, 0, 0, 1]);
step(r);
step(r);
check("turning straight back is ignored", applyEvent(r, [r.tick, 0, 0, 3]) === false);
applyEvent(r, [r.tick, 0, 0, 0]);
check("two turns in one tick cannot reverse it", applyEvent(r, [r.tick, 0, 0, 3]) === false);

console.log("Speed and points");
check("speed has a floor", tickMs("hard", 30) === 45 && tickMs("easy", 0) === 160);
check("autoplay is quicker than any human speed", tickMs("hard", 30, true) < 45);
check("a later start level is faster", tickMs("normal", 20) < tickMs("normal", 10));

console.log("Timers");
const lim = botGame("LIMIT1", { ...settings, game_seconds: 60 }, 100000);
check("a game time limit ends the game", lim.state.over && (lim.state.reason === "time" || lim.state.reason === "crash"), lim.state.reason);
check("and not before its time", lim.state.reason !== "time" || lim.state.timeMs >= 60000);
const ft = newGame({ seed: "FRUIT5", settings: { ...settings, fruit_seconds: 5 } });
applyEvent(ft, [0, 0, 0, 0]);
const first = ft.fruits[0];
while (ft.fruits[0] === first && ft.tick < 500) {
  // Up and down the same column, never reaching it on purpose.
  if (ft.fruits[0].x === ft.snakes[0].body[0][0]) applyEvent(ft, [ft.tick, 0, 0, 1]);
  step(ft);
}
check("a fruit timer moves an uneaten fruit", ft.missed === 1 || ft.snakes[0].fruits === 1, `missed ${ft.missed}`);

console.log("Party");
const v = newGame({ seed: "VERSUS", mode: "versus", players: 2, settings });
v.fruits = [];
v.snakes[0].body = [[10, 5]];
v.snakes[1].body = [[12, 5]];
v.snakes[0].dir = 1;
v.snakes[1].dir = 3;
v.snakes[0].moved = 1;
v.snakes[1].moved = 3;
step(v);
check("versus: head on, both are out", !v.snakes[0].alive && !v.snakes[1].alive && v.over);
check("versus: level scores draw", v.winner === null);
const c = newGame({ seed: "COOP", mode: "coop", players: 2, settings });
c.fruits = [];
c.snakes[0].body = [[10, 5]];
c.snakes[1].body = [[12, 5]];
c.snakes[0].dir = 1;
c.snakes[1].dir = 3;
step(c);
check("co-op: snakes pass through each other", c.snakes[0].alive && c.snakes[1].alive);
const p = newGame({ seed: "WALLS", mode: "coop", players: 1, settings });
const [hx, hy] = p.snakes[0].body[0];
check("a wall never lands next to a head", applyEvent(p, [0, 2, hx + 1, hy, 1]) === false);
check("a wall never lands just ahead of a head", applyEvent(p, [0, 2, (hx + 5) % GRID, hy, 0]) === false);
check("a wall lands further off", applyEvent(p, [0, 2, (hx + 10) % GRID, (hy + 5) % GRID, 0]) === true);

console.log("Replays");
const auto = botGame("AUTO", settings, 400, true);
check("an autoplayed game says so", summary(auto.state).autoplayed === true);
check("an autoplayed game is quicker per move", currentTickMs(auto.state) < tickMs("normal", auto.state.level));
const packed = await packReplay(cleanReplay(a.replay));
const back = await unpackReplay(packed);
check("the long link round trips", JSON.stringify(back) === JSON.stringify(cleanReplay(a.replay)));
console.log(`        long link for ${a.replay.events.length} turns: ${packed.length} characters`);
check("a tampered replay is refused", cleanReplay({ ...a.replay, events: [[5, 0, 0, 9]] }) === null);

if (failed) {
  console.error(`\n${failed} failed.`);
  process.exit(1);
}
console.log("\nAll passed.");
