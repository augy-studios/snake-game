// Draws a game on the board canvas. Takes a view, the shape js/rules.js
// keeps a game in (grid, snakes, fruits, walls, timeMs), whether it comes
// from this device's game, a party host's snapshot or a replay. Every colour
// comes from the theme tokens, so it follows the swatch and the mode.

import { DIRS } from "./rules.js";

function parseColor(value) {
  const s = (value || "").trim();
  if (s.startsWith("#")) {
    let hex = s.slice(1);
    if (hex.length === 3) hex = [...hex].map((c) => c + c).join("");
    const n = parseInt(hex.slice(0, 6), 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
  }
  const m = s.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const [r, g, b, a = 1] = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    return { r, g, b, a };
  }
  return { r: 0, g: 0, b: 0, a: 1 };
}

// t of a, the rest of b, both treated as opaque.
const mix = (a, b, t) => ({
  r: a.r * t + b.r * (1 - t),
  g: a.g * t + b.g * (1 - t),
  b: a.b * t + b.b * (1 - t),
  a: 1,
});
const over = (fg, bg) => mix(fg, bg, fg.a);
export const rgba = (c, alpha = 1) => `rgba(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)}, ${alpha})`;

// The same recipes theme.css uses, resolved to plain colours for the canvas.
export function readPalette() {
  const cs = getComputedStyle(document.documentElement);
  const token = (name) => parseColor(cs.getPropertyValue(name));
  const brand = token("--brand");
  const page = mix(brand, token("--bg"), 0.1);
  const strong = over(token("--surface-strong"), page);
  return {
    page,
    strong,
    board: mix(token("--ink"), strong, 0.04),
    cellAlt: mix(token("--ink"), strong, 0.07),
    ink: token("--ink"),
    brandInk: token("--brand-ink"),
    fruit: token("--fruit"),
    fruitLeaf: token("--fruit-leaf"),
    extra: token("--fruit-extra"),
    snakes: [1, 2, 3, 4].map((i) => token(`--snake-${i}`)),
  };
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) {
    ctx.roundRect(x, y, w, h, r);
    return;
  }
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// The board under everything: its fill, the faint checks so a cell's place
// reads at a glance, and a dashed rim saying the edges wrap round. 1,600
// cells is too many to fill on every frame, so it is drawn once into a
// canvas of its own and copied, until the size or the theme changes.
let backdrop = null;

function boardBackdrop(size, grid, palette, dpr) {
  if (backdrop && backdrop.size === size && backdrop.grid === grid && backdrop.palette === palette && backdrop.dpr === dpr) {
    return backdrop.canvas;
  }
  const canvas = backdrop?.canvas ?? document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(size * dpr));
  canvas.height = canvas.width;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const cell = size / grid;
  const radius = Math.min(14, cell * 1.5);
  roundRect(ctx, 0, 0, size, size, radius);
  ctx.fillStyle = rgba(palette.board);
  ctx.fill();
  ctx.save();
  ctx.clip();
  ctx.fillStyle = rgba(palette.cellAlt);
  for (let y = 0; y < grid; y += 1) {
    for (let x = y & 1; x < grid; x += 2) ctx.fillRect(x * cell, y * cell, cell, cell);
  }
  ctx.restore();
  ctx.setLineDash([cell * 0.6, cell * 0.6]);
  ctx.lineWidth = 2;
  ctx.strokeStyle = rgba(palette.ink, 0.28);
  roundRect(ctx, 1, 1, size - 2, size - 2, radius);
  ctx.stroke();
  backdrop = { size, grid, palette, dpr, canvas };
  return canvas;
}

// `motion`, when given, is one entry per snake for smooth movement between
// moves: { t, dir, grows }, see bodyPieces.
export function drawBoard(ctx, size, view, palette, { dpr = 1, pulse = 0, hints = false, highlight = null, motion = null } = {}) {
  const { grid } = view;
  const cell = size / grid;
  ctx.clearRect(0, 0, size, size);
  ctx.drawImage(boardBackdrop(size, grid, palette, dpr), 0, 0, size, size);
  ctx.save();
  roundRect(ctx, 0, 0, size, size, Math.min(14, cell * 1.5));
  ctx.clip();

  // Walls a watcher dropped, fading out over their last second.
  for (const w of view.walls) {
    const left = w.untilMs - view.timeMs;
    ctx.fillStyle = rgba(palette.ink, 0.75 * Math.max(0.25, Math.min(1, left / 1000)));
    for (const [x, y] of w.cells) {
      roundRect(ctx, x * cell + cell * 0.06, y * cell + cell * 0.06, cell * 0.88, cell * 0.88, cell * 0.2);
      ctx.fill();
    }
  }

  for (const f of view.fruits) drawFruit(ctx, f, cell, palette, view, pulse);
  view.snakes.forEach((s, i) => drawSnake(ctx, s, i, cell, palette.snakes[i % 4], palette, view.snakes.length > 1, view, motion?.[i]));

  if (highlight) {
    // A watcher's aim: where the wall or fruit would land.
    ctx.fillStyle = rgba(highlight.ok ? palette.brandInk : palette.fruit, 0.35);
    for (const [x, y] of highlight.cells) ctx.fillRect(x * cell, y * cell, cell, cell);
  }

  if (hints) drawHints(ctx, size, palette);
  ctx.restore();
}

// Whether a frame with no new move would still look different. Timer rings
// and fading walls follow the game's clock, which only moves with a move;
// only an extra fruit's pulse follows the wall clock.
export function animating(view) {
  return view.fruits.some((f) => f.extra);
}

function drawFruit(ctx, f, cell, palette, view, pulse) {
  const cx = (f.x + 0.5) * cell;
  const cy = (f.y + 0.5) * cell;
  const r = cell * (f.extra ? 0.36 + 0.05 * Math.sin(pulse * 6) : 0.4);
  ctx.beginPath();
  ctx.arc(cx, cy + cell * 0.04, r, 0, Math.PI * 2);
  ctx.fillStyle = rgba(f.extra ? palette.extra : palette.fruit);
  ctx.fill();
  if (!f.extra) {
    ctx.beginPath();
    ctx.ellipse(cx + cell * 0.12, cy - r * 0.95, cell * 0.14, cell * 0.07, -0.6, 0, Math.PI * 2);
    ctx.fillStyle = rgba(palette.fruitLeaf);
    ctx.fill();
  }
  // A fruit on a timer wears its time left as a ring.
  if (f.limitMs) {
    const left = Math.max(0, 1 - (view.timeMs - f.bornMs) / f.limitMs);
    ctx.beginPath();
    ctx.arc(cx, cy, cell * 0.62, -Math.PI / 2, -Math.PI / 2 + left * Math.PI * 2);
    ctx.lineWidth = Math.max(1.5, cell * 0.1);
    ctx.strokeStyle = rgba(left < 0.3 ? palette.fruit : palette.ink, 0.6);
    ctx.stroke();
  }
}

// The cell centres, in board units, with wrapping undone: each point is
// moved by whole boards to sit next to the one before it, so a snake
// crossing an edge is a line that runs off the board. drawSnake draws it
// again shifted by a board wherever it ran off, so it comes back on the
// other side.
function centres(s, grid) {
  const pts = [];
  let px = 0;
  let py = 0;
  s.body.forEach(([x, y], i) => {
    let ux = x + 0.5;
    let uy = y + 0.5;
    if (i > 0) {
      ux += Math.round((px - ux) / grid) * grid;
      uy += Math.round((py - uy) / grid) * grid;
    }
    pts.push([ux, uy]);
    px = ux;
    py = uy;
  });
  return pts;
}

/* ---- The body as a path ----
   Each cell is a piece from the middle of the edge the snake came in by to
   the middle of the edge it leaves by: straight across, or at a corner a
   quarter circle round the corner of the cell the two edges share. So every
   turn is a curve, and the pieces join end to end.

   Between moves the head crosses its own cell, from the edge it came in by
   (`t` = 0, just as the move before it ended) to the edge it leaves by
   (`t` = 1), and the tail leaves its cell the same way unless the snake is
   growing. The head's cell is the one place still to be decided, by the
   move being made, which is always known: the game's own next move, a
   replay's, or the turn queued next. So the head follows the curve as it
   goes round, never past it, and a turn bends it the moment it is made. */

const sameDir = (a, b) => a[0] === b[0] && a[1] === b[1];
const towards = (from, to) => [Math.sign(to[0] - from[0]), Math.sign(to[1] - from[1])];

// A cell's piece: through centre c, in by direction din, out by dout.
function piece(c, din, dout) {
  const from = [c[0] - din[0] / 2, c[1] - din[1] / 2];
  const to = [c[0] + dout[0] / 2, c[1] + dout[1] / 2];
  if (sameDir(din, dout)) return { from, to, dir: dout };
  const corner = [c[0] + (dout[0] - din[0]) / 2, c[1] + (dout[1] - din[1]) / 2];
  const a0 = Math.atan2(from[1] - corner[1], from[0] - corner[0]);
  let turn = Math.atan2(to[1] - corner[1], to[0] - corner[0]) - a0;
  if (turn > Math.PI) turn -= Math.PI * 2;
  if (turn < -Math.PI) turn += Math.PI * 2;
  return { from, to, corner, a0, turn };
}

// Where along a piece fraction f is, and which way it is heading there.
function along(p, f) {
  if (!p.corner) return { x: p.from[0] + (p.to[0] - p.from[0]) * f, y: p.from[1] + (p.to[1] - p.from[1]) * f, dx: p.dir[0], dy: p.dir[1] };
  const a = p.a0 + p.turn * f;
  const k = Math.sign(p.turn);
  return { x: p.corner[0] + Math.cos(a) / 2, y: p.corner[1] + Math.sin(a) / 2, dx: -Math.sin(a) * k, dy: Math.cos(a) * k };
}

// Adds a piece from fraction f0 to f1 to the current path, shifted by
// (ox, oy) boards' worth of units, at `cell` pixels a unit.
function trace(ctx, p, f0, f1, ox, oy, cell) {
  if (f1 <= f0) return;
  if (!p.corner) {
    const b = along(p, f1);
    ctx.lineTo((b.x + ox) * cell, (b.y + oy) * cell);
    return;
  }
  ctx.arc((p.corner[0] + ox) * cell, (p.corner[1] + oy) * cell, cell / 2, p.a0 + p.turn * f0, p.a0 + p.turn * f1, p.turn < 0);
}

// Which way each snake came into its tail cell. The body no longer holds
// the cell the tail left, so it is remembered from the frame before: when
// the tail has moved on one cell, it came from the cell the tail was in.
// Unknown (a new game, a seek in a replay), the tail is drawn straight.
const tailsSeen = [];

function tailEntry(index, s, grid) {
  const n = s.body.length;
  const tail = s.body[n - 1];
  const next = s.body[n - 2];
  const seen = tailsSeen[index];
  const same = (a, b) => a && b && a[0] === b[0] && a[1] === b[1];
  let from = null;
  if (seen && same(seen.tail, tail)) from = seen.from;
  else if (seen && same(seen.next, tail)) from = seen.tail;
  tailsSeen[index] = { tail, next, from };
  if (!from) return null;
  // From the cell before to the tail, across an edge if need be.
  const step = (a, b) => {
    const d = (((b - a) % grid) + grid) % grid;
    return d === 1 ? 1 : d === grid - 1 ? -1 : 0;
  };
  const dir = [step(from[0], tail[0]), step(from[1], tail[1])];
  const out = [step(tail[0], next[0]), step(tail[1], next[1])];
  // Only a neighbour, and never doubling back.
  if (Math.abs(dir[0]) + Math.abs(dir[1]) !== 1 || (dir[0] === -out[0] && dir[1] === -out[1])) return null;
  return dir;
}

// The pieces from tail to head, how much of the tail's and the head's are
// drawn, and where the head is. The tail piece is drawn from `tailFrom` on,
// the head piece up to `headTo`; a snake of one cell is both at once.
function bodyPieces(s, pts, view, motion, tailIn) {
  const n = pts.length;
  const alive = s.alive;
  // Out, it stays as it was when it hit: all the way across, up against
  // whatever it hit. Still in, as each move starts.
  const m = motion ?? { t: alive ? 0 : 1, dir: s.dir, grows: !alive && s.grow > 0 };
  const t = m.t;
  // The way into each cell, from the cell behind it; the tail's, the way it
  // came in if that is known, or else straight.
  const din = pts.map((c, i) => (i < n - 1 ? towards(pts[i + 1], c) : null));
  const back = (dir) => [-dir[0], -dir[1]];
  let headOut = m.dir >= 0 ? DIRS[m.dir] : null;
  if (n > 1 && (!headOut || sameDir(headOut, back(din[0])))) headOut = din[0];
  if (n > 1) din[n - 1] = tailIn ?? towards(pts[n - 1], pts[n - 2]);
  else din[0] = headOut;
  if (!din[0]) return null; // one cell that has never moved: a dot

  const pieces = pts.map((c, i) => piece(c, din[i], i > 0 ? towards(c, pts[i - 1]) : headOut));
  let tailFrom = m.grows ? 0 : t;
  let headTo = t;
  // The cell the snake started in has no back half: it began in the middle.
  // Its tail stays there until the head has moved a whole cell, and its
  // very first move starts from there, at half the pace, so neither jumps.
  if (view.tick !== undefined && n === view.tick + 1) tailFrom = Math.max(tailFrom, 0.5);
  if (n === 1) headTo = 0.5 + t / 2;
  return { pieces, tailFrom, headTo, head: along(pieces[0], headTo) };
}

function drawSnake(ctx, s, index, cell, color, palette, party, view, motion) {
  if (!s.body.length) return;
  const { grid } = view;
  // Out, it fades into the board: an opaque mix, so nothing shows through.
  const fill = rgba(s.alive ? color : mix(color, palette.board, party ? 0.3 : 0.5));
  const pts = centres(s, grid);
  const tailIn = s.body.length > 1 ? tailEntry(index, s, grid) : null;
  const body = bodyPieces(s, pts, view, s.alive ? motion : null, tailIn);
  const width = cell * 0.78;

  // The copies needed to bring back whatever ran off an edge.
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [x, y] of pts) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  const shiftsX = [];
  for (let k = Math.floor((minX - 1) / grid); k <= Math.floor((maxX + 1) / grid); k += 1) shiftsX.push(-k * grid);
  const shiftsY = [];
  for (let k = Math.floor((minY - 1) / grid); k <= Math.floor((maxY + 1) / grid); k += 1) shiftsY.push(-k * grid);

  // A snake that has never moved is a dot in the middle of its cell, looking
  // right until it goes somewhere.
  const resting = [1, 0];
  const head = body ? body.head : { x: pts[0][0], y: pts[0][1], dx: resting[0], dy: resting[1] };
  const n = pts.length;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = width;
  ctx.strokeStyle = fill;
  ctx.fillStyle = fill;
  for (const ox of shiftsX) {
    for (const oy of shiftsY) {
      if (body) {
        const { pieces, tailFrom, headTo } = body;
        const start = along(pieces[n - 1], tailFrom);
        ctx.beginPath();
        ctx.moveTo((start.x + ox) * cell, (start.y + oy) * cell);
        if (n === 1) trace(ctx, pieces[0], tailFrom, headTo, ox, oy, cell);
        else {
          trace(ctx, pieces[n - 1], tailFrom, 1, ox, oy, cell);
          for (let i = n - 2; i >= 1; i -= 1) trace(ctx, pieces[i], 0, 1, ox, oy, cell);
          trace(ctx, pieces[0], 0, headTo, ox, oy, cell);
        }
        ctx.stroke();
      }
      // The head as a disc as well, so a body with no length yet still shows.
      ctx.beginPath();
      ctx.arc((head.x + ox) * cell, (head.y + oy) * cell, width / 2, 0, Math.PI * 2);
      ctx.fill();
      drawEyes(ctx, (head.x + ox) * cell, (head.y + oy) * cell, head.dx, head.dy, cell, palette, s.alive);
    }
  }
}

// Eyes on the head, looking the way it is going; crossed once it is out.
function drawEyes(ctx, hx, hy, dx, dy, cell, palette, alive) {
  const cx = hx + dx * cell * 0.1;
  const cy = hy + dy * cell * 0.1;
  const side = cell * 0.19;
  for (const k of [-1, 1]) {
    const ex = cx - dy * side * k;
    const ey = cy + dx * side * k;
    ctx.beginPath();
    ctx.arc(ex, ey, cell * 0.13, 0, Math.PI * 2);
    ctx.fillStyle = rgba(palette.page);
    ctx.fill();
    if (alive) {
      ctx.beginPath();
      ctx.arc(ex + dx * cell * 0.04, ey + dy * cell * 0.04, cell * 0.065, 0, Math.PI * 2);
      ctx.fillStyle = rgba(palette.ink);
      ctx.fill();
    } else {
      ctx.strokeStyle = rgba(palette.ink, 0.8);
      ctx.lineWidth = Math.max(1, cell * 0.05);
      const d = cell * 0.06;
      ctx.beginPath();
      ctx.moveTo(ex - d, ey - d);
      ctx.lineTo(ex + d, ey + d);
      ctx.moveTo(ex + d, ey - d);
      ctx.lineTo(ex - d, ey + d);
      ctx.stroke();
    }
  }
}

// On a touch screen, before the first move: the four edges to tap.
function drawHints(ctx, size, palette) {
  const reach = size * 0.035;
  ctx.strokeStyle = rgba(palette.brandInk, 0.55);
  ctx.lineWidth = Math.max(2, size * 0.008);
  const chevron = (x, y, dx, dy) => {
    ctx.beginPath();
    ctx.moveTo(x - dy * reach - dx * reach * 0.6, y + dx * reach - dy * reach * 0.6);
    ctx.lineTo(x, y);
    ctx.lineTo(x + dy * reach - dx * reach * 0.6, y - dx * reach - dy * reach * 0.6);
    ctx.stroke();
  };
  const m = size * 0.06;
  chevron(size / 2, m, 0, -1);
  chevron(size - m, size / 2, 1, 0);
  chevron(size / 2, size - m, 0, 1);
  chevron(m, size / 2, -1, 0);
}
