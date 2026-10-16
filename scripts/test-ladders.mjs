#!/usr/bin/env node
// Snakes & Ladders' rules, checked: the squares wind up the board, the
// ladders and snakes are where they should be and never chain, landing on
// 100 takes the exact roll or bounces back, a 6 rolls again only under the
// six rule, and games played with a seeded die always end with a winner.
// Run after any change to js/ladders-rules.js.
//
// Run: node scripts/test-ladders.mjs

import { LADDERS, LAST, SIZE, SNAKES, move, newGame, playTurn, restoreGame, snapshotGame, standings, squareAt } from "../main-site/js/ladders-rules.js";

let failed = 0;
function check(name, ok, detail = "") {
  if (ok) console.log(`  ok    ${name}`);
  else {
    failed += 1;
    console.error(`  FAIL  ${name} ${detail}`);
  }
}

// A seeded die, so a failure can be played again.
function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const players = (n) => Array.from({ length: n }, (_, i) => ({ name: `P${i + 1}`, computer: i > 0 }));

// The board.
const seen = new Set();
let neighbours = true;
for (let n = 1; n <= LAST; n += 1) {
  const { col, row } = squareAt(n);
  seen.add(`${col},${row}`);
  if (n > 1) {
    const prev = squareAt(n - 1);
    if (Math.abs(prev.col - col) + Math.abs(prev.row - row) !== 1) neighbours = false;
  }
}
check("every square has its own place on the board", seen.size === LAST);
check("each square is next to the one before it", neighbours);
check("1 is bottom left", squareAt(1).col === 0 && squareAt(1).row === SIZE - 1);
check("11 is above 10, on the right", squareAt(11).col === SIZE - 1 && squareAt(11).row === SIZE - 2);
check("100 is top left", squareAt(100).col === 0 && squareAt(100).row === 0);

const ends = [...LADDERS, ...SNAKES];
check("ladders go up and snakes go down", LADDERS.every(([a, b]) => b > a) && SNAKES.every(([a, b]) => b < a));
check("all inside the board", ends.every(([a, b]) => a >= 1 && a < LAST && b >= 1 && b <= LAST));
const starts = new Set(ends.map(([a]) => a));
check("no two start on one square", starts.size === ends.length);
check("none ends where another starts", ends.every(([, b]) => !starts.has(b)));

// Moving.
check("a plain roll moves on", move(10, 3).to === 13 && move(10, 3).path.join() === "11,12,13");
check("a ladder's foot climbs it", move(0, 1).to === 38 && move(0, 1).jump?.kind === "ladder");
check("a snake's head slides down", move(10, 6).to === 6 && move(10, 6).jump?.kind === "snake");
check("a ladder's top does nothing", move(35, 3).to === 38 && move(35, 3).jump === null);
check("past 100 stays put", move(97, 5).to === 97 && move(97, 5).blocked);
check("the exact roll lands on 100", move(97, 3).to === 100);
const bounce = move(97, 5, { bounce: true });
check("bouncing walks back the rest", bounce.path.join() === "98,99,100,99,98" && bounce.bounced, bounce.path.join());
check("a bounce can land on a snake", move(96, 6, { bounce: true }).to === 78, String(move(96, 6, { bounce: true }).to));

// Turns.
{
  const g = newGame({ players: players(2), sixAgain: true });
  const t = playTurn(g, 6);
  check("under the six rule a 6 rolls again", t.again && g.turn === 0);
  playTurn(g, 2);
  check("then the turn passes", g.turn === 1);
  const h = newGame({ players: players(2), sixAgain: false });
  playTurn(h, 6);
  check("without it a 6 passes the turn", h.turn === 1);
}
{
  const g = newGame({ players: players(3) });
  g.players[1].square = 97;
  g.turn = 1;
  const t = playTurn(g, 3);
  check("landing on 100 wins", t.won && g.over && g.winner === 1);
  check("the winner comes first", standings(g)[0].seat === 1);
  let threw = false;
  try {
    playTurn(g, 1);
  } catch {
    threw = true;
  }
  check("no turns after a win", threw);
}
{
  let refused = 0;
  for (const n of [0, 1, 5]) {
    try {
      newGame({ players: players(n) });
    } catch {
      refused += 1;
    }
  }
  check("two to four players only", refused === 3);
}

// A hosted game's copy, as the joiners get it.
{
  const g = newGame({ players: players(3), bounce: true });
  [3, 6, 2, 5, 1].forEach((r) => playTurn(g, r));
  check("every turn counts", g.seq === 5);
  const copy = restoreGame(JSON.parse(JSON.stringify(snapshotGame(g))));
  check("a copy comes back the same", JSON.stringify(copy) === JSON.stringify(g), JSON.stringify(copy));
  const a = restoreGame(snapshotGame(g));
  const b = restoreGame(snapshotGame(g));
  [4, 2, 6, 3].forEach((r) => {
    playTurn(a, r);
    playTurn(b, r);
  });
  check("two copies given the same rolls stay the same", JSON.stringify(a) === JSON.stringify(b));
  check("a broken copy is refused", restoreGame({ players: [{}] }) === null && restoreGame("x") === null);
  const odd = restoreGame({ players: [{ square: 500, name: "ab" }, { square: -3 }], turn: 9, winner: 1 });
  check("a copy's numbers are kept in range", odd.players[0].square === 0 && odd.players[1].square === 0 && odd.turn === 0 && odd.winner === null);
  check("a copy's names lose control characters", odd.players[0].name === "ab");
}

// Whole games.
for (const rules of [{ sixAgain: true, bounce: false }, { sixAgain: false, bounce: true }]) {
  let longest = 0;
  let ended = 0;
  for (let seed = 1; seed <= 500; seed += 1) {
    const random = seeded(seed);
    const g = newGame({ players: players(2 + (seed % 3)), ...rules });
    let turns = 0;
    while (!g.over && turns < 5000) {
      playTurn(g, 1 + Math.floor(random() * 6));
      turns += 1;
    }
    if (g.over && g.players[g.winner].square === LAST) ended += 1;
    longest = Math.max(longest, turns);
  }
  check(`500 games end with a winner (${rules.sixAgain ? "six rule" : "bounce"})`, ended === 500, `${ended} ended, longest ${longest} turns`);
}

console.log(failed ? `\n${failed} failed.` : "\nAll passed.");
process.exit(failed ? 1 : 0);
