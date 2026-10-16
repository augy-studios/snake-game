// Draws the Snakes & Ladders board and the counters on it. The board takes
// its colours from the theme: the squares, the ladders and the snakes are
// all shades of the brand swatch's hue, worked out again for light and for
// dark, so the board changes with the swatch and the mode like everything
// else. The counters keep the players' colours from Classic (--snake-1 to
// --snake-4), and a snake's tongue is the fruit's red.

import { readPalette, rgba } from "./render.js";
import { LADDERS, LAST, SIZE, SNAKES, squareAt } from "./ladders-rules.js";

/* ---- Colours ---- */

function toHsl({ r, g, b }) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return { h: h * 60, s, l };
}

function fromHsl(h, s, l) {
  const hue = (((h % 360) + 360) % 360) / 360;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t) => {
    t = (t + 1) % 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return { r: channel(hue + 1 / 3) * 255, g: channel(hue) * 255, b: channel(hue - 1 / 3) * 255, a: 1 };
}

// The board's colours for the theme as it is now. Read again whenever the
// swatch or the mode changes.
export function readBoardTheme() {
  const p = readPalette();
  const dark = document.documentElement.getAttribute("data-mode") === "dark";
  let { h, s } = toHsl(p.brand);
  // The white swatch has no hue. It is called really really light green,
  // so its board is a green so faint it is nearly grey.
  let tint = 1;
  if (s < 0.08) {
    h = 130;
    tint = 0.3;
  }
  // A shade of the swatch's hue, shifted round the wheel by `shift`
  // degrees: saturation and lightness in light mode, then in dark.
  const tone = (shift, sLight, lLight, sDark, lDark) => fromHsl(h + shift, (dark ? sDark : sLight) * tint, dark ? lDark : lLight);
  return {
    dark,
    page: p.page,
    ink: p.ink,
    tongue: p.fruit,
    players: p.snakes,
    frame: tone(0, 0.4, 0.8, 0.22, 0.22),
    cells: [tone(0, 0.75, 0.94, 0.2, 0.13), tone(0, 0.6, 0.85, 0.24, 0.19)],
    finish: tone(0, 0.7, 0.72, 0.42, 0.3),
    rail: tone(0, 0.3, 0.33, 0.28, 0.76),
    rung: tone(0, 0.28, 0.45, 0.24, 0.62),
    // Neighbouring hues, so the snakes tell apart and still match.
    snakes: [0, 32, -32, 60].map((shift) => ({
      body: tone(shift, 0.58, 0.44, 0.55, 0.62),
      band: tone(shift, 0.62, 0.6, 0.5, 0.46),
      edge: tone(shift, 0.55, 0.28, 0.5, 0.82),
    })),
    shadow: dark ? "rgba(0, 0, 0, 0.45)" : "rgba(20, 30, 25, 0.18)",
  };
}

/* ---- Where things are ----
   Positions are in squares: (0, 0) is the top left corner of the board, and
   a square's centre is half a square in from its corner. */

// The centre of square n. Square 0 is off the board, just left of square 1,
// where everyone waits before their first roll.
export function spotOf(n) {
  if (n <= 0) return { x: -0.7, y: SIZE - 0.5 };
  const { col, row } = squareAt(n);
  return { x: col + 0.5, y: row + 0.5 };
}

function frameOf(size) {
  const pad = Math.max(4, Math.round(size * 0.018));
  return { pad, cell: (size - pad * 2) / SIZE };
}

// Each snake's body, from t = 0 at its head to t = 1 at the tip of its tail:
// a line from the head's square to the tail's, swaying side to side. A
// counter sliding down follows the same curve.
const CURVES = SNAKES.map(([head, tail], k) => {
  const a = spotOf(head);
  const b = spotOf(tail);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  const nx = -dy / len;
  const ny = dx / len;
  const halves = Math.max(2, Math.round(len / 1.3));
  const sway = Math.min(0.42, 0.2 + len * 0.025) * (k % 2 ? -1 : 1);
  return {
    head,
    len,
    at(t) {
      const w = Math.sin(t * Math.PI * halves) * sway;
      return { x: a.x + dx * t + nx * w, y: a.y + dy * t + ny * w };
    },
  };
});

export function snakePoint(head, t) {
  return (CURVES.find((c) => c.head === head) ?? CURVES[0]).at(t);
}

/* ---- The board ----
   Squares, numbers, ladders and snakes never move, so they are drawn once
   into a canvas of their own and copied, until the size or theme changes. */

let backdrop = null;

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

function boardBackdrop(size, theme, dpr) {
  if (backdrop && backdrop.size === size && backdrop.theme === theme && backdrop.dpr === dpr) return backdrop.canvas;
  const canvas = backdrop?.canvas ?? document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(size * dpr));
  canvas.height = canvas.width;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size, size);
  const { pad, cell } = frameOf(size);
  const inner = size - pad * 2;

  roundRect(ctx, 0, 0, size, size, 14);
  ctx.fillStyle = rgba(theme.frame);
  ctx.fill();

  ctx.save();
  roundRect(ctx, pad, pad, inner, inner, Math.max(4, 14 - pad));
  ctx.clip();
  for (let n = 1; n <= LAST; n += 1) {
    const { col, row } = squareAt(n);
    ctx.fillStyle = rgba(n === LAST ? theme.finish : theme.cells[(col + row) % 2]);
    ctx.fillRect(pad + col * cell, pad + row * cell, Math.ceil(cell), Math.ceil(cell));
  }
  drawStar(ctx, pad + (squareAt(LAST).col + 0.5) * cell, pad + (squareAt(LAST).row + 0.56) * cell, cell * 0.3, theme);
  ctx.translate(pad, pad);
  LADDERS.forEach((l) => drawLadder(ctx, l, cell, theme));
  CURVES.forEach((c, k) => drawSnake(ctx, c, theme.snakes[k % theme.snakes.length], cell, theme));
  ctx.restore();

  drawNumbers(ctx, pad, cell, theme);
  backdrop = { size, theme, dpr, canvas };
  return canvas;
}

// The finish, marked with a star under its number.
function drawStar(ctx, cx, cy, r, theme) {
  ctx.beginPath();
  for (let k = 0; k < 10; k += 1) {
    const a = -Math.PI / 2 + (k * Math.PI) / 5;
    const rr = k % 2 ? r * 0.45 : r;
    ctx.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
  }
  ctx.closePath();
  ctx.fillStyle = rgba(theme.ink, theme.dark ? 0.5 : 0.35);
  ctx.fill();
}

// Every square's number, in its top left corner, on a halo of its own
// colour so it reads over a ladder or a snake.
function drawNumbers(ctx, pad, cell, theme) {
  const px = Math.max(8, Math.round(cell * 0.26));
  ctx.font = `${px}px Jua, "Segoe UI", sans-serif`;
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.lineJoin = "round";
  ctx.lineWidth = Math.max(2, cell * 0.08);
  for (let n = 1; n <= LAST; n += 1) {
    const { col, row } = squareAt(n);
    const x = pad + col * cell + cell * 0.08;
    const y = pad + row * cell + cell * 0.07;
    ctx.strokeStyle = rgba(n === LAST ? theme.finish : theme.cells[(col + row) % 2], 0.85);
    ctx.strokeText(String(n), x, y);
    ctx.fillStyle = rgba(theme.ink, n === LAST ? 0.9 : 0.62);
    ctx.fillText(String(n), x, y);
  }
}

function drawLadder(ctx, [foot, top], cell, theme) {
  const a = spotOf(foot);
  const b = spotOf(top);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  const ux = dx / len;
  const uy = dy / len;
  // The rails run a little past both centres, so the ends show.
  const over = 0.22;
  const x0 = (a.x - ux * over) * cell;
  const y0 = (a.y - uy * over) * cell;
  const x1 = (b.x + ux * over) * cell;
  const y1 = (b.y + uy * over) * cell;
  const half = cell * 0.19;
  const nx = -uy * half;
  const ny = ux * half;
  const rungs = Math.max(2, Math.floor((len + over * 2) / 0.36));

  const shape = (ox, oy) => {
    ctx.beginPath();
    for (let k = 1; k < rungs; k += 1) {
      const t = k / rungs;
      const x = x0 + (x1 - x0) * t + ox;
      const y = y0 + (y1 - y0) * t + oy;
      ctx.moveTo(x - nx, y - ny);
      ctx.lineTo(x + nx, y + ny);
    }
  };
  const rails = (ox, oy) => {
    ctx.beginPath();
    for (const side of [-1, 1]) {
      ctx.moveTo(x0 + nx * side + ox, y0 + ny * side + oy);
      ctx.lineTo(x1 + nx * side + ox, y1 + ny * side + oy);
    }
  };
  ctx.lineCap = "round";
  // Its shadow, then the rungs, then the rails over their ends.
  ctx.strokeStyle = theme.shadow;
  ctx.lineWidth = cell * 0.08;
  shape(cell * 0.05, cell * 0.07);
  ctx.stroke();
  rails(cell * 0.05, cell * 0.07);
  ctx.stroke();
  ctx.strokeStyle = rgba(theme.rung);
  ctx.lineWidth = cell * 0.055;
  shape(0, 0);
  ctx.stroke();
  ctx.strokeStyle = rgba(theme.rail);
  ctx.lineWidth = cell * 0.075;
  rails(0, 0);
  ctx.stroke();
}

// A snake as a row of discs from the tail up to the head, thinning towards
// the tail, banded every half square, with its head on top.
function drawSnake(ctx, curve, colors, cell, theme) {
  const n = Math.max(24, Math.ceil(curve.len * 16));
  const radius = (t) => cell * (0.19 - 0.12 * t ** 1.2);
  const discs = [];
  for (let i = n; i >= 0; i -= 1) {
    const t = i / n;
    const p = curve.at(t);
    discs.push({ x: p.x * cell, y: p.y * cell, r: radius(t), band: Math.floor(t * curve.len * 2.2) % 2 === 1 });
  }
  const outline = (grow, ox, oy, style) => {
    ctx.beginPath();
    for (const d of discs) {
      ctx.moveTo(d.x + ox + d.r + grow, d.y + oy);
      ctx.arc(d.x + ox, d.y + oy, d.r + grow, 0, Math.PI * 2);
    }
    ctx.fillStyle = style;
    ctx.fill();
  };
  outline(0, cell * 0.05, cell * 0.08, theme.shadow);
  outline(cell * 0.035, 0, 0, rgba(colors.edge));
  for (const d of discs) {
    ctx.beginPath();
    ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
    ctx.fillStyle = rgba(d.band ? colors.band : colors.body);
    ctx.fill();
  }

  // The head: facing away from the body, with eyes and a forked tongue.
  const h = curve.at(0);
  const back = curve.at(0.03);
  const ang = Math.atan2(h.y - back.y, h.x - back.x);
  const hx = h.x * cell;
  const hy = h.y * cell;
  ctx.save();
  ctx.translate(hx, hy);
  ctx.rotate(ang);
  ctx.strokeStyle = rgba(theme.tongue);
  ctx.lineWidth = Math.max(1, cell * 0.035);
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(cell * 0.22, 0);
  ctx.lineTo(cell * 0.38, 0);
  ctx.moveTo(cell * 0.38, 0);
  ctx.lineTo(cell * 0.45, -cell * 0.05);
  ctx.moveTo(cell * 0.38, 0);
  ctx.lineTo(cell * 0.45, cell * 0.05);
  ctx.stroke();
  ctx.beginPath();
  ctx.ellipse(0, 0, cell * 0.29, cell * 0.23, 0, 0, Math.PI * 2);
  ctx.fillStyle = rgba(colors.edge);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(0, 0, cell * 0.255, cell * 0.195, 0, 0, Math.PI * 2);
  ctx.fillStyle = rgba(colors.body);
  ctx.fill();
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.arc(cell * 0.08, side * cell * 0.09, cell * 0.065, 0, Math.PI * 2);
    ctx.fillStyle = rgba(theme.page);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cell * 0.1, side * cell * 0.09, cell * 0.032, 0, Math.PI * 2);
    ctx.fillStyle = rgba(theme.ink);
    ctx.fill();
  }
  ctx.restore();
}

/* ---- The counters ----
   One per player, as a little snake head in their colour: { seat, x, y,
   z, face }, x and y in squares, z its height off the board as it hops,
   and face which way it looks, 1 right or -1 left. */

// Where counters sharing a square sit, by how many there are.
const SHARED = [
  [[0, 0]],
  [[-0.2, 0], [0.2, 0]],
  [[-0.2, 0.12], [0.2, 0.12], [0, -0.18]],
  [[-0.2, -0.17], [0.2, -0.17], [-0.2, 0.19], [0.2, 0.19]],
];

export function drawLaddersBoard(ctx, size, theme, { dpr = 1, pawns = [], turn = -1, pulse = 0, glow = false } = {}) {
  ctx.clearRect(0, 0, size, size);
  ctx.drawImage(boardBackdrop(size, theme, dpr), 0, 0, size, size);
  if (!pawns.length) return;
  const { pad, cell } = frameOf(size);
  const inner = size - pad * 2;

  // Counters resting on the same square move apart to share it.
  const placed = pawns.map((p) => ({ ...p, ox: 0, oy: 0, r: 0.27 }));
  const groups = [];
  for (const p of placed) {
    if (p.z > 0.001) continue;
    const g = groups.find((q) => Math.abs(q[0].x - p.x) < 0.05 && Math.abs(q[0].y - p.y) < 0.05);
    if (g) g.push(p);
    else groups.push([p]);
  }
  for (const g of groups) {
    if (g.length < 2) continue;
    g.forEach((p, i) => {
      [p.ox, p.oy] = SHARED[g.length - 1][i];
      p.r = 0.21;
    });
  }

  ctx.save();
  roundRect(ctx, pad, pad, inner, inner, Math.max(4, 14 - pad));
  ctx.clip();
  ctx.translate(pad, pad);
  // The one whose turn it is on top, and anything in the air above that.
  placed.sort((a, b) => (a.seat === turn) - (b.seat === turn) || a.z - b.z);
  for (const p of placed) drawPawn(ctx, p, cell, theme, p.seat === turn && glow, pulse);
  ctx.restore();
}

function drawPawn(ctx, p, cell, theme, ringed, pulse) {
  const color = theme.players[p.seat % theme.players.length];
  const x = (p.x + p.ox) * cell;
  const ground = (p.y + p.oy) * cell;
  const y = ground - p.z * cell;
  const r = p.r * cell;

  // Its shadow stays on the board, smaller the higher it hops.
  const lift = Math.max(0.4, 1 - p.z * 1.5);
  ctx.beginPath();
  ctx.ellipse(x, ground + r * 0.75, r * 0.9 * lift, r * 0.35 * lift, 0, 0, Math.PI * 2);
  ctx.fillStyle = theme.shadow;
  ctx.fill();

  if (ringed) {
    ctx.beginPath();
    ctx.arc(x, y, r + cell * (0.09 + 0.035 * Math.sin(pulse * 5)), 0, Math.PI * 2);
    ctx.lineWidth = Math.max(2, cell * 0.05);
    ctx.strokeStyle = rgba(theme.ink, 0.55);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = rgba(color);
  ctx.fill();
  ctx.lineWidth = Math.max(1.5, cell * 0.045);
  ctx.strokeStyle = rgba(theme.page);
  ctx.stroke();

  const look = p.face < 0 ? -1 : 1;
  for (const side of [-1, 1]) {
    const ex = x + side * r * 0.36 + look * r * 0.08;
    const ey = y - r * 0.12;
    ctx.beginPath();
    ctx.arc(ex, ey, r * 0.27, 0, Math.PI * 2);
    ctx.fillStyle = rgba(theme.page);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(ex + look * r * 0.09, ey, r * 0.13, 0, Math.PI * 2);
    ctx.fillStyle = rgba(theme.ink);
    ctx.fill();
  }
}

// After the font has loaded, the numbers are drawn again in it.
export function forgetBoard() {
  backdrop = null;
}
