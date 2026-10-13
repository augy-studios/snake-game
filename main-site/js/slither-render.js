// Draws a Slither world on the full-screen canvas: the floor, the dots,
// every snake in its skin, the arena's rim and the minimap. Positions are
// drawn part way between the last two ticks, so movement is smooth at any
// frame rate. High quality adds outlines, highlights, halos, the hex floor
// and the screen's full pixel density; low quality draws flat shapes only.
//
// No gradients: shading is flat circles laid over each other.

import { ANG, ARENA_R, SUB, cosOf, radiusOf, sinOf } from "./slither-rules.js";
import { PALETTE, colorAt, parseSkin } from "./slither-skins.js";

// Glowing dot colours. Fixed, like the skins: a dot is a dot whatever the theme.
const DOT_HEX = ["#ff5a5a", "#ffb340", "#ffe14d", "#7dff6a", "#3dfcd0", "#4ac8ff", "#7a8cff", "#c47aff", "#ff6ad5", "#ff8a5c", "#b8ff4d", "#ffffff"];

function hexRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const shade = (hex, k) => {
  const [r, g, b] = hexRgb(hex);
  return `rgb(${Math.round(r * k)}, ${Math.round(g * k)}, ${Math.round(b * k)})`;
};
const tint = (hex, k) => {
  const [r, g, b] = hexRgb(hex);
  return `rgb(${Math.round(r + (255 - r) * k)}, ${Math.round(g + (255 - g) * k)}, ${Math.round(b + (255 - b) * k)})`;
};

// Each palette colour's outline and highlight, worked out once.
const SKIN_FILL = PALETTE.map((p) => ({ fill: p.hex, edge: shade(p.hex, 0.62), light: tint(p.hex, 0.45), star: Boolean(p.star) }));

export function readTheme() {
  const cs = getComputedStyle(document.documentElement);
  const get = (n) => cs.getPropertyValue(n).trim();
  return {
    page: get("--page-bg") || "#eef2f0",
    ink: get("--ink") || "#121815",
    error: get("--error") || "#b91c1c",
    brandInk: get("--brand-ink") || "#1f6b3d",
    dark: document.documentElement.getAttribute("data-mode") === "dark",
  };
}

let floorTile = null;
function floorPattern(ctx, theme) {
  const key = `${theme.ink}|${theme.dark}`;
  if (floorTile?.key === key) return floorTile.pattern;
  // One hexagon, 60 px across, repeated.
  const w = 104;
  const h = 60;
  const tile = document.createElement("canvas");
  tile.width = w;
  tile.height = h;
  const t = tile.getContext("2d");
  t.strokeStyle = theme.ink;
  t.globalAlpha = theme.dark ? 0.12 : 0.08;
  t.lineWidth = 2;
  t.beginPath();
  const s = 17.3;
  // A row of hexes: zig-zag tops and verticals, enough to tile.
  t.moveTo(0, 30);
  t.lineTo(s, 0);
  t.lineTo(s + 34.6, 0);
  t.lineTo(2 * s + 34.6, 30);
  t.lineTo(s + 34.6, 60);
  t.lineTo(s, 60);
  t.closePath();
  t.moveTo(2 * s + 34.6, 30);
  t.lineTo(w, 30);
  t.stroke();
  floorTile = { key, pattern: ctx.createPattern(tile, "repeat") };
  return floorTile.pattern;
}

/* ---- The frame ----
   `f` is { world, prev, alpha, camX, camY, zoom, quality, now, me, look,
   theme, w, h, dpr, safe }. `prev` maps a snake's id to its positions a
   tick before; `me` is the snake the camera follows, if any; `look` is
   where its eyes point. */

export function drawWorld(ctx, f) {
  const { w, h, zoom, theme } = f;
  const high = f.quality !== "low";
  const scale = zoom / SUB;
  const ox = w / 2 - f.camX * scale;
  const oy = h / 2 - f.camY * scale;
  const sx = (x) => x * scale + ox;
  const sy = (y) => y * scale + oy;

  ctx.setTransform(f.dpr, 0, 0, f.dpr, 0, 0);
  ctx.fillStyle = theme.page;
  ctx.fillRect(0, 0, w, h);

  // The floor's hexes, fixed to the world so they slide past.
  if (high) {
    const pattern = floorPattern(ctx, theme);
    if (pattern?.setTransform && typeof DOMMatrix === "function") {
      pattern.setTransform(new DOMMatrix([zoom, 0, 0, zoom, ox % (104 * zoom), oy % (60 * zoom)]));
      ctx.fillStyle = pattern;
      ctx.fillRect(0, 0, w, h);
    }
  }

  // Outside the arena: shaded, past a rim in the error colour.
  const ar = ARENA_R * scale;
  ctx.beginPath();
  ctx.rect(0, 0, w, h);
  ctx.arc(sx(0), sy(0), ar, 0, Math.PI * 2, true);
  ctx.fillStyle = theme.dark ? "rgba(0, 0, 0, 0.45)" : "rgba(10, 15, 12, 0.18)";
  ctx.fill("evenodd");
  ctx.beginPath();
  ctx.arc(sx(0), sy(0), ar, 0, Math.PI * 2);
  ctx.strokeStyle = theme.error;
  ctx.lineWidth = Math.max(3, 8 * zoom);
  ctx.stroke();

  // The view, in sub-units, with a margin for anything partly on screen.
  const margin = 80 * SUB;
  const vx0 = f.camX - (w / 2) / scale - margin;
  const vx1 = f.camX + (w / 2) / scale + margin;
  const vy0 = f.camY - (h / 2) / scale - margin;
  const vy1 = f.camY + (h / 2) / scale + margin;
  const inView = (x, y) => x > vx0 && x < vx1 && y > vy0 && y < vy1;

  drawDots(ctx, f, sx, sy, inView, high, zoom);

  // Snakes, the followed one last so it is never under anybody.
  const order = [...f.world.snakes].sort((a, b) => (a.id === f.me) - (b.id === f.me) || a.id - b.id);
  for (const s of order) drawSnake(ctx, f, s, sx, sy, inView, high, zoom);

  drawMinimap(ctx, f);
}

function drawDots(ctx, f, sx, sy, inView, high, zoom) {
  const t = f.now / 1000;
  for (const d of f.world.dots.values()) {
    if (!inView(d.x, d.y)) continue;
    const r = Math.min(18, 4 + d.v * 1.6) * zoom;
    const x = sx(d.x);
    const y = sy(d.y);
    const color = DOT_HEX[d.c % DOT_HEX.length];
    // Each dot shimmers on its own beat, and big ones pulse in size too.
    const beat = Math.sin(t * 3.2 + d.id * 1.7);
    ctx.fillStyle = color;
    if (high) {
      ctx.globalAlpha = 0.14 + 0.1 * beat;
      ctx.beginPath();
      ctx.arc(x, y, r * (2.3 + (d.v > 3 ? 0.4 * beat : 0)), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = high ? 0.75 + 0.25 * beat : 0.9;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function drawSnake(ctx, f, s, sx, sy, inView, high, zoom) {
  if (!s.xs.length) return;
  const prev = f.prev?.get(s.id);
  const a = f.alpha;
  const px = (i) => (prev && i < prev.xs.length ? prev.xs[i] + (s.xs[i] - prev.xs[i]) * a : s.xs[i]);
  const py = (i) => (prev && i < prev.ys.length ? prev.ys[i] + (s.ys[i] - prev.ys[i]) * a : s.ys[i]);
  const skin = parseSkin(s.skin);
  const r = (radiusOf(s.mass) / SUB) * zoom;
  const fading = !s.alive;
  if (fading) ctx.globalAlpha = 0.35;

  // A boost lights the body up with a flat glow.
  if (high && s.boosting && s.alive) {
    ctx.fillStyle = SKIN_FILL[skin.colors[0]].light;
    ctx.globalAlpha = 0.22;
    for (let i = s.xs.length - 1; i >= 0; i -= 2) {
      if (!inView(s.xs[i], s.ys[i])) continue;
      ctx.beginPath();
      ctx.arc(sx(px(i)), sy(py(i)), r * 1.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  for (let i = s.xs.length - 1; i >= 0; i -= 1) {
    if (!inView(s.xs[i], s.ys[i])) continue;
    const c = SKIN_FILL[colorAt(skin, i)];
    const x = sx(px(i));
    const y = sy(py(i));
    if (high) {
      ctx.fillStyle = c.edge;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = c.fill;
      ctx.beginPath();
      ctx.arc(x, y, r * 0.84, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = c.light;
      ctx.globalAlpha = (fading ? 0.35 : 1) * 0.5;
      ctx.beginPath();
      ctx.arc(x - r * 0.25, y - r * 0.3, r * 0.3, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = fading ? 0.35 : 1;
      if (c.star && i % 3 === 1) drawStar(ctx, x, y, r * 0.42);
      if (skin.pattern === "d" && i % 3 === 0) {
        ctx.fillStyle = c.edge;
        ctx.beginPath();
        ctx.arc(x + r * 0.2, y + r * 0.15, r * 0.28, 0, Math.PI * 2);
        ctx.fill();
      }
    } else {
      ctx.fillStyle = c.fill;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // The head: eyes on the way it is going, the pupils on where it is
  // steering; then the outfit and the name.
  const hx = sx(px(0));
  const hy = sy(py(0));
  if (inView(s.xs[0], s.ys[0])) {
    const ang = (s.angle / ANG) * Math.PI * 2;
    const look = s.id === f.me && f.look != null ? f.look : (s.target / ANG) * Math.PI * 2;
    const fx = Math.cos(ang);
    const fy = Math.sin(ang);
    for (const k of [-1, 1]) {
      const ex = hx + fx * r * 0.35 - fy * r * 0.45 * k;
      const ey = hy + fy * r * 0.35 + fx * r * 0.45 * k;
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.arc(ex, ey, r * 0.36, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#111111";
      ctx.beginPath();
      ctx.arc(ex + Math.cos(look) * r * 0.14, ey + Math.sin(look) * r * 0.14, r * 0.2, 0, Math.PI * 2);
      ctx.fill();
    }
    drawOutfit(ctx, skin.outfit, hx, hy, r, ang, high);
    if (s.id !== f.me && s.alive) {
      ctx.globalAlpha = 0.85;
      ctx.fillStyle = f.theme.ink;
      ctx.font = `${Math.max(11, 13 * Math.min(1, zoom + 0.2))}px Jua, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillText(s.name, hx, hy + r + 6);
      ctx.globalAlpha = 1;
    }
  }
  ctx.globalAlpha = 1;
}

function drawStar(ctx, x, y, r) {
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  for (let k = 0; k < 10; k += 1) {
    const a = -Math.PI / 2 + (k * Math.PI) / 5;
    const rr = k % 2 ? r * 0.45 : r;
    ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  ctx.closePath();
  ctx.fill();
}

// Outfits sit upright on the head, whichever way it faces, except shades,
// which go over the eyes.
export function drawOutfit(ctx, outfit, x, y, r, ang, high = true) {
  if (outfit === "none") return;
  ctx.save();
  ctx.lineJoin = "round";
  const edge = (c) => {
    if (!high) return;
    ctx.strokeStyle = c;
    ctx.lineWidth = Math.max(1, r * 0.08);
    ctx.stroke();
  };
  if (outfit === "crown") {
    const top = y - r * 1.55;
    const base = y - r * 0.7;
    const half = r * 0.75;
    ctx.beginPath();
    ctx.moveTo(x - half, base);
    ctx.lineTo(x - half, top + r * 0.3);
    ctx.lineTo(x - half * 0.5, top + r * 0.55);
    ctx.lineTo(x, top);
    ctx.lineTo(x + half * 0.5, top + r * 0.55);
    ctx.lineTo(x + half, top + r * 0.3);
    ctx.lineTo(x + half, base);
    ctx.closePath();
    ctx.fillStyle = "#f2c230";
    ctx.fill();
    edge("#a67c00");
  } else if (outfit === "party") {
    ctx.beginPath();
    ctx.moveTo(x - r * 0.6, y - r * 0.65);
    ctx.lineTo(x + r * 0.6, y - r * 0.65);
    ctx.lineTo(x, y - r * 2.1);
    ctx.closePath();
    ctx.fillStyle = "#ff5aa8";
    ctx.fill();
    edge("#b0306c");
    ctx.fillStyle = "#ffe14d";
    ctx.beginPath();
    ctx.arc(x, y - r * 2.1, r * 0.22, 0, Math.PI * 2);
    ctx.fill();
  } else if (outfit === "tophat") {
    ctx.fillStyle = "#1c1c22";
    ctx.beginPath();
    ctx.rect(x - r * 0.95, y - r * 0.85, r * 1.9, r * 0.28);
    ctx.rect(x - r * 0.6, y - r * 2.0, r * 1.2, r * 1.2);
    ctx.fill();
    ctx.fillStyle = "#d03238";
    ctx.fillRect(x - r * 0.6, y - r * 1.08, r * 1.2, r * 0.22);
  } else if (outfit === "bow") {
    const bx = x + r * 0.55;
    const by = y - r * 0.75;
    ctx.fillStyle = "#ff4d8d";
    ctx.beginPath();
    ctx.moveTo(bx, by);
    ctx.lineTo(bx - r * 0.7, by - r * 0.4);
    ctx.lineTo(bx - r * 0.7, by + r * 0.4);
    ctx.closePath();
    ctx.moveTo(bx, by);
    ctx.lineTo(bx + r * 0.7, by - r * 0.4);
    ctx.lineTo(bx + r * 0.7, by + r * 0.4);
    ctx.closePath();
    ctx.fill();
    edge("#a8245a");
    ctx.beginPath();
    ctx.arc(bx, by, r * 0.18, 0, Math.PI * 2);
    ctx.fill();
  } else if (outfit === "shades") {
    const fx = Math.cos(ang);
    const fy = Math.sin(ang);
    ctx.fillStyle = "#111111";
    for (const k of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(x + fx * r * 0.4 - fy * r * 0.45 * k, y + fy * r * 0.4 + fx * r * 0.45 * k, r * 0.4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.strokeStyle = "#111111";
    ctx.lineWidth = Math.max(1.5, r * 0.12);
    ctx.beginPath();
    ctx.moveTo(x + fx * r * 0.4 - fy * r * 0.45, y + fy * r * 0.4 + fx * r * 0.45);
    ctx.lineTo(x + fx * r * 0.4 + fy * r * 0.45, y + fy * r * 0.4 - fx * r * 0.45);
    ctx.stroke();
  } else if (outfit === "halo") {
    ctx.strokeStyle = "#ffe14d";
    ctx.lineWidth = Math.max(2, r * 0.18);
    ctx.beginPath();
    ctx.ellipse(x, y - r * 1.45, r * 0.75, r * 0.25, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

function drawMinimap(ctx, f) {
  if (f.hideMinimap) return;
  const size = f.w < 520 ? 46 : 60;
  const cx = f.w - size - 14 - (f.safe?.right ?? 0);
  const cy = f.h - size - 14 - (f.safe?.bottom ?? 0);
  // Solid underneath, so nothing in the world shows through the map.
  ctx.beginPath();
  ctx.arc(cx, cy, size, 0, Math.PI * 2);
  ctx.fillStyle = f.theme.page;
  ctx.globalAlpha = 0.92;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.fillStyle = f.theme.dark ? "rgba(255, 255, 255, 0.08)" : "rgba(10, 15, 12, 0.08)";
  ctx.fill();
  ctx.strokeStyle = f.theme.error;
  ctx.lineWidth = 2;
  ctx.stroke();
  const k = size / ARENA_R;
  for (const s of f.world.snakes) {
    if (!s.alive) continue;
    const mine = s.id === f.me;
    ctx.fillStyle = mine ? f.theme.brandInk : f.theme.ink;
    ctx.globalAlpha = mine ? 1 : 0.45;
    ctx.beginPath();
    ctx.arc(cx + s.xs[0] * k, cy + s.ys[0] * k, mine ? 3.5 : Math.min(3, 1.2 + s.mass / 400), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

// A snake laid out flat, for the skin picker's preview.
export function drawPreview(ctx, w, h, code) {
  const skin = parseSkin(code);
  ctx.clearRect(0, 0, w, h);
  const r = Math.min(h * 0.28, 22);
  const n = Math.max(8, Math.floor((w - r * 4) / (r * 0.75)));
  for (let i = n - 1; i >= 0; i -= 1) {
    const x = w - r * 2 - i * r * 0.75;
    const y = h * 0.58 + Math.sin(i * 0.45) * r * 0.5;
    const c = SKIN_FILL[colorAt(skin, i)];
    ctx.fillStyle = c.edge;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = c.fill;
    ctx.beginPath();
    ctx.arc(x, y, r * 0.84, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = c.light;
    ctx.globalAlpha = 0.5;
    ctx.beginPath();
    ctx.arc(x - r * 0.25, y - r * 0.3, r * 0.3, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    if (c.star && i % 3 === 1) drawStar(ctx, x, y, r * 0.42);
    if (skin.pattern === "d" && i % 3 === 0) {
      ctx.fillStyle = c.edge;
      ctx.beginPath();
      ctx.arc(x + r * 0.2, y + r * 0.15, r * 0.28, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  const hx = w - r * 2;
  const hy = h * 0.58;
  for (const k of [-1, 1]) {
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(hx + r * 0.35, hy + r * 0.45 * k, r * 0.36, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#111111";
    ctx.beginPath();
    ctx.arc(hx + r * 0.49, hy + r * 0.45 * k, r * 0.2, 0, Math.PI * 2);
    ctx.fill();
  }
  drawOutfit(ctx, skin.outfit, hx, hy, r, 0, true);
}

export { cosOf, sinOf };
