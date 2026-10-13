// Autoplay's steering. Pure, like rules.js: given the game, the direction one
// snake should take next, or -1 to keep going.
//
// It searches outward from the head, aware that the body moves on: a cell
// the tail holds now is free by the time the head could get there. Of the
// moves open to it, it takes the one that reaches a fruit soonest while
// leaving at least a body's length of room to move in afterwards, so it
// rarely walls itself in. With no safe way to a fruit, it takes the move
// with the most room.

import { DIRS } from "./rules.js";

const wrap = (v, n) => ((v % n) + n) % n;

// Search buffers, kept between moves rather than allocated on every one: at
// autoplay's pace that is fifty searches a second, and the garbage would
// show as stutter.
let buffers = null;
function buffersFor(cells) {
  if (buffers?.cells !== cells) {
    buffers = { cells, free: new Float64Array(cells), dist: new Int32Array(cells), queue: new Int32Array(cells) };
  }
  return buffers;
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
    const x = c % grid;
    const y = (c - x) / grid;
    for (const [dx, dy] of DIRS) {
      const n = wrap(y + dy, grid) * grid + wrap(x + dx, grid);
      if (dist[n] >= 0 || free[n] > d) continue;
      dist[n] = d;
      queue[tail++] = n;
    }
  }
  return { dist, reach: tail };
}

export function botMove(state, index) {
  const me = state.snakes[index];
  if (!me?.alive) return -1;
  const { grid } = state;
  const free = freeAt(state, me);
  const [hx, hy] = me.body[0];
  const room = me.body.length + me.grow + 2;

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
    const option = { dir, toFruit, reach, safe: reach >= room };
    const better =
      !best ||
      (option.safe && !best.safe) ||
      (option.safe === best.safe &&
        (option.safe
          ? option.toFruit < best.toFruit || (option.toFruit === best.toFruit && option.dir === me.dir)
          : option.reach > best.reach));
    if (better) best = option;
  }
  return best ? best.dir : -1;
}
