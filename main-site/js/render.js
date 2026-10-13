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

// Whether two body cells sit side by side on the board, not across an edge.
const touching = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) === 1;

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

export function drawBoard(ctx, size, view, palette, { dpr = 1, pulse = 0, hints = false, highlight = null } = {}) {
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
  view.snakes.forEach((s, i) => drawSnake(ctx, s, cell, palette.snakes[i % 4], palette, view.snakes.length > 1));

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

function drawSnake(ctx, s, cell, color, palette, party) {
  if (!s.body.length) return;
  // Out, it fades into the board. An opaque mix, not transparency, so the
  // overlapping segments and bridges do not show through each other.
  const alpha = 1;
  const inset = cell * 0.1;
  const size = cell - inset * 2;
  ctx.fillStyle = rgba(s.alive ? color : mix(color, palette.board, party ? 0.3 : 0.5));

  // Each segment, bridged to the one before when they are side by side, so
  // the body reads as one piece; across an edge it simply leaves and comes back.
  for (let i = s.body.length - 1; i >= 0; i -= 1) {
    const [x, y] = s.body[i];
    const shrink = i === s.body.length - 1 && s.body.length > 2 ? cell * 0.08 : 0;
    roundRect(ctx, x * cell + inset + shrink, y * cell + inset + shrink, size - shrink * 2, size - shrink * 2, cell * 0.28);
    ctx.fill();
    if (i > 0 && touching(s.body[i], s.body[i - 1])) {
      const [px, py] = s.body[i - 1];
      const bx = Math.min(x, px) * cell + inset;
      const by = Math.min(y, py) * cell + inset;
      ctx.fillRect(bx + (x !== px ? size / 2 : 0), by + (y !== py ? size / 2 : 0), x !== px ? cell : size, y !== py ? cell : size);
    }
  }

  // Eyes on the head, looking the way it is going.
  const [hx, hy] = s.body[0];
  const dir = s.dir >= 0 ? s.dir : 1;
  const [dx, dy] = DIRS[dir];
  const cx = (hx + 0.5) * cell + dx * cell * 0.12;
  const cy = (hy + 0.5) * cell + dy * cell * 0.12;
  const side = cell * 0.2;
  for (const k of [-1, 1]) {
    const ex = cx + -dy * side * k;
    const ey = cy + dx * side * k;
    ctx.beginPath();
    ctx.arc(ex, ey, cell * 0.13, 0, Math.PI * 2);
    ctx.fillStyle = rgba(palette.page, alpha);
    ctx.fill();
    if (s.alive) {
      ctx.beginPath();
      ctx.arc(ex + dx * cell * 0.04, ey + dy * cell * 0.04, cell * 0.065, 0, Math.PI * 2);
      ctx.fillStyle = rgba(palette.ink);
      ctx.fill();
    } else {
      // Out: crossed eyes.
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
