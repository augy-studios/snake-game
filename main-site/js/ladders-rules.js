// Snakes & Ladders: the board and the rules, apart from the screen, so
// scripts/test-ladders.mjs can play whole games without a browser.
//
// The rules, as the board game has them:
//   - Everyone starts off the board and takes turns rolling one die,
//     moving that many squares along 1 to 100.
//   - Landing on the foot of a ladder climbs to its top; landing on a
//     snake's head slides down to its tail. Landing on a ladder's top or a
//     snake's tail does nothing.
//   - The first to land on 100 wins. It takes the exact roll: a roll that
//     would go past either leaves the counter where it is, or, with the
//     bounce rule, walks it to 100 and back the rest of the way.
//   - With the six rule, a 6 earns another roll straight after.
// The squares run from the bottom left, left to right along the first row,
// right to left along the next, and so on up the board.

// Bump with any change to the rules or to what a hosted game sends: every
// device in a game plays each roll out itself, so a device on another
// version is turned away rather than left to drift.
export const RULES_VERSION = 1;

export const SIZE = 10;
export const LAST = SIZE * SIZE;
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 4;

// The layout of the classic Chutes and Ladders board, its chutes as snakes.
// [from, to]: a ladder's foot and top, a snake's head and tail.
export const LADDERS = [
  [1, 38],
  [4, 14],
  [9, 31],
  [21, 42],
  [28, 84],
  [36, 44],
  [51, 67],
  [71, 91],
  [80, 100],
];
export const SNAKES = [
  [16, 6],
  [47, 26],
  [49, 11],
  [56, 53],
  [62, 19],
  [64, 60],
  [87, 24],
  [93, 73],
  [95, 75],
  [98, 78],
];

// Where square n sits: its column from the left and row from the top.
export function squareAt(n) {
  const fromBottom = Math.floor((n - 1) / SIZE);
  const along = (n - 1) % SIZE;
  return { col: fromBottom % 2 === 0 ? along : SIZE - 1 - along, row: SIZE - 1 - fromBottom };
}

export const rollDie = (random = Math.random) => 1 + Math.floor(random() * 6);

// A counter on `from` moving `roll`: every square it steps on, where that
// leaves it, any ladder or snake there, and where it ends up.
export function move(from, roll, { bounce = false } = {}) {
  if (from + roll > LAST && !bounce) {
    return { from, path: [], landed: from, jump: null, to: from, blocked: true, bounced: false };
  }
  const path = [];
  let at = from;
  let step = 1;
  for (let k = 0; k < roll; k += 1) {
    if (at === LAST) step = -1;
    at += step;
    path.push(at);
  }
  const ladder = LADDERS.find(([foot]) => foot === at);
  const snake = SNAKES.find(([head]) => head === at);
  const jump = ladder ? { kind: "ladder", from: at, to: ladder[1] } : snake ? { kind: "snake", from: at, to: snake[1] } : null;
  return { from, path, landed: at, jump, to: jump ? jump.to : at, blocked: false, bounced: step < 0 };
}

// players: [{ name, computer }], in turn order.
export function newGame({ players, sixAgain = true, bounce = false }) {
  if (players.length < MIN_PLAYERS || players.length > MAX_PLAYERS) throw new Error("bad player count");
  return {
    rules: { sixAgain, bounce },
    players: players.map((p) => ({ name: p.name, computer: Boolean(p.computer), square: 0, rolls: 0, climbed: 0, slid: 0 })),
    turn: 0,
    over: false,
    winner: null,
    seq: 0, // turns played, which names each roll in a hosted game
  };
}

// The player whose turn it is rolls `roll`. Moves them, passes the turn on
// unless they won or rolled a six under the six rule, and says what happened.
export function playTurn(game, roll) {
  if (game.over) throw new Error("game over");
  const seat = game.turn;
  const p = game.players[seat];
  const m = move(p.square, roll, game.rules);
  p.square = m.to;
  p.rolls += 1;
  game.seq += 1;
  if (m.jump?.kind === "ladder") p.climbed += 1;
  if (m.jump?.kind === "snake") p.slid += 1;
  const won = p.square === LAST;
  const again = !won && game.rules.sixAgain && roll === 6;
  if (won) {
    game.over = true;
    game.winner = seat;
  } else if (!again) {
    game.turn = (seat + 1) % game.players.length;
  }
  return { seat, roll, ...m, won, again };
}

// The game as a hosted game sends it to the devices that joined.
export function snapshotGame(game) {
  return JSON.parse(JSON.stringify(game));
}

// A game from another device, checked like any input from one: null if it
// cannot be a game at all, every number kept in range otherwise.
export function restoreGame(raw) {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.players)) return null;
  const n = raw.players.length;
  if (n < MIN_PLAYERS || n > MAX_PLAYERS) return null;
  const int = (v, lo, hi) => (Number.isInteger(v) && v >= lo && v <= hi ? v : lo);
  const players = raw.players.map((p, i) => ({
    name: String(p?.name ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 20) || `Player ${i + 1}`,
    computer: p?.computer === true,
    square: int(p?.square, 0, LAST),
    rolls: int(p?.rolls, 0, 1e6),
    climbed: int(p?.climbed, 0, 1e6),
    slid: int(p?.slid, 0, 1e6),
  }));
  const winner = Number.isInteger(raw.winner) && players[raw.winner]?.square === LAST ? raw.winner : null;
  return {
    rules: { sixAgain: raw.rules?.sixAgain !== false, bounce: raw.rules?.bounce === true },
    players,
    turn: int(raw.turn, 0, n - 1),
    over: winner !== null,
    winner,
    seq: int(raw.seq, 0, 1e7),
  };
}

// Seats from first place down: the winner, then furthest along, then
// whoever is earlier in the turn order.
export function standings(game) {
  return game.players
    .map((p, seat) => ({ ...p, seat }))
    .sort((a, b) => (b.seat === game.winner) - (a.seat === game.winner) || b.square - a.square || a.seat - b.seat);
}
