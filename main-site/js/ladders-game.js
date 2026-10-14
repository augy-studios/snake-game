// Snakes and Ladders board game for 2-4 players.
// Self-contained module rendering on <canvas id="laddersBoard"> with HUD and game-over overlay.

import { hydrateIcons, escapeHtml } from "./ui.js";
import { icon } from "./icons.js";
import { getSettings } from "./settings.js";
import { fitForSnake } from "./wordfilter.js";

// Board definition: 10x10 grid, 1 to 100
const BOARD_DIM = 10;
const TOTAL_SQUARES = 100;

// Player tokens and colors
const PLAYER_COLORS = ["#e74c3c", "#3498db", "#2ecc71", "#f39c12"];
const PLAYER_NAMES = ["Player 1", "Player 2", "Player 3", "Player 4"];
const FALLBACK_BOT_NAMES = ["Snek", "Ziggy", "Augy"];

// Random bot names loaded from wordlist.json
let wordlistNames = null;
let wordlistPromise = null;

function loadBotNames() {
  if (wordlistNames) return Promise.resolve(wordlistNames);
  wordlistPromise ??= fetch("/wordlist.json")
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => {
      const words = Array.isArray(data?.words) ? data.words : Object.values(data ?? {}).flat();
      const filtered = words
        .filter((w) => typeof w === "string" && fitForSnake(w))
        .map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
      wordlistNames = filtered.length > 0 ? filtered : null;
      return wordlistNames;
    })
    .catch(() => {
      wordlistPromise = null;
      return null;
    });
  return wordlistPromise;
}

// Preload wordlist for instant bot naming
loadBotNames();

function getRandomBotNames(count = 3) {
  const chosen = [];
  const pool = wordlistNames && wordlistNames.length >= count ? wordlistNames : FALLBACK_BOT_NAMES;
  const used = new Set();

  for (let i = 0; i < count; i++) {
    let name;
    let attempts = 0;
    do {
      const idx = Math.floor(Math.random() * pool.length);
      name = pool === FALLBACK_BOT_NAMES ? pool[i % pool.length] : pool[idx];
      attempts++;
    } while (used.has(name) && attempts < 50);

    used.add(name);
    chosen.push(`Bot ${name}`);
  }
  return chosen;
}

// Classic board positions
const LADDERS = {
  2: 38,
  7: 14,
  8: 31,
  15: 26,
  21: 42,
  28: 84,
  36: 44,
  51: 67,
  71: 91,
  78: 98,
  87: 94,
};

const SNAKES = {
  16: 6,
  46: 25,
  49: 11,
  62: 19,
  64: 60,
  74: 53,
  89: 68,
  92: 88,
  95: 75,
  99: 80,
};

// Timing constants (ms)
const HOP_STEP_MS = 150;
const SLIDE_MS = 450;
const ROLL_DURATION_MS = 450;
const BANNER_DURATION_MS = 1500;

function injectStylesOnce() {
  if (document.getElementById("laddersStyles")) return;
  const style = document.createElement("style");
  style.id = "laddersStyles";
  style.textContent = `
    #laddersBoard {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      z-index: 1;
      touch-action: none;
    }
    body.ladders-playing #laddersBoard {
      display: block;
    }
    body:not(.ladders-playing) #laddersBoard {
      display: none !important;
    }
    body.ladders-playing #board,
    body.ladders-playing #world,
    body.ladders-playing #hudStats,
    body.ladders-playing .tool-dock,
    body.ladders-playing #stageNote {
      display: none !important;
    }
    @keyframes dice-shake {
      0% { transform: translateX(-50%) rotate(0deg); }
      20% { transform: translateX(-50%) rotate(-12deg) scale(1.04); }
      40% { transform: translateX(-50%) rotate(10deg) scale(1.04); }
      60% { transform: translateX(-50%) rotate(-8deg) scale(1.02); }
      80% { transform: translateX(-50%) rotate(6deg) scale(1.02); }
      100% { transform: translateX(-50%) rotate(0deg); }
    }
    .dice-rolling {
      animation: dice-shake 0.14s infinite linear !important;
      pointer-events: none;
    }
  `;
  document.head.appendChild(style);
}

// Canvas rounded rectangle helper
function roundRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

/**
 * Calculates hop path for moving forward with potential bounce-back at 100.
 */
function calculateHopPath(startPos, roll) {
  const path = [];
  let cur = startPos;
  let forward = true;
  for (let i = 0; i < roll; i++) {
    if (forward) {
      cur++;
      if (cur === TOTAL_SQUARES) {
        forward = false;
      }
    } else {
      cur--;
    }
    path.push(cur);
  }
  return path;
}

export function initLadders(deps = {}) {
  const { showStart } = deps;
  injectStylesOnce();

  // Ensure DOM elements exist and return them
  function getElements() {
    let canvas = document.getElementById("laddersBoard");
    if (!canvas) {
      canvas = document.createElement("canvas");
      canvas.id = "laddersBoard";
      canvas.className = "ladders-board";
      canvas.setAttribute("role", "img");
      canvas.setAttribute("aria-label", "The Snakes and Ladders board");
      canvas.hidden = true;
      const stage = document.getElementById("stage") || document.body;
      stage.appendChild(canvas);
    }

    let hud = document.getElementById("laddersHud");
    if (!hud) {
      hud = document.createElement("div");
      hud.id = "laddersHud";
      hud.className = "ladders-hud glass";
      hud.hidden = true;
      hud.innerHTML = `<span id="currentPlayer"></span>`;
      const stage = document.getElementById("stage") || document.body;
      stage.appendChild(hud);
    }

    let rollBtn = document.getElementById("rollBtn");
    if (!rollBtn) {
      rollBtn = document.createElement("button");
      rollBtn.id = "rollBtn";
      rollBtn.className = "roll-btn";
      rollBtn.type = "button";
      rollBtn.textContent = "Roll Dice";
      rollBtn.hidden = true;
      const stage = document.getElementById("stage") || document.body;
      stage.appendChild(rollBtn);
    }

    let diceResult = document.getElementById("diceResult");
    if (!diceResult) {
      diceResult = document.createElement("span");
      diceResult.id = "diceResult";
      diceResult.className = "dice-result";
      diceResult.hidden = true;
      const stage = document.getElementById("stage") || document.body;
      stage.appendChild(diceResult);
    }

    const over = document.getElementById("laddersOver");
    const currentPlayer = document.getElementById("currentPlayer");
    const againBtn = document.getElementById("laddersAgainBtn");
    const leaveBtn = document.getElementById("laddersLeaveBtn");

    return {
      canvas,
      hud,
      over,
      rollBtn,
      diceResult,
      currentPlayer,
      againBtn,
      leaveBtn,
    };
  }

  const elementsInit = getElements();
  const canvas = elementsInit.canvas;
  const ctx = canvas.getContext("2d", { desynchronized: true }) ?? canvas.getContext("2d");

  // Game state
  let active = false;
  let isPaused = false;
  let isSoloGame = false;
  let botTimeoutId = null;
  let numPlayers = 2;
  let players = [];
  let currentPlayerIndex = 0;
  let diceValue = null;
  let isRolling = false;
  let isMoving = false;
  let winner = null;
  let dirty = true;
  let rafId = null;

  // Animation and visual effects state
  let animState = null;
  let banner = null;
  let toastTimeout = null;
  let particles = [];
  let dieCycleValue = 1;

  // Layout metrics
  let canvasWidth = 0;
  let canvasHeight = 0;
  let boardSize = 0;
  let boardX = 0;
  let boardY = 0;
  let cellSize = 0;
  let dpr = 1;

  // Die click hit-box
  let dieRect = { x: 0, y: 0, w: 0, h: 0 };

  function getThemeColors() {
    const isDark = document.documentElement.getAttribute("data-mode") === "dark";
    const styles = getComputedStyle(document.documentElement);
    const ink = styles.getPropertyValue("--ink").trim() || (isDark ? "#eef2ef" : "#121815");
    const surface = styles.getPropertyValue("--surface").trim() || "rgba(255, 255, 255, 0.55)";
    const surfaceStrong = styles.getPropertyValue("--surface-strong").trim() || "rgba(255, 255, 255, 0.78)";
    const surfaceBorder = styles.getPropertyValue("--surface-border").trim() || "rgba(255, 255, 255, 0.65)";
    const brandFill = styles.getPropertyValue("--brand-fill").trim() || "#ccffcc";
    const onBrand = styles.getPropertyValue("--on-brand").trim() || "#121815";

    // Board square colors
    const lightSquare = isDark ? "#2d261e" : "#f5e6c8";
    const darkSquare = isDark ? "#201a14" : "#d4a574";
    const squareNumberColor = isDark ? "rgba(235, 225, 210, 0.65)" : "rgba(92, 58, 24, 0.65)";
    const boardBorder = isDark ? "#3f3326" : "#8c5e31";

    return {
      isDark,
      ink,
      surface,
      surfaceStrong,
      surfaceBorder,
      brandFill,
      onBrand,
      lightSquare,
      darkSquare,
      squareNumberColor,
      boardBorder,
    };
  }

  /**
   * Converts square number (1-100, or 0 for off-board) to canvas pixel center coordinates.
   */
  function squareToXY(sq) {
    if (sq <= 0) {
      // Off-board starting zone
      if (canvasWidth > canvasHeight + 70) {
        // Landscape: dock on the left of square 1
        return {
          x: Math.max(cellSize * 0.45, boardX - cellSize * 0.65),
          y: boardY + 9.5 * cellSize,
        };
      } else {
        // Portrait: dock just below square 1
        return {
          x: boardX + 0.5 * cellSize,
          y: Math.min(canvasHeight - cellSize * 0.45, boardY + boardSize + cellSize * 0.5),
        };
      }
    }

    const clamped = Math.max(1, Math.min(TOTAL_SQUARES, sq));
    const rowFromBottom = Math.floor((clamped - 1) / BOARD_DIM); // 0..9
    const rowFromTop = BOARD_DIM - 1 - rowFromBottom; // 0..9 (0 is top row)
    const col = rowFromBottom % 2 === 0
      ? (clamped - 1) % BOARD_DIM
      : BOARD_DIM - 1 - ((clamped - 1) % BOARD_DIM);

    return {
      x: boardX + (col + 0.5) * cellSize,
      y: boardY + (rowFromTop + 0.5) * cellSize,
      col,
      row: rowFromTop,
    };
  }

  /**
   * Calculates position and offset for tokens, handling multiple tokens on the same square.
   */
  function getTokenDrawPos(player, now) {
    if (animState && animState.player && animState.player.id === player.id) {
      return {
        x: animState.currentX,
        y: animState.currentY + (animState.jumpY || 0),
        r: cellSize * 0.26,
        isJumping: Boolean(animState.jumpY && Math.abs(animState.jumpY) > 1),
        groundX: animState.currentX,
        groundY: animState.currentY,
      };
    }

    // Static placement with group offset
    const group = players.filter((p) => {
      if (animState && animState.player && animState.player.id === p.id) return false;
      return p.pos === player.pos;
    });

    const indexInGroup = group.indexOf(player);
    const count = group.length;
    const base = squareToXY(player.pos);

    let offsetX = 0;
    let offsetY = 0;
    let r = cellSize * 0.24;

    if (count === 2) {
      const spread = cellSize * 0.16;
      offsetX = indexInGroup === 0 ? -spread : spread;
      offsetY = indexInGroup === 0 ? -spread : spread;
      r = cellSize * 0.20;
    } else if (count === 3) {
      const spread = cellSize * 0.18;
      const angle = (indexInGroup * 2 * Math.PI) / 3 - Math.PI / 2;
      offsetX = Math.cos(angle) * spread;
      offsetY = Math.sin(angle) * spread;
      r = cellSize * 0.18;
    } else if (count >= 4) {
      const spread = cellSize * 0.16;
      const offsets = [
        [-spread, -spread],
        [spread, -spread],
        [-spread, spread],
        [spread, spread],
      ];
      const off = offsets[indexInGroup % 4];
      offsetX = off[0];
      offsetY = off[1];
      r = cellSize * 0.17;
    }

    return {
      x: base.x + offsetX,
      y: base.y + offsetY,
      r,
      isJumping: false,
      groundX: base.x + offsetX,
      groundY: base.y + offsetY,
    };
  }

  function queueLayout() {
    requestAnimationFrame(() => layout());
  }

  function layout() {
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const width = rect.width || window.innerWidth;
    const height = rect.height || window.innerHeight;
    dpr = window.devicePixelRatio || 1;

    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);

    canvasWidth = width;
    canvasHeight = height;

    const isLandscape = width > height + 70;
    if (isLandscape) {
      boardSize = Math.max(180, Math.min(height - 36, width - 150));
      boardX = Math.round((width - boardSize) / 2);
      boardY = Math.round((height - boardSize) / 2);
    } else {
      boardSize = Math.max(180, Math.min(width - 24, height - 130));
      boardX = Math.round((width - boardSize) / 2);
      boardY = Math.max(16, Math.round((height - 100 - boardSize) / 2));
    }
    cellSize = boardSize / BOARD_DIM;

    // Position canvas die
    const dieSize = Math.max(48, Math.min(64, cellSize * 1.05));
    if (isLandscape) {
      dieRect = {
        x: boardX + boardSize + Math.max(16, (width - (boardX + boardSize) - dieSize) / 2),
        y: height / 2 - dieSize / 2,
        w: dieSize,
        h: dieSize,
      };
    } else {
      dieRect = {
        x: width / 2 - dieSize / 2,
        y: Math.min(height - dieSize - 12, boardY + boardSize + Math.max(12, (height - (boardY + boardSize) - dieSize) / 2)),
        w: dieSize,
        h: dieSize,
      };
    }

    requestRender();
  }

  function drawBoard(theme) {
    // Outer wooden frame / shadow
    ctx.save();
    ctx.shadowColor = "rgba(0, 0, 0, 0.25)";
    ctx.shadowBlur = 18;
    ctx.shadowOffsetY = 6;
    ctx.fillStyle = theme.boardBorder;
    const framePad = Math.max(6, Math.round(cellSize * 0.12));
    roundRect(ctx, boardX - framePad, boardY - framePad, boardSize + framePad * 2, boardSize + framePad * 2, 14);
    ctx.fill();
    ctx.restore();

    // Board squares (10x10)
    for (let sq = 1; sq <= TOTAL_SQUARES; sq++) {
      const pos = squareToXY(sq);
      const rowFromBottom = Math.floor((sq - 1) / BOARD_DIM);
      const isEven = (pos.col + rowFromBottom) % 2 === 0;

      const cellX = boardX + pos.col * cellSize;
      const cellY = boardY + pos.row * cellSize;

      ctx.fillStyle = isEven ? theme.lightSquare : theme.darkSquare;
      ctx.fillRect(cellX, cellY, cellSize, cellSize);

      // Accent square 1 (Start) and square 100 (Goal)
      if (sq === 1) {
        ctx.fillStyle = theme.isDark ? "rgba(46, 204, 113, 0.22)" : "rgba(46, 204, 113, 0.28)";
        ctx.fillRect(cellX, cellY, cellSize, cellSize);
      } else if (sq === 100) {
        ctx.fillStyle = theme.isDark ? "rgba(241, 196, 15, 0.28)" : "rgba(241, 196, 15, 0.35)";
        ctx.fillRect(cellX, cellY, cellSize, cellSize);
      }

      // Square numbers in zigzag pattern
      ctx.fillStyle = theme.squareNumberColor;
      const fontSize = Math.max(9, Math.round(cellSize * 0.24));
      ctx.font = `bold ${fontSize}px "Jua", sans-serif`;
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      const pad = Math.max(3, Math.round(cellSize * 0.08));
      ctx.fillText(String(sq), cellX + pad, cellY + pad);

      // Goal star/crown badge
      if (sq === 100) {
        ctx.fillStyle = "#f39c12";
        ctx.font = `${Math.round(cellSize * 0.34)}px "Jua", sans-serif`;
        ctx.textAlign = "right";
        ctx.textBaseline = "top";
        ctx.fillText("⭐", cellX + cellSize - pad, cellY + pad);
      }
    }

    // Grid lines for crisp definition
    ctx.strokeStyle = theme.isDark ? "rgba(255, 255, 255, 0.05)" : "rgba(0, 0, 0, 0.07)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i <= BOARD_DIM; i++) {
      const x = boardX + i * cellSize;
      const y = boardY + i * cellSize;
      ctx.moveTo(x, boardY);
      ctx.lineTo(x, boardY + boardSize);
      ctx.moveTo(boardX, y);
      ctx.lineTo(boardX + boardSize, y);
    }
    ctx.stroke();

    // Off-board Start dock indicator
    const startZone = squareToXY(0);
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = theme.squareNumberColor;
    ctx.lineWidth = 1.5;
    ctx.fillStyle = theme.isDark ? "rgba(255, 255, 255, 0.04)" : "rgba(0, 0, 0, 0.04)";
    ctx.beginPath();
    ctx.arc(startZone.x, startZone.y, cellSize * 0.36, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.setLineDash([]);
    ctx.fillStyle = theme.squareNumberColor;
    ctx.font = `bold ${Math.max(9, Math.round(cellSize * 0.18))}px "Jua", sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("START", startZone.x, startZone.y);
    ctx.restore();
  }

  function drawLadders() {
    for (const [startStr, endStr] of Object.entries(LADDERS)) {
      const startSq = Number(startStr);
      const endSq = Number(endStr);
      const p1 = squareToXY(startSq);
      const p2 = squareToXY(endSq);

      const dx = p2.x - p1.x;
      const dy = p2.y - p1.y;
      const len = Math.hypot(dx, dy);
      if (len < 1) continue;

      const nx = -dy / len;
      const ny = dx / len;
      const railSep = cellSize * 0.22;
      const halfSep = railSep / 2;

      // Drop shadow
      ctx.save();
      ctx.strokeStyle = "rgba(0, 0, 0, 0.22)";
      ctx.lineWidth = Math.max(3, cellSize * 0.07);
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(p1.x + nx * halfSep + 3, p1.y + ny * halfSep + 4);
      ctx.lineTo(p2.x + nx * halfSep + 3, p2.y + ny * halfSep + 4);
      ctx.moveTo(p1.x - nx * halfSep + 3, p1.y - ny * halfSep + 4);
      ctx.lineTo(p2.x - nx * halfSep + 3, p2.y - ny * halfSep + 4);

      const numRungs = Math.max(3, Math.floor(len / (cellSize * 0.28)));
      for (let i = 1; i < numRungs; i++) {
        const t = i / numRungs;
        const rx = p1.x + dx * t + 3;
        const ry = p1.y + dy * t + 4;
        ctx.moveTo(rx + nx * halfSep, ry + ny * halfSep);
        ctx.lineTo(rx - nx * halfSep, ry - ny * halfSep);
      }
      ctx.stroke();
      ctx.restore();

      // Rails
      ctx.save();
      ctx.lineCap = "round";

      // Outer rail stroke
      ctx.strokeStyle = "#8b5a2b";
      ctx.lineWidth = Math.max(3.5, cellSize * 0.08);
      ctx.beginPath();
      ctx.moveTo(p1.x + nx * halfSep, p1.y + ny * halfSep);
      ctx.lineTo(p2.x + nx * halfSep, p2.y + ny * halfSep);
      ctx.moveTo(p1.x - nx * halfSep, p1.y - ny * halfSep);
      ctx.lineTo(p2.x - nx * halfSep, p2.y - ny * halfSep);
      ctx.stroke();

      // Inner golden highlight
      ctx.strokeStyle = "#f3c27e";
      ctx.lineWidth = Math.max(1.5, cellSize * 0.032);
      ctx.stroke();

      // Rungs
      for (let i = 1; i < numRungs; i++) {
        const t = i / numRungs;
        const rx = p1.x + dx * t;
        const ry = p1.y + dy * t;

        ctx.strokeStyle = "#6d4118";
        ctx.lineWidth = Math.max(2.8, cellSize * 0.065);
        ctx.beginPath();
        ctx.moveTo(rx + nx * halfSep, ry + ny * halfSep);
        ctx.lineTo(rx - nx * halfSep, ry - ny * halfSep);
        ctx.stroke();

        ctx.strokeStyle = "#f7d6a5";
        ctx.lineWidth = Math.max(1, cellSize * 0.024);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  function drawSnakes() {
    let snakeIndex = 0;
    for (const [headStr, tailStr] of Object.entries(SNAKES)) {
      snakeIndex++;
      const headSq = Number(headStr);
      const tailSq = Number(tailStr);
      const p1 = squareToXY(headSq); // Head
      const p2 = squareToXY(tailSq); // Tail

      const dx = p2.x - p1.x;
      const dy = p2.y - p1.y;
      const len = Math.hypot(dx, dy);
      if (len < 1) continue;

      const nx = -dy / len;
      const ny = dx / len;

      const waves = Math.max(1.4, Math.min(3.2, len / (cellSize * 1.6)));
      const amp = Math.min(cellSize * 0.42, len * 0.22);
      const numPoints = 28;
      const points = [];

      for (let i = 0; i <= numPoints; i++) {
        const t = i / numPoints;
        const wave = Math.sin(t * Math.PI * waves) * amp * (1 - t * 0.35);
        points.push({
          x: p1.x + dx * t + nx * wave,
          y: p1.y + dy * t + ny * wave,
          t,
        });
      }

      // Drop shadow
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(points[0].x + 3, points[0].y + 4);
      for (let i = 1; i < points.length; i++) {
        ctx.lineTo(points[i].x + 3, points[i].y + 4);
      }
      ctx.strokeStyle = "rgba(0, 0, 0, 0.25)";
      ctx.lineWidth = cellSize * 0.22;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.stroke();
      ctx.restore();

      // Snake body gradient: head is crimson/amber, body emerald, tail teal
      const grad = ctx.createLinearGradient(p1.x, p1.y, p2.x, p2.y);
      if (snakeIndex % 2 === 0) {
        grad.addColorStop(0, "#e74c3c");
        grad.addColorStop(0.35, "#e67e22");
        grad.addColorStop(0.7, "#27ae60");
        grad.addColorStop(1, "#16a085");
      } else {
        grad.addColorStop(0, "#c0392b");
        grad.addColorStop(0.4, "#27ae60");
        grad.addColorStop(0.75, "#2ecc71");
        grad.addColorStop(1, "#f39c12");
      }

      ctx.save();
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.strokeStyle = grad;
      ctx.lineWidth = cellSize * 0.24;

      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i++) {
        ctx.lineTo(points[i].x, points[i].y);
      }
      ctx.stroke();

      // Inner highlight belly line
      ctx.strokeStyle = "rgba(255, 255, 255, 0.35)";
      ctx.lineWidth = cellSize * 0.07;
      ctx.stroke();

      // Head rendering at points[0]
      const hdx = points[0].x - points[1].x;
      const hdy = points[0].y - points[1].y;
      const headAngle = Math.atan2(hdy, hdx);

      ctx.translate(points[0].x, points[0].y);
      ctx.rotate(headAngle);

      // Flicking tongue
      ctx.strokeStyle = "#e74c3c";
      ctx.lineWidth = Math.max(1.5, cellSize * 0.04);
      ctx.beginPath();
      ctx.moveTo(cellSize * 0.14, 0);
      ctx.lineTo(cellSize * 0.32, 0);
      ctx.lineTo(cellSize * 0.38, -cellSize * 0.05);
      ctx.moveTo(cellSize * 0.32, 0);
      ctx.lineTo(cellSize * 0.38, cellSize * 0.05);
      ctx.stroke();

      // Serpent head
      ctx.fillStyle = snakeIndex % 2 === 0 ? "#c0392b" : "#b03a2e";
      ctx.beginPath();
      ctx.ellipse(0, 0, cellSize * 0.19, cellSize * 0.14, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(0, 0, 0, 0.25)";
      ctx.lineWidth = 1.2;
      ctx.stroke();

      // Eyes
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.arc(cellSize * 0.06, -cellSize * 0.075, cellSize * 0.046, 0, Math.PI * 2);
      ctx.arc(cellSize * 0.06, cellSize * 0.075, cellSize * 0.046, 0, Math.PI * 2);
      ctx.fill();

      // Pupils
      ctx.fillStyle = "#111111";
      ctx.beginPath();
      ctx.arc(cellSize * 0.075, -cellSize * 0.075, cellSize * 0.024, 0, Math.PI * 2);
      ctx.arc(cellSize * 0.075, cellSize * 0.075, cellSize * 0.024, 0, Math.PI * 2);
      ctx.fill();

      ctx.restore();
    }
  }

  function drawTokens(now) {
    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      const token = getTokenDrawPos(p, now);

      ctx.save();
      // Drop shadow
      ctx.shadowColor = "rgba(0, 0, 0, 0.35)";
      ctx.shadowBlur = token.isJumping ? 14 : 7;
      ctx.shadowOffsetY = token.isJumping ? 10 : 3;

      // Token disc
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(token.x, token.y, token.r, 0, Math.PI * 2);
      ctx.fill();

      // Token white border
      ctx.shadowColor = "transparent";
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = Math.max(1.8, token.r * 0.15);
      ctx.stroke();

      // Inner sheen
      const grad = ctx.createRadialGradient(
        token.x - token.r * 0.3,
        token.y - token.r * 0.3,
        1,
        token.x,
        token.y,
        token.r
      );
      grad.addColorStop(0, "rgba(255, 255, 255, 0.45)");
      grad.addColorStop(0.6, "rgba(255, 255, 255, 0)");
      grad.addColorStop(1, "rgba(0, 0, 0, 0.2)");
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(token.x, token.y, token.r, 0, Math.PI * 2);
      ctx.fill();

      // Player number
      ctx.fillStyle = "#ffffff";
      ctx.font = `bold ${Math.max(10, Math.round(token.r * 1.05))}px "Jua", sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(p.id + 1), token.x, token.y);

      // Active turn indicator halo
      if (currentPlayerIndex === p.id && !winner && (!animState || animState.player?.id === p.id)) {
        ctx.strokeStyle = p.color;
        ctx.lineWidth = 2.5;
        const pulse = 1 + Math.sin(now / 150) * 0.15;
        ctx.beginPath();
        ctx.arc(token.x, token.y, token.r * 1.35 * pulse, 0, Math.PI * 2);
        ctx.stroke();
      }

      ctx.restore();
    }
  }

  function drawDie(theme, now) {
    if (dieRect.w <= 0) return;
    const { x, y, w, h } = dieRect;
    const currentP = players[currentPlayerIndex];

    ctx.save();
    // Glass card backdrop
    ctx.fillStyle = theme.surfaceStrong;
    ctx.strokeStyle = theme.surfaceBorder;
    ctx.lineWidth = 1;
    roundRect(ctx, x - 10, y - 8, w + 20, h + 28, 14);
    ctx.fill();
    ctx.stroke();

    // Die shake animation
    let shakeX = 0;
    let shakeY = 0;
    let shakeAngle = 0;

    if (isRolling) {
      shakeX = (Math.random() - 0.5) * 6;
      shakeY = (Math.random() - 0.5) * 6;
      shakeAngle = (Math.random() - 0.5) * 0.25;
    }

    ctx.translate(x + w / 2 + shakeX, y + h / 2 + shakeY);
    ctx.rotate(shakeAngle);

    // Die rounded rectangle body
    ctx.shadowColor = "rgba(0, 0, 0, 0.25)";
    ctx.shadowBlur = 10;
    ctx.shadowOffsetY = 4;
    ctx.fillStyle = "#ffffff";
    roundRect(ctx, -w / 2, -h / 2, w, h, w * 0.2);
    ctx.fill();

    ctx.shadowColor = "transparent";
    ctx.strokeStyle = "rgba(0, 0, 0, 0.18)";
    ctx.lineWidth = 1.5;
    roundRect(ctx, -w / 2, -h / 2, w, h, w * 0.2);
    ctx.stroke();

    // Determine value to display
    let val = diceValue || 1;
    if (isRolling) {
      val = dieCycleValue;
    }

    // Die pips
    const dotR = w * 0.088;
    const d = w * 0.25;
    const dotColor = currentP ? currentP.color : "#2c3e50";

    const pips = {
      1: [[0, 0]],
      2: [[-d, -d], [d, d]],
      3: [[-d, -d], [0, 0], [d, d]],
      4: [[-d, -d], [d, -d], [-d, d], [d, d]],
      5: [[-d, -d], [d, -d], [0, 0], [-d, d], [d, d]],
      6: [[-d, -d], [d, -d], [-d, 0], [d, 0], [-d, d], [d, d]],
    };

    ctx.fillStyle = dotColor;
    const coords = pips[val] || pips[1];
    for (const [px, py] of coords) {
      ctx.beginPath();
      ctx.arc(px, py, dotR, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();

    // Roll prompt text below die
    ctx.save();
    ctx.fillStyle = theme.ink;
    ctx.font = `bold ${Math.max(10, Math.round(w * 0.20))}px "Jua", sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    let promptText = "ROLL";
    if (winner) promptText = "OVER";
    else if (isRolling) promptText = "ROLLING";
    else if (isMoving) promptText = "MOVING";
    else if (currentP?.isBot) promptText = "BOT...";
    ctx.fillText(promptText, x + w / 2, y + h + 2);
    ctx.restore();
  }

  function drawBanner(theme, now) {
    if (!banner) return;
    const remaining = banner.expireAt - now;
    if (remaining <= 0) {
      banner = null;
      return;
    }

    const opacity = remaining < 400 ? remaining / 400 : 1;
    const elapsed = now - banner.startAt;
    const scale = elapsed < 200 ? 0.7 + 0.3 * (elapsed / 200) : 1;

    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, opacity));
    const cx = boardX + boardSize / 2;
    const cy = boardY + boardSize / 2;

    ctx.translate(cx, cy);
    ctx.scale(scale, scale);

    const bannerW = Math.min(boardSize * 0.8, 280);
    const bannerH = 64;

    ctx.shadowColor = "rgba(0, 0, 0, 0.3)";
    ctx.shadowBlur = 18;
    ctx.shadowOffsetY = 6;
    ctx.fillStyle = theme.surfaceStrong;
    ctx.strokeStyle = banner.color || theme.surfaceBorder;
    ctx.lineWidth = 2.5;
    roundRect(ctx, -bannerW / 2, -bannerH / 2, bannerW, bannerH, 20);
    ctx.fill();
    ctx.stroke();

    ctx.shadowColor = "transparent";
    ctx.fillStyle = theme.ink;
    ctx.font = `bold 22px "Jua", sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(banner.text, 0, -8);

    if (banner.subtext) {
      ctx.font = `14px "Jua", sans-serif`;
      ctx.fillStyle = theme.squareNumberColor;
      ctx.fillText(banner.subtext, 0, 16);
    }

    ctx.restore();
  }

  function showToastNotification(text, subtext, color) {
    // Show on canvas banner
    banner = {
      text,
      subtext,
      color,
      expireAt: performance.now() + BANNER_DURATION_MS,
      startAt: performance.now(),
    };

    // Also show DOM toast if available or create
    let toast = document.querySelector(".ladders-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.className = "ladders-toast";
      const stage = document.getElementById("stage") || document.body;
      stage.appendChild(toast);
    }
    toast.textContent = text;
    toast.classList.remove("fade-out");
    toast.hidden = false;

    if (toastTimeout) clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => {
      toast.classList.add("fade-out");
      setTimeout(() => {
        toast.hidden = true;
      }, 400);
    }, 1100);
  }

  function spawnConfetti(originX, originY) {
    particles = [];
    const colors = ["#f1c40f", "#e74c3c", "#3498db", "#2ecc71", "#9b59b6", "#e67e22"];
    for (let i = 0; i < 70; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 2 + Math.random() * 6;
      particles.push({
        x: originX,
        y: originY,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 3.5,
        size: 4 + Math.random() * 6,
        color: colors[Math.floor(Math.random() * colors.length)],
        rot: Math.random() * Math.PI * 2,
        vrot: (Math.random() - 0.5) * 0.25,
        opacity: 1,
      });
    }
  }

  function updateParticles() {
    const alive = [];
    for (const p of particles) {
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.18; // gravity
      p.rot += p.vrot;
      p.opacity -= 0.012;
      if (p.opacity > 0 && p.y < canvasHeight + 20) {
        alive.push(p);
      }
    }
    particles = alive;
  }

  function drawParticles() {
    if (particles.length === 0) return;
    ctx.save();
    for (const p of particles) {
      ctx.save();
      ctx.globalAlpha = Math.max(0, p.opacity);
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
      ctx.restore();
    }
    ctx.restore();
  }

  function render() {
    if (!canvas || !active) return;
    const theme = getThemeColors();

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, canvasWidth, canvasHeight);

    const now = performance.now();
    drawBoard(theme);
    drawLadders();
    drawSnakes();
    drawTokens(now);
    drawDie(theme, now);
    drawBanner(theme, now);
    drawParticles();

    ctx.restore();
  }

  function requestRender() {
    dirty = true;
    if (!rafId && active) {
      rafId = requestAnimationFrame(stepAnimation);
    }
  }

  function stepAnimation(timestamp) {
    if (!active) {
      rafId = null;
      return;
    }

    const now = timestamp || performance.now();
    let needsRender = false;

    if (animState) {
      needsRender = true;
      if (animState.type === "roll") {
        const elapsed = now - animState.startTime;
        dieCycleValue = Math.floor(Math.random() * 6) + 1;
        if (elapsed >= animState.duration) {
          const finalRoll = animState.finalRoll;
          animState = null;
          onRollFinished(finalRoll);
        }
      } else if (animState.type === "hop") {
        const elapsed = now - animState.stepStartTime;
        const t = Math.min(1, elapsed / animState.stepDuration);

        const fromPt = squareToXY(animState.fromSq);
        const toPt = squareToXY(animState.toSq);

        animState.currentX = fromPt.x + (toPt.x - fromPt.x) * t;
        animState.currentY = fromPt.y + (toPt.y - fromPt.y) * t;
        animState.jumpY = -Math.sin(t * Math.PI) * (cellSize * 0.45);

        if (t >= 1) {
          animState.pathIndex++;
          if (animState.pathIndex < animState.path.length) {
            animState.fromSq = animState.toSq;
            animState.toSq = animState.path[animState.pathIndex];
            animState.stepStartTime = now;
          } else {
            const finalSq = animState.toSq;
            const player = animState.player;
            player.pos = finalSq;
            animState = null;
            onHopFinished(player, finalSq);
          }
        }
      } else if (animState.type === "slide") {
        const elapsed = now - animState.startTime;
        const t = Math.min(1, elapsed / animState.duration);
        // Smooth cubic ease-in-out
        const ease = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

        const fromPt = squareToXY(animState.fromSq);
        const toPt = squareToXY(animState.toSq);

        animState.currentX = fromPt.x + (toPt.x - fromPt.x) * ease;
        animState.currentY = fromPt.y + (toPt.y - fromPt.y) * ease;
        animState.jumpY = 0;

        if (t >= 1) {
          const destSq = animState.toSq;
          const player = animState.player;
          player.pos = destSq;
          animState = null;
          onSlideFinished(player, destSq);
        }
      }
    }

    if (banner) {
      needsRender = true;
      if (now > banner.expireAt) banner = null;
    }

    if (particles.length > 0) {
      needsRender = true;
      updateParticles();
    }

    if (needsRender || dirty) {
      dirty = false;
      render();
    }

    if (active && (animState || banner || particles.length > 0 || isRolling || isMoving)) {
      rafId = requestAnimationFrame(stepAnimation);
    } else {
      rafId = null;
    }
  }

  function canRoll() {
    return active && !winner && !animState && !isRolling && !isMoving && !isPaused;
  }

  function canHumanRoll() {
    const player = players[currentPlayerIndex];
    return canRoll() && player && !player.isBot;
  }

  function checkBotTurn() {
    clearTimeout(botTimeoutId);
    botTimeoutId = null;
    if (!active || winner || isPaused || animState || isRolling || isMoving) return;
    const player = players[currentPlayerIndex];
    if (!player || !player.isBot) return;

    botTimeoutId = setTimeout(() => {
      if (!active || winner || isPaused || animState || isRolling || isMoving) return;
      const cur = players[currentPlayerIndex];
      if (cur && cur.isBot) {
        rollDice();
      }
    }, 750);
  }

  function rollDice() {
    if (!canRoll()) return;

    const player = players[currentPlayerIndex];
    if (!player) return;

    isRolling = true;
    const elements = getElements();
    if (elements.rollBtn) {
      elements.rollBtn.classList.add("dice-rolling");
      elements.rollBtn.disabled = true;
    }

    const finalRoll = Math.floor(Math.random() * 6) + 1;
    animState = {
      type: "roll",
      player,
      startTime: performance.now(),
      duration: ROLL_DURATION_MS,
      finalRoll,
    };

    requestRender();
  }

  function onRollFinished(finalRoll) {
    isRolling = false;
    diceValue = finalRoll;
    dieCycleValue = finalRoll;

    const elements = getElements();
    if (elements.rollBtn) {
      elements.rollBtn.classList.remove("dice-rolling");
    }
    if (elements.diceResult) {
      elements.diceResult.textContent = String(finalRoll);
    }

    const player = players[currentPlayerIndex];
    player.turns++;

    const path = calculateHopPath(player.pos, finalRoll);
    isMoving = true;

    animState = {
      type: "hop",
      player,
      path,
      pathIndex: 0,
      fromSq: player.pos,
      toSq: path[0],
      stepStartTime: performance.now(),
      stepDuration: HOP_STEP_MS,
      currentX: squareToXY(player.pos).x,
      currentY: squareToXY(player.pos).y,
      jumpY: 0,
    };

    updateHud();
    requestRender();
  }

  function onHopFinished(player, finalSq) {
    // Check ladder or snake
    if (LADDERS[finalSq]) {
      const destSq = LADDERS[finalSq];
      showToastNotification("Ladder! 🪜", `Climbed to ${destSq}`, "#27ae60");

      animState = {
        type: "slide",
        player,
        fromSq: finalSq,
        toSq: destSq,
        startTime: performance.now(),
        duration: SLIDE_MS,
        currentX: squareToXY(finalSq).x,
        currentY: squareToXY(finalSq).y,
      };

      requestRender();
    } else if (SNAKES[finalSq]) {
      const destSq = SNAKES[finalSq];
      showToastNotification("Snake! 🐍", `Slid down to ${destSq}`, "#e74c3c");

      animState = {
        type: "slide",
        player,
        fromSq: finalSq,
        toSq: destSq,
        startTime: performance.now(),
        duration: SLIDE_MS,
        currentX: squareToXY(finalSq).x,
        currentY: squareToXY(finalSq).y,
      };

      requestRender();
    } else {
      finishTurn(player);
    }
  }

  function onSlideFinished(player, destSq) {
    player.pos = destSq;
    finishTurn(player);
  }

  function finishTurn(player) {
    isMoving = false;
    animState = null;

    // Check win condition
    if (player.pos === TOTAL_SQUARES) {
      onGameOver(player);
      return;
    }

    // Extra turn if rolled 6
    if (diceValue === 6) {
      showToastNotification("Rolled a 6! 🎲", `${player.name} gets an extra turn!`, player.color);
    } else {
      currentPlayerIndex = (currentPlayerIndex + 1) % numPlayers;
    }

    updateHud();
    requestRender();
    checkBotTurn();
  }

  function onGameOver(winningPlayer) {
    clearTimeout(botTimeoutId);
    botTimeoutId = null;
    winner = winningPlayer;
    const goalPos = squareToXY(TOTAL_SQUARES);
    spawnConfetti(goalPos.x, goalPos.y);

    banner = {
      text: `🏆 ${winningPlayer.name} Wins!`,
      subtext: `Reached square 100 in ${winningPlayer.turns} turns!`,
      color: winningPlayer.color,
      expireAt: performance.now() + 3500,
      startAt: performance.now(),
    };

    updateHud();
    requestRender();

    setTimeout(() => {
      if (!active) return;
      showGameOver(winningPlayer);
    }, 700);
  }

  function showGameOver(winningPlayer) {
    const elements = getElements();
    const over = elements.over;
    if (!over) return;

    over.classList.remove("hidden");
    over.hidden = false;

    // Set title and winner note
    const titleEl = over.querySelector("#laddersOverTitle");
    if (titleEl) {
      if (isSoloGame) {
        titleEl.textContent = winningPlayer.isBot ? "Better luck next time!" : "You Win! 🏆";
      } else {
        titleEl.textContent = "Game Over";
      }
    }

    const winnerEl = over.querySelector("#laddersWinner");
    if (winnerEl) {
      winnerEl.textContent = `${winningPlayer.name} reached square 100 in ${winningPlayer.turns} turns!`;
    }

    // Update laddersResults or summary container
    let resultsEl = over.querySelector("#laddersResults");
    if (!resultsEl) {
      resultsEl = over.querySelector(".ladders-over-summary");
    }
    if (!resultsEl) {
      resultsEl = document.createElement("div");
      resultsEl.id = "laddersResults";
      resultsEl.className = "final-stats";
      const actions = over.querySelector(".panel-actions, .actions") || over;
      if (actions !== over) {
        over.insertBefore(resultsEl, actions);
      } else {
        over.appendChild(resultsEl);
      }
    }

    const rows = players
      .map(
        (p) => `
      <div style="display: flex; justify-content: space-between; align-items: center; padding: 6px 0; border-bottom: 1px solid var(--surface-border);">
        <span style="display: flex; align-items: center; gap: 8px;">
          <span class="ladders-player-dot" style="background: ${p.color};"></span>
          <b>${escapeHtml(p.name)}</b> ${p.isBot ? '<span style="opacity: 0.75; font-size: 0.85em;">(Bot)</span>' : ""} ${p.id === winningPlayer.id ? "🏆 Winner!" : ""}
        </span>
        <span>${p.turns} turns (square ${p.pos})</span>
      </div>
    `
      )
      .join("");

    resultsEl.innerHTML = `
      <div style="margin-bottom: 16px; font-size: 0.95rem; color: var(--ink);">
        ${rows}
      </div>
    `;

    hydrateIcons(over);
  }

  function updateHud() {
    const elements = getElements();
    const player = players[currentPlayerIndex];
    if (!player) return;

    if (elements.currentPlayer) {
      elements.currentPlayer.innerHTML = `
        <span class="ladders-player-dot" style="background: ${player.color}; box-shadow: 0 0 6px ${player.color};"></span>
        <span>${escapeHtml(player.name)}'s turn${player.isBot ? " (Bot)" : ""}</span>
      `;
    }

    if (elements.diceResult) {
      elements.diceResult.textContent = diceValue !== null ? String(diceValue) : "-";
    }

    if (elements.rollBtn) {
      const ready = canHumanRoll();
      elements.rollBtn.disabled = !ready;
      elements.rollBtn.setAttribute("aria-disabled", String(!ready));
      if (player.isBot) {
        elements.rollBtn.textContent = `${player.name} is rolling...`;
      } else {
        elements.rollBtn.textContent = "Roll Dice";
      }
    }
  }

  function start(opts = {}) {
    const isSolo = opts?.solo ?? (Number(opts?.players) === 1);
    isSoloGame = isSolo;
    const num = isSolo ? 4 : Math.max(2, Math.min(4, Number(opts?.players) || 2));
    numPlayers = num;
    winner = null;
    diceValue = null;
    banner = null;
    particles = [];
    animState = null;
    isRolling = false;
    isMoving = false;
    isPaused = false;
    currentPlayerIndex = 0;
    clearTimeout(botTimeoutId);
    botTimeoutId = null;

    players = [];
    if (isSolo) {
      const botNames = getRandomBotNames(3);
      // Human player
      players.push({
        id: 0,
        name: getSettings().name?.trim() || "You",
        color: PLAYER_COLORS[0],
        pos: 0,
        turns: 0,
        isBot: false,
      });
      // 3 Computer bots
      for (let i = 1; i <= 3; i++) {
        players.push({
          id: i,
          name: botNames[i - 1],
          color: PLAYER_COLORS[i],
          pos: 0,
          turns: 0,
          isBot: true,
        });
      }
    } else {
      for (let i = 0; i < numPlayers; i++) {
        players.push({
          id: i,
          name: PLAYER_NAMES[i],
          color: PLAYER_COLORS[i],
          pos: 0,
          turns: 0,
          isBot: false,
        });
      }
    }

    active = true;

    // Show canvas, hide Classic / Slither
    const classicCanvas = document.getElementById("board");
    if (classicCanvas) classicCanvas.style.display = "none";
    const slitherCanvas = document.getElementById("world");
    if (slitherCanvas) slitherCanvas.style.display = "none";

    const elements = getElements();
    if (elements.canvas) {
      elements.canvas.hidden = false;
      elements.canvas.style.display = "block";
    }

    document.body.classList.add("playing", "ladders-playing");
    document.body.classList.remove("paused", "modal-open");

    // Show HUD and controls
    if (elements.hud) {
      elements.hud.hidden = false;
      elements.hud.classList.remove("hidden");
    }
    if (elements.rollBtn) {
      elements.rollBtn.hidden = false;
    }
    if (elements.diceResult) {
      elements.diceResult.hidden = false;
    }

    // Hide Game Over
    if (elements.over) {
      elements.over.hidden = true;
      elements.over.classList.add("hidden");
    }

    layout();
    updateHud();
    requestRender();
    checkBotTurn();
  }

  function pause() {
    if (!active) return;
    isPaused = true;
    clearTimeout(botTimeoutId);
    botTimeoutId = null;
    document.body.classList.add("paused");
    requestRender();
  }

  function resume() {
    if (!active) return;
    isPaused = false;
    document.body.classList.remove("paused");
    requestRender();
    checkBotTurn();
  }

  function leaveGame() {
    active = false;
    isPaused = false;
    animState = null;
    clearTimeout(botTimeoutId);
    botTimeoutId = null;
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }

    document.body.classList.remove("playing", "ladders-playing", "paused");

    const elements = getElements();
    if (elements.canvas) {
      elements.canvas.hidden = true;
      elements.canvas.style.display = "none";
    }
    if (elements.hud) {
      elements.hud.hidden = true;
      elements.hud.classList.add("hidden");
    }
    if (elements.rollBtn) {
      elements.rollBtn.hidden = true;
    }
    if (elements.diceResult) {
      elements.diceResult.hidden = true;
    }
    if (elements.over) {
      elements.over.hidden = true;
      elements.over.classList.add("hidden");
    }

    const classicCanvas = document.getElementById("board");
    if (classicCanvas) classicCanvas.style.display = "";

    if (typeof showStart === "function") {
      showStart();
    }
  }

  // Event wiring
  function wireEvents() {
    // Canvas pointerdown / click rolls
    canvas.addEventListener("pointerdown", (e) => {
      if (!canHumanRoll()) return;
      e.preventDefault();
      rollDice();
    });

    // Keyboard Space or Enter rolls
    window.addEventListener("keydown", (e) => {
      if (!canHumanRoll()) return;
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || document.body.classList.contains("modal-open")) {
        return;
      }
      if (e.key === " " || e.key === "Spacebar" || e.key === "Enter") {
        e.preventDefault();
        rollDice();
      }
    });

    // Wire DOM buttons
    const elements = getElements();
    if (elements.rollBtn) {
      elements.rollBtn.addEventListener("click", (e) => {
        if (!canHumanRoll()) return;
        e.preventDefault();
        rollDice();
      });
    }

    if (elements.againBtn) {
      elements.againBtn.addEventListener("click", (e) => {
        e.preventDefault();
        start({ players: isSoloGame ? 1 : numPlayers, solo: isSoloGame });
      });
    }

    if (elements.leaveBtn) {
      elements.leaveBtn.addEventListener("click", (e) => {
        e.preventDefault();
        leaveGame();
      });
    }

    // Resize handling
    window.addEventListener("resize", queueLayout);
    const observerTarget = canvas.parentElement || canvas;
    if (typeof ResizeObserver !== "undefined") {
      const resizeObserver = new ResizeObserver(() => {
        queueLayout();
      });
      resizeObserver.observe(observerTarget);
    }

    // Mode / theme changes
    document.addEventListener("uwu:modechange", () => requestRender());
  }

  wireEvents();

  return {
    start,
    pause,
    resume,
    leave: leaveGame,
    get inGame() {
      return active;
    },
  };
}

