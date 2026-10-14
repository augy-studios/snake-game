// Autoplay's steering. Pure, like rules.js: given the game, the direction one
// snake should take next, or -1 to keep going.
//
// It plays the way Snake is solved: a fixed loop through every cell of the
// board (a Hamiltonian cycle), with shortcuts. While the body lies along the
// loop in order, tail to head, a head that only ever moves forward along the
// loop and never past its own tail cannot trap itself, so the snake can fill
// the board. Within that rule it takes the quickest way to a fruit; with the
// fruit behind it on the loop, it closes up on its tail, where the fruit
// comes free soonest.
//
// When the body is out of order (autoplay switched on mid-game, or a board
// the loop does not fit), it falls back to searching outward from the head,
// aware that the body moves on: a cell the tail holds now is free by the
// time the head could get there. Of the moves open to it, it takes the next
// step round the loop if that leaves room, which brings the body into order
// within a body's length, and otherwise the move that reaches a fruit soonest
// while leaving at least a body's length of room, or the one with the most.

import { DIRS } from "./rules.js";

const wrap = (v, n) => ((v % n) + n) % n;

// Search buffers, kept between moves rather than allocated on every one: at
// autoplay's pace that is fifty searches a second, and the garbage would
// show as stutter.
let buffers = null;
function buffersFor(cells) {
  if (buffers?.cells !== cells) {
    buffers = {
      cells,
      free: new Float64Array(cells),
      dist: new Int32Array(cells),
      queue: new Int32Array(cells),
      toFruit: new Float64Array(cells),
    };
  }
  return buffers;
}

/* ---- The loop ----
   Row 0 left to right, then rows 1 to the last snaking back and forth over
   every column but the first, then up the first column home. It needs an
   even number of rows; any other board has no loop, and the bot only falls
   back. `order[c]` is cell c's place on the loop, `cellAt[i]` the cell in
   place i. */

let loop = null;
function loopFor(grid) {
  if (loop?.grid === grid) return loop;
  loop = { grid, order: null, cellAt: null };
  if (grid < 2 || grid % 2) return loop;
  const cellAt = [];
  for (let x = 0; x < grid; x += 1) cellAt.push(x);
  for (let y = 1; y < grid; y += 1) {
    for (let k = 1; k < grid; k += 1) cellAt.push(y * grid + (y % 2 ? grid - k : k));
  }
  for (let y = grid - 1; y >= 1; y -= 1) cellAt.push(y * grid);
  loop.cellAt = Int32Array.from(cellAt);
  loop.order = new Int32Array(grid * grid);
  loop.cellAt.forEach((c, i) => (loop.order[c] = i));
  return loop;
}

// The move count at which each cell is free: 0 for empty cells, Infinity for
// walls and other snakes, and for this snake's body the moves until its tail
// has passed that segment.
function freeAt(state, me) {
  const { grid } = state;
  const at = buffersFor(grid * grid).free.fill(0);
  for (const w of state.walls) for (const [x, y] of w.cells) at[y * grid + x] = Infinity;
  for (const s of state.snakes) {
    if (!s.alive) continue;
    const len = s.body.length;
    s.body.forEach(([x, y], i) => {
      at[y * grid + x] = s === me ? len - i + s.grow : Infinity;
    });
  }
  return at;
}

// The cells next to cell c, wrapping round the edges, in DIRS order.
function neighbours(grid, c) {
  const x = c % grid;
  const y = (c - x) / grid;
  return DIRS.map(([dx, dy]) => wrap(y + dy, grid) * grid + wrap(x + dx, grid));
}

/* ---- Along the loop ---- */

// The move along the loop, or null when the body is out of order or nothing
// it allows is open.
function loopMove(state, me, free) {
  const { grid } = state;
  const cells = grid * grid;
  const { order, cellAt } = loopFor(grid);
  if (!order) return null;

  const at = ([x, y]) => y * grid + x;
  const head = at(me.body[0]);
  const ahead = (c) => (order[c] - order[head] + cells) % cells;

  // In order: going back along the body goes back along the loop, so going
  // on round the loop from the head meets the tail first and the neck last.
  const len = me.body.length;
  for (let i = 2; i < len; i += 1) {
    if (ahead(at(me.body[i])) >= ahead(at(me.body[i - 1]))) return null;
  }
  // The open stretch of loop ahead of the head runs up to the tail, `gap`
  // places on. Nothing of the body is in it.
  const gap = len > 1 ? ahead(at(me.body[len - 1])) : cells;

  // Fruit in the open stretch. Fruit behind the head on the loop, in a cell
  // the body skipped, comes free once the tail has passed it.
  const fruitAt = new Set(state.fruits.map((f) => f.y * grid + f.x));
  let far = 0;
  for (const c of fruitAt) {
    const d = ahead(c);
    if (d > 0 && d < gap && free[c] === 0) far = Math.max(far, d);
  }

  // The fewest moves from each open place to a fruit, moving only forward:
  // worked back from the furthest fruit, since every step goes further on.
  const { toFruit } = buffersFor(cells);
  for (let d = far; d >= 1; d -= 1) {
    const c = cellAt[(order[head] + d) % cells];
    if (free[c] !== 0) toFruit[d] = Infinity;
    else if (fruitAt.has(c)) toFruit[d] = 0;
    else {
      let best = Infinity;
      for (const n of neighbours(grid, c)) {
        const dn = ahead(n);
        if (dn > d && dn <= far && toFruit[dn] < best) best = toFruit[dn];
      }
      toFruit[d] = best + 1;
    }
  }

  let best = null;
  neighbours(grid, head).forEach((n, dir) => {
    if (me.moved >= 0 && len > 1 && (dir + 2) % 4 === me.moved) return;
    const d = ahead(n);
    const eats = fruitAt.has(n);
    // Growing, the tail stays put: the step must land in the open stretch
    // and leave room there for the growth still to come. Otherwise it may
    // also take the tail's cell as the tail leaves it.
    const keepsTail = eats || me.grow > 0;
    const growLeft = keepsTail ? me.grow + (eats ? 1 : 0) - 1 : 0;
    const open = keepsTail ? d < gap && gap - d - 1 >= growLeft : d <= gap;
    if (d === 0 || !open) return;
    if (d < gap && free[n] !== 0) return; // a wall, or another snake
    const option = { dir, d, moves: d <= far ? toFruit[d] : Infinity };
    const better =
      !best ||
      (far
        ? option.moves < best.moves || (option.moves === best.moves && option.dir === me.dir)
        : option.d > best.d);
    if (better) best = option;
  });
  if (!best || (far && best.moves === Infinity)) return null;
  return best.dir;
}

/* ---- Searching outward ---- */

// Moves from a start cell reached at move 1: distance to every cell that can
// be entered in time, and how many cells that is.
function explore(state, free, sx, sy) {
  const { grid } = state;
  const { dist, queue } = buffersFor(grid * grid);
  dist.fill(-1);
  let head = 0;
  let tail = 0;
  const start = sy * grid + sx;
  dist[start] = 1;
  queue[tail++] = start;
  while (head < tail) {
    const c = queue[head++];
    const d = dist[c] + 1;
    for (const n of neighbours(grid, c)) {
      if (dist[n] >= 0 || free[n] > d) continue;
      dist[n] = d;
      queue[tail++] = n;
    }
  }
  return { dist, reach: tail };
}

function searchMove(state, me, free) {
  const { grid } = state;
  const { order, cellAt } = loopFor(grid);
  const [hx, hy] = me.body[0];
  const room = me.body.length + me.grow + 2;
  // The next place round the loop, which this prefers when it is safe.
  const onLoop = order ? cellAt[(order[hy * grid + hx] + 1) % (grid * grid)] : -1;

  let best = null;
  for (let dir = 0; dir < 4; dir += 1) {
    if (me.moved >= 0 && me.body.length > 1 && (dir + 2) % 4 === me.moved) continue;
    const x = wrap(hx + DIRS[dir][0], grid);
    const y = wrap(hy + DIRS[dir][1], grid);
    if (free[y * grid + x] > 1) continue;
    const { dist, reach } = explore(state, free, x, y);
    // dist is the shared buffer, so it is read before the next search.
    let toFruit = Infinity;
    for (const f of state.fruits) {
      const d = dist[f.y * grid + f.x];
      if (d > 0 && d < toFruit) toFruit = d;
    }
    const option = { dir, toFruit, reach, safe: reach >= room, loop: y * grid + x === onLoop };
    const better =
      !best ||
      (option.safe && !best.safe) ||
      (option.safe === best.safe &&
        (option.safe
          ? (option.loop && !best.loop) ||
            (option.loop === best.loop &&
              (option.toFruit < best.toFruit || (option.toFruit === best.toFruit && option.dir === me.dir)))
          : option.reach > best.reach));
    if (better) best = option;
  }
  return best ? best.dir : -1;
}

export function botMove(state, index) {
  const me = state.snakes[index];
  if (!me?.alive) return -1;
  const free = freeAt(state, me);
  return loopMove(state, me, free) ?? searchMove(state, me, free);
}
