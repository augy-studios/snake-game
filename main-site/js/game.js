// The game screen: the pre-game screen, play, pause, game over, the
// leaderboard submit, seeds, sharing, and the instant replay. The rules are
// js/rules.js; this drives them, draws them (js/render.js) and takes input.
//
// One loop runs whatever is on the board, a session of one of three kinds:
//   local    a game this device runs: alone, or as a party game's host
//   remote   a party game another device hosts, drawn from its snapshots
//   replay   a finished game played back (js/replay.js)
// js/party.js starts and feeds the party ones through the controller that
// initGame returns.

import { api } from "./api.js";
import { botMove } from "./bot.js";
import { icon } from "./icons.js";
import { openLeaderboard } from "./leaderboard.js";
import { ReplayPlayer } from "./replay.js";
import { REPLAY_VERSION, packReplay } from "./replay-format.js";
import { animating, drawBoard, readPalette } from "./render.js";
import {
  DIR_NAMES,
  GRID,
  MAX_START_LEVEL,
  applyEvent,
  canPlace,
  currentTickMs,
  newGame,
  step,
  summary,
  tickMs,
} from "./rules.js";
import { cleanSeed, makeSeed } from "./seed.js";
import { describeSettings, gameSettings, getSettings, openSettings, saveSettings } from "./settings.js";
import { escapeHtml, hydrateIcons, store } from "./ui.js";

// The editions on the pre-game screen. The picker shows once there is more
// than one; each id is what the Play button starts.
export const EDITIONS = [{ id: "classic", name: "Classic", about: "The board wraps round at every edge." }];

const BEST_KEY = "uwusnek.best";
const SPEED_KEY = "uwusnek.replaySpeed";
const REPLAY_SPEEDS = [0.5, 1, 2, 4];

const TRIPLE_TAP_MS = 400;
const SWIPE_PX = 22;
const TAP_PX = 14;
const TAP_MS = 400;
const OVER_PANEL_DELAY_MS = 700;
const SPACE_RESTART_DELAY_MS = 800;
const MAX_QUEUED = 2;
const COUNTDOWN_MS = 3000;
export const TOOL_COOLDOWN_MS = 5000;

// Arrow keys and WASD, by the key's position for WASD so other layouts work.
const KEY_DIRS = { ArrowUp: 0, ArrowRight: 1, ArrowDown: 2, ArrowLeft: 3 };
const CODE_DIRS = { KeyW: 0, KeyD: 1, KeyS: 2, KeyA: 3 };

const CAUSES = {
  self: "ran into its own body",
  wall: "hit a wall",
  snake: "ran into another snake",
  head: "met another snake head on",
};

const clock = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

const isTouch = () => window.matchMedia("(pointer: coarse)").matches || (navigator.maxTouchPoints || 0) > 0;

export function initGame(hooks = {}) {
  const $ = (id) => document.getElementById(id);
  const canvas = $("board");
  // desynchronized lets the browser show a frame without waiting on the
  // compositor where it can: a few milliseconds less between key and move.
  const ctx = canvas.getContext("2d", { desynchronized: true }) ?? canvas.getContext("2d");
  const stage = $("stage");
  const hudStats = $("hudStats");
  const stageNote = $("stageNote");
  const replayBar = $("replayBar");
  const seek = $("replaySeek");

  let palette = readPalette();
  let session = null;
  // The remote party game, kept apart so snapshots still land while its
  // replay is showing.
  let remote = null;
  // The game a replay was opened from, to go back to.
  let returnTo = null;
  let finished = null; // the last finished game, for the over panel
  let gameNumber = 0;
  let dirty = true;
  let boardSize = 0;
  let dpr = 1;

  /* ---- Layout ----
     The board is the largest square that fits clear of the floating
     controls, centred on the screen wherever that costs little. Each control
     is its own obstacle: the stats top left, and on the right the pause
     button, the tray's tab and, while the tray is open, its column of
     buttons. So on a phone the board can sit under the stats beside the
     slim column, and where the tray is collapsed, under the stats at the
     full width (edge-tray-spec.md, 5.1). */

  const probe = document.createElement("div");
  probe.style.cssText =
    "position:fixed;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)";
  document.body.append(probe);

  let layoutQueued = false;
  function queueLayout() {
    if (layoutQueued) return;
    layoutQueued = true;
    requestAnimationFrame(() => {
      layoutQueued = false;
      layout();
    });
  }

  // Where the right hand controls will be once the tray has finished
  // moving. Worked out from offsets, which ignore the slide's transform, so
  // a layout run while the tray is still sliding lands where it ends up.
  function rightObstacles() {
    const right = document.querySelector(".hud-right");
    const rr = right.getBoundingClientRect();
    // Offsets up to .hud-right itself, whichever ancestors count on the way.
    const at = (el) => {
      let x = 0;
      let y = 0;
      for (let n = el; n && n !== right; n = n.offsetParent) {
        x += n.offsetLeft;
        y += n.offsetTop;
      }
      return { x, y };
    };
    const box = (el, dx = 0) => {
      const { x, y } = at(el);
      return { left: rr.left + x + dx, top: rr.top + y, right: rr.left + x + el.offsetWidth + dx, bottom: rr.top + y + el.offsetHeight };
    };
    const tray = $("tray");
    const buttons = $("trayButtons");
    const open = !tray.classList.contains("collapsed");
    const shift = buttons.offsetWidth + 8 + (parseFloat(getComputedStyle(buttons).marginRight) || 0);
    const list = [box(document.querySelector(".hud-pause")), box($("trayTab"), open ? 0 : shift)];
    if (open) list.push(box(buttons));
    return list;
  }

  function layout() {
    const vv = window.visualViewport;
    const vw = vv ? vv.width : window.innerWidth;
    const vh = vv ? vv.height : window.innerHeight;
    const ps = getComputedStyle(probe);
    const safe = {
      top: parseFloat(ps.paddingTop) || 0,
      right: parseFloat(ps.paddingRight) || 0,
      bottom: parseFloat(ps.paddingBottom) || 0,
      left: parseFloat(ps.paddingLeft) || 0,
    };
    const notice = document.querySelector(".update-notice")?.offsetHeight ?? 0;
    const pad = vw <= 480 ? 10 : 16;
    const gap = 8;
    const top0 = Math.max(notice, safe.top) + pad;

    let bottom = pad + safe.bottom;
    if (!replayBar.hidden) bottom = Math.max(bottom, vh - replayBar.getBoundingClientRect().top + gap);
    if (!$("toolDock").hidden) bottom = Math.max(bottom, vh - $("toolDock").getBoundingClientRect().top + gap);
    const floor = vh - bottom;

    const hud = $("hudLeft").getBoundingClientRect();
    const obstacles = [{ left: hud.left, top: hud.top, right: hud.right, bottom: hud.bottom }, ...rightObstacles()];
    const minL = pad + safe.left;
    const maxR = vw - pad - safe.right;

    // The room a board starting at `top` has across, given whatever beside
    // it reaches down into its height; tried until it settles, since a
    // smaller board reaches past fewer controls.
    function fit(top) {
      let size = floor - top;
      let L = minL;
      let R = maxR;
      for (let i = 0; i < 4; i += 1) {
        L = minL;
        R = maxR;
        for (const o of obstacles) {
          if (o.bottom + gap <= top || o.top - gap >= top + size) continue;
          if ((o.left + o.right) / 2 > vw / 2) R = Math.min(R, o.left - gap);
          else L = Math.max(L, o.right + gap);
        }
        size = Math.min(floor - top, R - L);
      }
      // Centred if it can be: a board pushed to one side by a few pixels
      // looks wrong, so a centred one may be a little smaller.
      const half = Math.min(vw / 2 - L, R - vw / 2);
      const centred = Math.min(size, half * 2);
      return [
        { top, size, left: L + Math.max(0, (R - L - size) / 2) },
        { top, size: centred, left: (vw - centred) / 2 },
      ];
    }

    const tops = [top0, ...obstacles.map((o) => o.bottom + gap)].filter((t) => t >= top0 && t < floor - GRID * 4);
    const options = tops.flatMap(fit).filter((o) => o.size > 0);

    // Each option as evenly placed as it can be: as much empty space above
    // it, from the stats down, as below it, but never higher than where it
    // starts, since above that something is in its way.
    const anchor = Math.max(top0, hud.bottom + gap);
    for (const o of options) {
      const from = Math.min(anchor, o.top);
      o.y = Math.min(floor - o.size, Math.max(o.top, (from + floor - o.size) / 2));
    }
    // The biggest, less what makes it look misplaced: three times how far off
    // centre it sits, and most of how much more empty space there is above
    // it than below, or below than above. That keeps a phone's board
    // from sliding to the foot of the screen under the tray for a few
    // pixels more width.
    const score = (o) =>
      o.size -
      3 * Math.abs(o.left + o.size / 2 - vw / 2) -
      Math.abs(o.y - Math.min(anchor, o.top) - (floor - o.y - o.size)) * 0.6;
    const best = options.reduce((a, b) => (score(b) > score(a) ? b : a), options[0] ?? { top: top0, y: top0, size: GRID * 4, left: (vw - GRID * 4) / 2 });

    const size = Math.max(GRID * 4, Math.floor(best.size));
    const topY = best.y;
    Object.assign(canvas.style, {
      left: `${Math.round(best.left)}px`,
      top: `${Math.round(topY)}px`,
      width: `${size}px`,
      height: `${size}px`,
    });
    dirty = true;
  }

  function fitCanvas() {
    const size = canvas.clientWidth;
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    if (size === boardSize && ratio === dpr) return false;
    boardSize = size;
    dpr = ratio;
    canvas.width = Math.max(1, Math.round(size * dpr));
    canvas.height = canvas.width;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return true;
  }

  /* ---- The view on the board ---- */

  function currentView() {
    if (!session) return null;
    if (session.kind === "local") return session.state;
    if (session.kind === "remote") return session.view;
    return session.player.state;
  }

  let aim = null; // a watcher's pointer, for the placement preview

  // The board with nothing on it, behind the pre-game screen.
  const EMPTY = { grid: GRID, snakes: [], fruits: [], walls: [], timeMs: 0 };

  /* ---- Smooth movement ----
     Between moves each snake glides on: how far into the next move the
     game is, and which way that move goes. Here, from this device's clock
     and the turn queued next; in a replay, from the turns it already
     knows; for a guest, from the time since the host's last snapshot. */

  const unit = (v) => Math.max(0, Math.min(1, v));

  function wouldTake(snake, dir) {
    if (dir === snake.dir) return false;
    return !(snake.moved >= 0 && snake.body.length > 1 && (dir + 2) % 4 === snake.moved);
  }

  function growsInto(view, snake, dir) {
    if (snake.grow > 0) return true;
    if (dir < 0 || !snake.body.length) return false;
    const [hx, hy] = snake.body[0];
    const x = (hx + [0, 1, 0, -1][dir] + view.grid) % view.grid;
    const y = (hy + [-1, 0, 1, 0][dir] + view.grid) % view.grid;
    return view.fruits.some((f) => f.x === x && f.y === y);
  }

  function motionFor(view, now) {
    const s = session;
    if (!s || !view || view.over) return null;
    let t = 0;
    let nextDir = (snake) => snake.dir;
    if (s.kind === "local") {
      const st = s.state;
      if (s.paused || !st.started || s.countdownUntil) return null;
      t = s.acc / currentTickMs(st);
      nextDir = (snake, i) => (s.autoplay ? snake.dir : (s.queues[i] ?? []).find((d) => wouldTake(snake, d)) ?? snake.dir);
    } else if (s.kind === "replay") {
      if (!s.playing) return null;
      const p = s.player;
      t = s.acc / p.durationAt(p.tick);
      const events = p.replay.events;
      nextDir = (snake, i) => {
        for (let k = p.event; k < events.length && events[k][0] === p.tick; k += 1) {
          if (events[k][1] === 0 && events[k][2] === i && wouldTake(snake, events[k][3])) return events[k][3];
        }
        return snake.dir;
      };
    } else {
      if (s.paused || s.countdown || !s.viewAt) return null;
      t = (now - s.viewAt) / tickMs(view.settings.difficulty, view.level);
    }
    t = unit(t);
    return view.snakes.map((snake, i) => {
      const dir = nextDir(snake, i);
      return { t, dir, grows: growsInto(view, snake, dir) };
    });
  }

  function draw(now) {
    const view = currentView();
    if (!view) {
      drawBoard(ctx, boardSize, EMPTY, palette, { dpr });
      return;
    }
    const hints = session.kind === "local" && !session.party && !view.started && isTouch();
    let highlight = null;
    if (aim && watching()) {
      const tool = session.tool;
      const cells = tool === "fruit" ? [[aim.x, aim.y]] : [0, 1, 2].map((k) => (tool === "across" ? [(aim.x + k) % GRID, aim.y] : [aim.x, (aim.y + k) % GRID]));
      highlight = { cells, ok: canPlace(view, tool === "fruit" ? "fruit" : "wall", aim.x, aim.y, tool === "across") };
    }
    drawBoard(ctx, boardSize, view, palette, { dpr, pulse: now / 1000, hints, highlight, motion: motionFor(view, now) });
  }

  /* ---- The stats, top left ---- */

  let hudCache = "";
  function renderHud() {
    const view = currentView();
    let html = "";
    if (view) {
      const names = session.names ?? session.replay?.players ?? ["You"];
      const limit = view.settings.game_seconds * 1000;
      const timeLine = limit
        ? `<span class="hud-pair">Time <b>${clock(limit - view.timeMs)}</b></span>`
        : `<span class="hud-pair">Time <b>${clock(view.timeMs)}</b></span>`;
      if (view.snakes.length === 1 && view.mode === "solo") {
        const s = view.snakes[0];
        html =
          `<p class="hud-line"><span class="hud-pair">Score <b>${s.score}</b></span>` +
          `<span class="hud-pair">Level <b>${view.level}</b></span>` +
          `<span class="hud-pair">Length <b>${Math.max(s.body.length, s.longest)}</b></span></p>` +
          `<p class="hud-line hud-sub">${timeLine}<span class="hud-pair">Best <b>${readBest()}</b></span></p>`;
      } else {
        const rows = view.snakes
          .map(
            (s, i) =>
              `<li class="${s.alive ? "" : "out"}"><span class="dot" style="background:var(--snake-${(i % 4) + 1})"></span>` +
              `${escapeHtml(names[i] ?? `Player ${i + 1}`)}<b>${s.score}</b>${s.alive ? "" : '<span class="out-tag">out</span>'}</li>`
          )
          .join("");
        const team = view.mode === "coop" ? `<span class="hud-pair">Team <b>${view.snakes.reduce((n, s) => n + s.score, 0)}</b></span>` : "";
        html =
          `<ul class="hud-players">${rows}</ul>` +
          `<p class="hud-line hud-sub">${team}<span class="hud-pair">Level <b>${view.level}</b></span>${timeLine}</p>`;
      }
    }
    if (html !== hudCache) {
      hudCache = html;
      hudStats.innerHTML = html;
    }
  }

  function setNote(text) {
    if (stageNote.textContent !== text) stageNote.textContent = text;
    stageNote.hidden = !text;
  }

  function readBest() {
    return Number(store.get(BEST_KEY)) || 0;
  }

  /* ---- Local games ---- */

  // Asks the API for a run to submit this game under. The server's clock
  // starts here. A game started offline has no run and cannot be added.
  function startRun() {
    const mine = { id: null, failed: false };
    mine.ready = api
      .startRun()
      .then((r) => {
        mine.id = r.run_id;
      })
      .catch(() => {
        mine.failed = true;
      });
    return mine;
  }

  function hideOverlays() {
    for (const id of ["startOverlay", "pauseOverlay", "gameOverOverlay"]) $(id).classList.add("hidden");
  }

  // A game alone on this device. `autoplay` starts it with the bot steering.
  function startSolo({ seed = makeSeed(), startLevel = getSettings().start_level, autoplay = false } = {}) {
    stopReplayView();
    gameNumber += 1;
    const settings = { ...gameSettings(), start_level: startLevel };
    const state = newGame({ seed, settings });
    session = {
      kind: "local",
      party: false,
      state,
      events: [],
      queues: [[]],
      places: [],
      mySeat: 0,
      names: [getSettings().name ?? "You"],
      acc: 0,
      paused: false,
      autoplay: false,
      wantAutoplay: autoplay ? true : null,
      run: startRun(),
      at: new Date().toISOString(),
      ended: false,
    };
    finished = null;
    hideOverlays();
    document.body.classList.add("playing");
    document.body.classList.remove("guest");
    setNote(isTouch() ? "Swipe on the board, or tap an edge, to start" : "Press an arrow key or WASD to start");
    renderSeed(seed);
    renderHud();
    queueLayout();
    document.activeElement?.blur?.();
  }

  // A party game this device hosts. `seats` names each snake in seat order;
  // `mySeat` is the host's own snake, or null when the host is watching.
  function startHost({ seed = makeSeed(), mode, seats, mySeat, onTick, onEnd }) {
    stopReplayView();
    gameNumber += 1;
    const state = newGame({ seed, mode, players: seats.length, settings: gameSettings() });
    session = {
      kind: "local",
      party: true,
      state,
      events: [],
      queues: seats.map(() => []),
      places: [],
      mySeat,
      names: seats,
      acc: 0,
      paused: false,
      autoplay: false,
      wantAutoplay: null,
      run: null,
      at: new Date().toISOString(),
      ended: false,
      countdownUntil: performance.now() + COUNTDOWN_MS,
      onTick,
      onEnd,
      tool: "across",
      cooldowns: { wall: 0, fruit: 0 },
    };
    finished = null;
    hideOverlays();
    document.body.classList.add("playing");
    document.body.classList.remove("guest");
    renderSeed(seed);
    showTools();
    renderHud();
    queueLayout();
  }

  function enqueue(seat, dir) {
    const s = session;
    if (s?.kind !== "local" || s.state.over) return;
    const q = s.queues[seat];
    if (!q || q.length >= MAX_QUEUED || q[q.length - 1] === dir) return;
    q.push(dir);
  }

  // The inputs due now, applied at the current tick and recorded if they
  // took: autoplay switching, each snake's next queued turn, the bot's turn,
  // and watchers' walls and fruit.
  function takeInputs() {
    const s = session;
    const st = s.state;
    const t = st.tick;
    const record = (e) => {
      if (!applyEvent(st, e)) return false;
      s.events.push(e);
      return true;
    };
    if (s.wantAutoplay !== null) {
      if (record([t, 1, s.wantAutoplay ? 1 : 0])) s.autoplay = s.wantAutoplay;
      s.wantAutoplay = null;
      s.queues[0].length = 0;
    }
    s.queues.forEach((q, seat) => {
      while (q.length) if (record([t, 0, seat, q.shift()])) break;
    });
    if (s.autoplay) {
      const dir = botMove(st, 0);
      if (dir >= 0 && dir !== st.snakes[0].dir) record([t, 0, 0, dir]);
    }
    for (const p of s.places.splice(0)) {
      const ok = p.tool === "fruit" ? record([t, 3, p.x, p.y]) : record([t, 2, p.x, p.y, p.tool === "across" ? 1 : 0]);
      p.done?.(ok);
    }
  }

  function updateLocal(dt, now) {
    const s = session;
    const st = s.state;
    if (s.paused || st.over) return false;
    if (s.countdownUntil) {
      const left = s.countdownUntil - now;
      if (left > 0) {
        setNote(String(Math.ceil(left / 1000)));
        return false;
      }
      s.countdownUntil = 0;
      setNote(s.mySeat === null ? watchNote() : "");
    }
    if (!st.started) {
      takeInputs();
      if (!st.started) return false;
      setNote("");
      s.acc = 0;
    }
    s.acc += dt;
    let moved = false;
    // A tab back from the background owes many moves; it plays a few and
    // drops the rest rather than racing through them.
    for (let guard = 0; s.acc >= currentTickMs(st) && !st.over && guard < 8; guard += 1) {
      s.acc -= currentTickMs(st);
      takeInputs();
      step(st);
      moved = true;
      s.onTick?.(st);
    }
    if (s.acc > currentTickMs(st) * 2) s.acc = 0;
    if (moved) renderHud();
    if (st.over && !s.ended) endLocal();
    return moved;
  }

  // The finished game as a replay: everything needed to play it again.
  function replayOf(s) {
    const st = s.state;
    return {
      v: REPLAY_VERSION,
      kind: s.party ? "party" : "solo",
      at: s.at,
      mode: st.mode,
      grid: st.grid,
      seed: st.seed,
      settings: st.settings,
      players: s.names.slice(0, st.snakes.length),
      ticks: st.tick,
      events: s.events,
    };
  }

  function endLocal() {
    const s = session;
    s.ended = true;
    const result = summary(s.state);
    finished = { session: s, result, replay: replayOf(s), replayId: null, number: gameNumber, overAt: 0, submitted: null };
    if (s.party) {
      s.onEnd?.(result, finished.replay);
    } else {
      // The next game is the player's own again.
      s.autoplay = false;
      const best = readBest();
      finished.newBest = !result.autoplayed && result.score > best;
      if (finished.newBest) store.set(BEST_KEY, String(result.score));
    }
    renderHud();
    const number = gameNumber;
    setTimeout(() => {
      if (number === gameNumber && session === s) showOver();
    }, OVER_PANEL_DELAY_MS);
  }

  /* ---- Autoplay ----
     F2, or three quick taps on the game's name on a touch screen. Not
     mentioned anywhere on screen on purpose. It steers far quicker than a
     person, and a game it touched cannot go on the leaderboard: the game,
     not the browser, carries the mark, so the next game is clean. */

  function toggleAutoplay() {
    const s = session;
    if (s?.kind === "local" && !s.party && !s.state.over) {
      s.wantAutoplay = !(s.wantAutoplay ?? s.autoplay);
      if (s.paused) setPaused(false);
      return;
    }
    if (s?.kind === "remote" || (s?.kind === "local" && s.party)) return;
    if (s?.kind === "replay") return;
    const level = finished?.session?.state.settings.start_level ?? getSettings().start_level;
    startSolo({ startLevel: level, autoplay: true });
  }

  let taps = 0;
  let lastTapAt = 0;
  function onBrandTap(e) {
    if (e.pointerType !== "touch") return;
    e.preventDefault();
    const now = performance.now();
    taps = now - lastTapAt <= TRIPLE_TAP_MS ? taps + 1 : 1;
    lastTapAt = now;
    if (taps < 3) return;
    taps = 0;
    toggleAutoplay();
  }

  /* ---- Steering ---- */

  function steer(dir) {
    const s = session;
    if (!s) return;
    if (s.kind === "local") {
      if (s.paused || s.state.over || s.mySeat === null || s.autoplay) return;
      enqueue(s.mySeat, dir);
    } else if (s.kind === "remote") {
      if (!s.watching && !s.view?.over) s.send({ type: "input", dir });
    }
  }

  const watching = () => (session?.kind === "local" && session.party && session.mySeat === null) || (session?.kind === "remote" && session.watching);

  // A tap away from the middle turns towards that edge: the board is cut
  // into four by its diagonals, so the whole of each side is a target.
  function tapDirection(x, y) {
    const r = canvas.getBoundingClientRect();
    const dx = x - (r.left + r.width / 2);
    const dy = y - (r.top + r.height / 2);
    if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? 1 : 3;
    return dy > 0 ? 2 : 0;
  }

  function cellAt(x, y) {
    const r = canvas.getBoundingClientRect();
    const cx = Math.floor(((x - r.left) / r.width) * GRID);
    const cy = Math.floor(((y - r.top) / r.height) * GRID);
    return cx >= 0 && cy >= 0 && cx < GRID && cy < GRID ? { x: cx, y: cy } : null;
  }

  // Touch on the game area: swipes steer, as many as fit in one touch, and
  // a tap steers towards its edge. Nothing here scrolls, zooms or reloads
  // the page; touch-action in style.css keeps the browser's gestures out.
  let gesture = null;
  function onPointerDown(e) {
    if (!session || session.kind === "replay") return;
    if (watching()) {
      aim = cellAt(e.clientX, e.clientY);
      if (e.pointerType !== "mouse") e.preventDefault();
      return;
    }
    if (e.pointerType === "mouse") return;
    e.preventDefault();
    stage.setPointerCapture?.(e.pointerId);
    gesture = { id: e.pointerId, x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t: performance.now(), swiped: false };
  }

  function onPointerMove(e) {
    if (watching()) {
      const next = cellAt(e.clientX, e.clientY);
      if (next?.x !== aim?.x || next?.y !== aim?.y) {
        aim = next;
        dirty = true;
      }
      return;
    }
    if (!gesture || e.pointerId !== gesture.id) return;
    const dx = e.clientX - gesture.x;
    const dy = e.clientY - gesture.y;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < SWIPE_PX) return;
    steer(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 1 : 3) : dy > 0 ? 2 : 0);
    gesture.x = e.clientX;
    gesture.y = e.clientY;
    gesture.swiped = true;
  }

  function onPointerUp(e) {
    if (watching()) {
      const cell = cellAt(e.clientX, e.clientY);
      if (cell) placeTool(cell.x, cell.y);
      if (e.pointerType !== "mouse") aim = null;
      dirty = true;
      return;
    }
    if (!gesture || e.pointerId !== gesture.id) return;
    const g = gesture;
    gesture = null;
    const moved = Math.hypot(e.clientX - g.x0, e.clientY - g.y0);
    if (!g.swiped && moved < TAP_PX && performance.now() - g.t < TAP_MS) steer(tapDirection(e.clientX, e.clientY));
  }

  /* ---- Watchers' tools ---- */

  function watchNote() {
    return isTouch() ? "Tap the board to drop a wall or a fruit" : "Click the board to drop a wall or a fruit";
  }

  function showTools() {
    const on = watching();
    $("toolDock").hidden = !on;
    if (on) renderTools();
    queueLayout();
  }

  function renderTools(now = performance.now()) {
    const s = session;
    if (!s?.cooldowns) return;
    document.querySelectorAll("#toolDock [data-tool]").forEach((el) => {
      const on = el.dataset.tool === s.tool;
      el.classList.toggle("active", on);
      el.setAttribute("aria-pressed", String(on));
      const kind = el.dataset.tool === "fruit" ? "fruit" : "wall";
      const left = s.cooldowns[kind] - now;
      const label = el.querySelector(".tool-wait");
      const text = left > 0 ? `${Math.ceil(left / 1000)} s` : "";
      if (label.textContent !== text) label.textContent = text;
      el.classList.toggle("cooling", left > 0);
    });
  }

  function placeTool(x, y) {
    const s = session;
    const kind = s.tool === "fruit" ? "fruit" : "wall";
    const now = performance.now();
    if (s.cooldowns[kind] > now) return;
    const view = currentView();
    if (!view || view.over || !canPlace(view, kind, x, y, s.tool === "across")) return;
    s.cooldowns[kind] = now + TOOL_COOLDOWN_MS;
    if (s.kind === "local") {
      s.places.push({ tool: s.tool, x, y, done: (ok) => !ok && (s.cooldowns[kind] = 0) });
    } else {
      s.send({ type: "place", tool: s.tool, x, y });
    }
    renderTools();
  }

  /* ---- Pause ---- */

  function setPaused(paused) {
    const s = session;
    if (s?.kind !== "local" || s.state.over || s.paused === paused) return;
    s.paused = paused;
    s.acc = 0;
    document.body.classList.toggle("party-pause", s.party);
    $("pauseOverlay").classList.toggle("hidden", !paused);
    if (paused) $("continueBtn").focus();
    else document.activeElement?.blur?.();
    s.onTick?.(s.state);
  }

  function pauseAll() {
    if (session?.kind === "local") setPaused(true);
    if (session?.kind === "replay") setReplayPlaying(false);
  }

  /* ---- Seeds ---- */

  function renderSeed(seed) {
    document.querySelectorAll(".seed-code").forEach((el) => {
      el.textContent = seed;
    });
  }

  async function copyText(text, btn, selectEl) {
    const label = btn.querySelector(".copy-label");
    try {
      await navigator.clipboard.writeText(text);
      label.textContent = "Copied";
    } catch {
      // No clipboard, as on a page not served over https: select it instead.
      if (selectEl instanceof HTMLInputElement) selectEl.select();
      else getSelection()?.selectAllChildren(selectEl);
      label.textContent = "Selected";
    }
    setTimeout(() => {
      label.textContent = "Copy";
    }, 1500);
  }

  /* ---- The pre-game screen ---- */

  function showStart({ message = "" } = {}) {
    stopReplayView();
    if (session?.kind === "local" && !session.state.over && !session.party) session.paused = true;
    session = null;
    finished = null;
    hideOverlays();
    document.body.classList.remove("playing");
    $("toolDock").hidden = true;
    setNote("");
    renderHud();
    const s = getSettings();
    $("startLevel").value = String(s.start_level);
    syncLevelChips();
    $("startSummary").textContent = describeSettings(s);
    $("startMsg").textContent = message;
    $("startOverlay").classList.remove("hidden");
    queueLayout();
    dirty = true;
    $("playBtn").focus();
  }

  function renderEditions() {
    const list = $("editionList");
    list.hidden = EDITIONS.length < 2;
    list.innerHTML = EDITIONS.map(
      (e, i) =>
        `<button class="edition${i === 0 ? " active" : ""}" type="button" role="radio" aria-checked="${i === 0}" data-edition="${e.id}">` +
        `<span class="edition-name">${escapeHtml(e.name)}</span><span class="edition-about">${escapeHtml(e.about)}</span></button>`
    ).join("");
  }

  function syncLevelChips() {
    const v = $("startLevel").value;
    document.querySelectorAll("#levelChips [data-level]").forEach((el) => {
      const on = el.dataset.level === v;
      el.classList.toggle("active", on);
      el.setAttribute("aria-pressed", String(on));
    });
  }

  function onStartSubmit(event) {
    event.preventDefault();
    const raw = $("startLevel").value.trim();
    const level = raw === "" ? 0 : Number(raw);
    if (!Number.isInteger(level) || level < 0 || level > MAX_START_LEVEL) {
      $("startMsg").textContent = `Start at a level from 0 to ${MAX_START_LEVEL}.`;
      $("startLevel").focus();
      return;
    }
    saveSettings({ start_level: level });
    const seed = cleanSeed($("startSeed").value);
    $("startSeed").value = "";
    startSolo({ seed: seed || makeSeed(), startLevel: level });
  }

  /* ---- Game over ---- */

  function showOver() {
    const f = finished;
    const r = f.result;
    f.overAt = performance.now();
    const party = f.session.party || f.remote;
    $("gameOverOverlay").classList.toggle("party", Boolean(party));
    $("gameOverTitle").textContent = party
      ? partyTitle(f)
      : r.reason === "time"
        ? "Time's up"
        : f.newBest
          ? "New best"
          : "Game over";
    $("overCause").textContent = party ? "" : r.reason === "time" ? "The game clock ran out." : `The snake ${CAUSES[r.snakes[0].cause] ?? "stopped"}.`;
    $("finalScore").textContent = String(r.score);
    $("finalLevel").textContent = String(r.level);
    $("finalLength").textContent = String(r.length);
    $("finalTime").textContent = clock(r.durationMs);
    $("partyResults").innerHTML = party ? partyRows(f) : "";
    renderSeed(f.replay.seed);
    $("shareMsg").textContent = "";
    $("shareLinkRow").hidden = true;

    const prefs = getSettings();
    const unavailable = party
      ? "Party games stay off the leaderboard."
      : r.autoplayed
        ? "Autoplay played this game, so it cannot go on the leaderboard."
        : f.session.run?.failed
          ? "This game started without a connection, so it cannot go on the leaderboard."
          : r.fruits === 0
            ? "Eat at least one fruit to go on the leaderboard."
            : "";
    $("submitForm").classList.toggle("hidden", Boolean(unavailable));
    $("submitUnavailable").textContent = unavailable;
    $("submitUnavailable").classList.toggle("hidden", !unavailable);
    $("submitted").classList.add("hidden");
    $("submitMsg").textContent = "";
    $("nameInput").value = prefs.name ?? "";
    $("submitBtn").disabled = false;
    $("lobbyBtn").classList.toggle("hidden", !party);
    $("playAgainBtn").classList.toggle("hidden", Boolean(party));

    $("gameOverOverlay").classList.remove("hidden");
    (party ? $("replayBtn") : $("playAgainBtn")).focus();
    if (!unavailable && prefs.auto_submit && prefs.name) submitAs(prefs.name, true);
  }

  function partyTitle(f) {
    const r = f.result;
    if (r.reason === "time" && f.replay.mode === "coop") return "Time's up";
    if (f.replay.mode === "coop") return "Game over";
    if (r.winner === null) return r.snakes.length > 1 ? "A draw" : "Game over";
    return `${f.replay.players[r.winner] ?? "Player"} wins`;
  }

  function partyRows(f) {
    const order = f.result.snakes.map((s, i) => ({ ...s, i })).sort((a, b) => b.score - a.score);
    return `<ol class="party-results">${order
      .map(
        (s) =>
          `<li><span class="dot" style="background:var(--snake-${(s.i % 4) + 1})"></span>` +
          `<span class="pr-name">${escapeHtml(f.replay.players[s.i] ?? `Player ${s.i + 1}`)}</span>` +
          `<span class="pr-score">${s.score}</span><span class="pr-len">length ${s.length}</span></li>`
      )
      .join("")}</ol>`;
  }

  // Adds the game under a name, typed or saved. Any name that goes through
  // becomes the saved one. A failure leaves the form in place, so a game
  // that ended offline can be added once the connection is back.
  async function submitAs(name, auto = false) {
    const f = finished;
    const mine = f?.session.run;
    const msg = $("submitMsg");
    if (!mine || !f) return;

    $("submitBtn").disabled = true;
    msg.textContent = auto ? `Adding as ${name}.` : "Adding.";
    await mine.ready;
    if (f !== finished) return;
    if (!mine.id) {
      msg.textContent = "This game started without a connection, so it cannot go on the leaderboard.";
      return;
    }

    const { seed, settings, ticks, events } = f.replay;
    try {
      const r = await api.submit(mine.id, name, { seed, settings, ticks, events });
      if (f !== finished) return;
      saveSettings({ name: r.name });
      f.replayId = r.replay_id;
      f.submitted = r;
      $("submittedText").textContent = `Added as ${r.name}: ${r.score} points. Ranked ${r.rank} for best score and ${r.total_rank} for total points.`;
      $("submitForm").classList.add("hidden");
      $("submitted").classList.remove("hidden");
      msg.textContent = "";
    } catch (err) {
      if (f !== finished) return;
      const final = ["already_submitted", "expired", "not_found", "implausible", "seed_used", "no_fruit"].includes(err.code);
      if (err.code === "offline") msg.textContent = "No connection. Try again once you are back online.";
      else if (auto && err.status === 400 && /name/.test(err.code)) msg.textContent = "Your saved name was refused, so this game was not added. Change it in Settings.";
      else if (auto && !final) msg.textContent = "This game could not be added automatically. Try the button.";
      else msg.textContent = err.message || "That did not go through. Try again in a moment.";
      $("submitBtn").disabled = final;
    }
  }

  /* ---- Sharing a replay ----
     Online the link is short, /r/<id>, stored by the API; a game already on
     the leaderboard has one from submitting. Offline, or if storing fails,
     the whole game travels in a longer link of its own. */

  async function linkFor(f) {
    if (f.replayId) return `${location.origin}/r/${f.replayId}`;
    try {
      const { id } = await api.createReplay(f.replay);
      f.replayId = id;
      return `${location.origin}/r/${id}`;
    } catch {
      return `${location.origin}/?replay=${await packReplay(f.replay)}`;
    }
  }

  async function shareReplay(f, btn, msgEl, rowEl, inputEl) {
    btn.disabled = true;
    msgEl.textContent = "Making a link.";
    try {
      const url = await linkFor(f);
      inputEl.value = url;
      rowEl.hidden = false;
      const text = `${f.result.score} points in Snake Game. Watch how it went:`;
      if (navigator.share && isTouch()) {
        try {
          await navigator.share({ title: "Snake Game replay", text, url });
          msgEl.textContent = "Shared.";
          return;
        } catch (err) {
          if (err?.name === "AbortError") {
            msgEl.textContent = "";
            return;
          }
        }
      }
      try {
        await navigator.clipboard.writeText(url);
        msgEl.textContent = url.includes("/r/") ? "Link copied." : "Link copied. It holds the whole game, so it is long.";
      } catch {
        inputEl.select();
        msgEl.textContent = "Copy the link below.";
      }
    } finally {
      btn.disabled = false;
    }
  }

  /* ---- Instant replay ---- */

  let replaySpeed = 1;

  function openReplay(replay, { verified = false, shared = false } = {}) {
    let player;
    try {
      player = new ReplayPlayer(replay);
    } catch (err) {
      console.warn("replay did not play:", err);
      return false;
    }
    pauseAll();
    if (session?.kind !== "replay") returnTo = { session, over: !$("gameOverOverlay").classList.contains("hidden"), start: !$("startOverlay").classList.contains("hidden") };
    hideOverlays();
    $("toolDock").hidden = true;
    session = { kind: "replay", player, replay, playing: false, acc: 0, names: replay.players, shared };
    document.body.classList.add("replaying");
    replayBar.hidden = false;
    $("replaySeedBtn").classList.toggle("hidden", !shared);
    $("replayNote").textContent = shared
      ? verified
        ? `Checked by the leaderboard. ${replay.players.join(", ")}.`
        : `Shared replay, not from the leaderboard. ${replay.players.join(", ")}.`
      : "";
    $("replayNote").hidden = !shared;
    seek.max = String(player.ticks);
    const last = Math.max(1, player.ticks);
    $("replayMarks").innerHTML =
      player.eatTicks.map((t) => `<span style="left: ${(t / last) * 100}%"></span>`).join("") +
      `<span class="end" style="left: 100%"></span>`;
    setNote("");
    renderReplay();
    setReplayPlaying(true);
    queueLayout();
    $("replayPlay").focus();
    return true;
  }

  function stopReplayView() {
    if (session?.kind !== "replay") return;
    replayBar.hidden = true;
    document.body.classList.remove("replaying");
    session = null;
  }

  function closeReplay() {
    if (session?.kind !== "replay") return;
    const back = returnTo;
    returnTo = null;
    stopReplayView();
    if (back?.session) {
      session = back.session;
      if (session.kind === "remote" && remote) session = remote;
      if (back.over) $("gameOverOverlay").classList.remove("hidden");
      else if (session.kind === "local" && !session.state.over) $("pauseOverlay").classList.remove("hidden");
      showTools();
      renderHud();
      queueLayout();
      dirty = true;
      ($("gameOverOverlay").classList.contains("hidden") ? $("continueBtn") : $("replayBtn")).focus();
      return;
    }
    if (location.pathname !== "/" || location.search) history.replaceState(null, "", "/");
    showStart();
  }

  function setReplayPlaying(playing) {
    const r = session;
    if (r?.kind !== "replay") return;
    if (playing && r.player.tick >= r.player.ticks) r.player.seek(0);
    r.playing = playing;
    r.acc = 0;
    const btn = $("replayPlay");
    btn.innerHTML = icon(playing ? "pause" : "play");
    btn.setAttribute("aria-label", playing ? "Pause replay" : "Play replay");
    // Read out while stepping, not many times a second while playing.
    $("replayCaption").setAttribute("aria-live", playing ? "off" : "polite");
    renderReplay();
  }

  function setReplaySpeed(speed, { save = true } = {}) {
    if (!REPLAY_SPEEDS.includes(speed)) return;
    replaySpeed = speed;
    if (save) store.set(SPEED_KEY, String(speed));
    $("replaySpeed").querySelectorAll("[data-speed]").forEach((el) => {
      const on = Number(el.dataset.speed) === speed;
      el.classList.toggle("active", on);
      el.setAttribute("aria-checked", String(on));
    });
  }

  function stepReplay(dir) {
    const r = session;
    if (r?.kind !== "replay") return;
    setReplayPlaying(false);
    if (dir < 0) r.player.seek(r.player.tick - 1);
    else r.player.forward();
    renderReplay();
    dirty = true;
  }

  // Game time runs as it did, times the speed picked.
  function updateReplay(dt) {
    const r = session;
    if (!r.playing) return false;
    r.acc += dt * replaySpeed;
    let moved = false;
    while (r.acc >= r.player.durationAt(r.player.tick)) {
      r.acc -= r.player.durationAt(r.player.tick);
      r.player.forward();
      moved = true;
    }
    if (r.player.tick >= r.player.ticks) setReplayPlaying(false);
    if (moved) renderReplay();
    return moved;
  }

  function describe(h, names, solo) {
    const who = (i) => (solo ? "The snake" : names[i] ?? `Player ${i + 1}`);
    switch (h.type) {
      case "crash":
        return { text: `${who(h.snake)} ${CAUSES[h.cause]}`, bad: true };
      case "end":
        return h.reason === "time" ? { text: "Time's up", bad: false } : null;
      case "eat": {
        const how = h.moves <= h.par ? "by the shortest way" : `in ${h.moves} moves, shortest ${h.par}`;
        return { text: `${who(h.snake)} ate ${h.extra ? "an extra fruit" : "a fruit"}, +${h.points}, ${how}` };
      }
      case "level":
        return { text: `Level ${h.level}` };
      case "timeout":
        return { text: "Too slow: the fruit moved", bad: true };
      case "wall":
        return { text: "A watcher dropped a wall" };
      case "drop":
        return { text: "A watcher dropped an extra fruit" };
      case "autoplay":
        return { text: h.on ? "Autoplay on" : "Autoplay off" };
      case "turn":
        return { text: `${who(h.snake)} turned ${DIR_NAMES[h.dir]}` };
      default:
        return null;
    }
  }

  const PRIORITY = ["crash", "end", "eat", "level", "timeout", "wall", "drop", "autoplay", "turn"];

  // What the last thing to happen was, up to this tick.
  function captionAt(player, tick) {
    const solo = player.replay.mode === "solo";
    for (let t = tick; t >= Math.max(1, tick - 400); t -= 1) {
      const list = player.happened.get(t);
      if (!list) continue;
      const lines = [...list]
        .sort((a, b) => PRIORITY.indexOf(a.type) - PRIORITY.indexOf(b.type))
        .map((h) => describe(h, player.replay.players, solo))
        .filter(Boolean);
      if (lines.length) return { text: lines[0].text, bad: lines.some((l) => l.bad) && t === tick };
    }
    return { text: "The game starts", bad: false };
  }

  const put = (el, text) => {
    if (el.textContent !== text) el.textContent = text;
  };

  function renderReplay() {
    const r = session;
    const p = r.player;
    const caption = captionAt(p, p.tick);
    put($("replayCaption"), caption.text);
    $("replayCaption").classList.toggle("bad", caption.bad);
    put($("replayTime"), `${clock(p.timeAt[p.tick])} / ${clock(p.timeAt[p.ticks])}`);
    seek.value = String(p.tick);
    $("replayMarks").style.setProperty("--played", `${(p.tick / Math.max(1, p.ticks)) * 100}%`);
    const valueText = `${clock(p.timeAt[p.tick])}, ${caption.text}`;
    if (seek.getAttribute("aria-valuetext") !== valueText) seek.setAttribute("aria-valuetext", valueText);
    renderHud();
    dirty = true;
  }

  function onReplayKey(e) {
    const key = e.key;
    const on = e.target instanceof Element ? e.target : null;
    if (key === "Escape") {
      closeReplay();
    } else if (key === "F1" || key === "F2") {
      e.preventDefault();
    } else if (key === " ") {
      if (on?.closest("button, a")) return;
      e.preventDefault();
      if (!e.repeat) setReplayPlaying(!session.playing);
    } else if ((key === "ArrowLeft" || key === "ArrowRight") && !on?.closest("input")) {
      e.preventDefault();
      stepReplay(key === "ArrowRight" ? 1 : -1);
    } else if ((key === "Home" || key === "End") && !on?.closest("input")) {
      e.preventDefault();
      setReplayPlaying(false);
      session.player.seek(key === "End" ? session.player.ticks : 0);
      renderReplay();
    }
  }

  /* ---- Keys ---- */

  function onKeyDown(e) {
    if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
    // A window is open: Esc that closed it closes only that.
    if (e.defaultPrevented || document.body.classList.contains("modal-open")) return;
    if (session?.kind === "replay") {
      onReplayKey(e);
      return;
    }
    if (e.target instanceof Element && e.target.closest("input, textarea, select, [contenteditable]")) return;
    const key = e.key;

    if (key === "F2") {
      // Autoplay, on and off. Kept out of every hint on purpose.
      e.preventDefault();
      if (!e.repeat) toggleAutoplay();
      return;
    }
    if (key === "F1") {
      // The browser's help, otherwise.
      e.preventDefault();
      if (session?.kind === "local" && !session.party) startSolo({ startLevel: session.state.settings.start_level });
      return;
    }

    const dir = KEY_DIRS[key] ?? CODE_DIRS[e.code];
    if (dir !== undefined && session && !session.paused && !(session.kind === "local" && session.state.over)) {
      if ($("gameOverOverlay").classList.contains("hidden") && $("startOverlay").classList.contains("hidden")) {
        e.preventDefault();
        steer(dir);
        return;
      }
    }

    if (key === " ") {
      // Over a panel, Space on a focused button presses it.
      if (e.target instanceof Element && e.target.closest("button, a") && !$("startOverlay").classList.contains("hidden")) return;
      if (finished && !finished.session.party && !$("gameOverOverlay").classList.contains("hidden")) {
        if (e.target instanceof Element && e.target.closest("button, a")) return;
        e.preventDefault();
        // Not in the first moment, so a late Space does not throw away a score.
        if (!e.repeat && performance.now() - finished.overAt > SPACE_RESTART_DELAY_MS) playAgain();
        return;
      }
      if (session?.kind === "local" && !session.state.over) {
        if (session.paused && e.target instanceof Element && e.target.closest("button, a")) return;
        e.preventDefault();
        // Alone, or hosting: a host's pause stops the game for everybody.
        if (!e.repeat) setPaused(!session.paused);
      }
      return;
    }
    if (key === "Escape" && session?.kind === "local" && !session.state.over && !session.paused) {
      setPaused(true);
    }
  }

  function playAgain() {
    const level = finished?.session?.state.settings.start_level ?? getSettings().start_level;
    startSolo({ startLevel: level });
  }

  /* ---- The loop ---- */

  let last = performance.now();
  let lastSecond = -1;
  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(250, now - last);
    last = now;
    if (fitCanvas()) dirty = true;
    if (session?.kind === "local") {
      if (updateLocal(dt, now)) dirty = true;
    } else if (session?.kind === "replay") {
      if (updateReplay(dt)) dirty = true;
    }
    if (session?.cooldowns) renderTools(now);
    // The clock in the stats ticks over once a second even between moves.
    const view = currentView();
    const second = view ? Math.floor(view.timeMs / 1000) : -1;
    if (second !== lastSecond) {
      lastSecond = second;
      renderHud();
    }
    // Only drawn when something changed or is moving: an idle board costs
    // nothing, and a phone's battery and a busy host both feel the difference.
    const gliding = view && motionFor(view, now) !== null;
    if (dirty || gliding || (view && animating(view)) || (aim && watching())) {
      dirty = false;
      draw(now);
    }
  }

  /* ---- Party games, from js/party.js ---- */

  // A party game another device hosts.
  function startRemote({ seats, mySeat, watching: watch, send }) {
    stopReplayView();
    gameNumber += 1;
    remote = {
      kind: "remote",
      party: true,
      view: null,
      names: seats,
      mySeat,
      watching: watch,
      send,
      tool: "across",
      cooldowns: { wall: 0, fruit: 0 },
    };
    session = remote;
    finished = null;
    hideOverlays();
    document.body.classList.add("playing", "guest");
    showTools();
    queueLayout();
  }

  function showRemote(view, { countdown = 0, paused = false } = {}) {
    if (!remote) return;
    remote.view = view;
    remote.viewAt = performance.now();
    remote.paused = paused;
    remote.countdown = countdown;
    if (session !== remote) return;
    renderSeed(view.seed);
    setNote(countdown > 0 ? String(Math.ceil(countdown / 1000)) : paused ? "Paused by the host" : remote.watching && !view.over ? watchNote() : "");
    renderHud();
    dirty = true;
  }

  function remoteOver(result, replay) {
    if (!remote) return;
    finished = { session: remote, remote: true, result, replay, replayId: null, overAt: 0 };
    if (session === remote) showOver();
  }

  function placeRefused(kind) {
    const s = remote ?? session;
    if (s?.cooldowns) s.cooldowns[kind] = 0;
  }

  function endParty() {
    if (session?.kind === "replay" && returnTo?.session?.party) returnTo = null;
    remote = null;
    document.body.classList.remove("guest");
    if (session?.party || session?.kind === "remote") showStart();
  }

  /* ---- Wiring ---- */

  window.addEventListener("resize", queueLayout);
  window.visualViewport?.addEventListener("resize", queueLayout);
  if ("ResizeObserver" in window) {
    const ro = new ResizeObserver(queueLayout);
    for (const id of ["hudLeft", "replayBar", "toolDock"]) ro.observe($(id));
  }
  // The tray's open state and the update bar both move the board.
  new MutationObserver(queueLayout).observe($("tray"), { attributes: true, attributeFilter: ["class"] });
  // The canvas redraws in the theme's colours whenever they change, and the
  // update bar publishes its height on the same element.
  new MutationObserver(() => {
    palette = readPalette();
    dirty = true;
    queueLayout();
  }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-mode", "data-color-theme", "style"] });

  window.addEventListener("keydown", onKeyDown);
  stage.addEventListener("pointerdown", onPointerDown);
  stage.addEventListener("pointermove", onPointerMove);
  stage.addEventListener("pointerup", onPointerUp);
  stage.addEventListener("pointercancel", () => {
    gesture = null;
  });
  stage.addEventListener("pointerleave", (e) => {
    if (e.pointerType === "mouse" && aim) {
      aim = null;
      dirty = true;
    }
  });
  // Belt and braces for iOS, which can still start a page gesture from a
  // touch that touch-action has already claimed.
  stage.addEventListener("touchmove", (e) => e.preventDefault(), { passive: false });
  stage.addEventListener("contextmenu", (e) => e.preventDefault());
  $("brand").addEventListener("pointerdown", onBrandTap);

  $("pauseBtn").addEventListener("click", () => {
    if (session?.kind === "local") setPaused(!session.paused);
  });
  $("continueBtn").addEventListener("click", () => setPaused(false));
  $("restartBtn").addEventListener("click", () => startSolo({ startLevel: session?.state?.settings.start_level }));
  $("pauseNewBtn").addEventListener("click", () => showStart());
  $("playAgainBtn").addEventListener("click", playAgain);
  $("newGameBtn").addEventListener("click", () => {
    if (finished?.session?.party) hooks.onLeaveParty?.();
    else showStart();
  });
  $("lobbyBtn").addEventListener("click", () => hooks.onBackToLobby?.());
  $("replayBtn").addEventListener("click", () => finished && openReplay(finished.replay));
  $("shareBtn").addEventListener("click", () => finished && shareReplay(finished, $("shareBtn"), $("shareMsg"), $("shareLinkRow"), $("shareLink")));
  $("copyLinkBtn").addEventListener("click", () => copyText($("shareLink").value, $("copyLinkBtn"), $("shareLink")));
  $("resultBoardBtn").addEventListener("click", () => openLeaderboard());
  $("submitForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const name = $("nameInput").value.trim();
    if (!name) {
      $("submitMsg").textContent = "Enter a name.";
      $("nameInput").focus();
      return;
    }
    submitAs(name);
  });
  document.querySelectorAll("[data-copy-seed]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const code = btn.closest(".seed-line").querySelector(".seed-code");
      copyText(code.textContent, btn, code);
    })
  );

  $("startForm").addEventListener("submit", onStartSubmit);
  $("startLevel").addEventListener("input", syncLevelChips);
  $("levelChips").addEventListener("click", (e) => {
    const chip = e.target.closest("[data-level]");
    if (!chip) return;
    $("startLevel").value = chip.dataset.level;
    syncLevelChips();
  });
  $("startSettingsBtn").addEventListener("click", openSettings);
  $("editionList").addEventListener("click", (e) => {
    const card = e.target.closest("[data-edition]");
    if (!card) return;
    document.querySelectorAll("#editionList [data-edition]").forEach((el) => {
      el.classList.toggle("active", el === card);
      el.setAttribute("aria-checked", String(el === card));
    });
  });
  document.addEventListener("uwusnek:settings", () => {
    $("startSummary").textContent = describeSettings();
  });

  $("toolDock").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-tool]");
    if (!btn || !session?.cooldowns) return;
    session.tool = btn.dataset.tool;
    renderTools();
    dirty = true;
  });

  $("replayPlay").addEventListener("click", () => setReplayPlaying(!session?.playing));
  $("replayBack").addEventListener("click", () => stepReplay(-1));
  $("replayForward").addEventListener("click", () => stepReplay(1));
  $("replayClose").addEventListener("click", closeReplay);
  $("replaySeedBtn").addEventListener("click", () => {
    const r = session?.replay;
    if (!r) return;
    returnTo = null;
    stopReplayView();
    history.replaceState(null, "", "/");
    showStart();
    $("startSeed").value = r.seed;
    $("startLevel").value = String(r.settings.start_level);
    syncLevelChips();
    $("startMsg").textContent = "The replay's seed is filled in. Your own difficulty and time limits apply.";
  });
  $("replaySpeed").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-speed]");
    if (btn) setReplaySpeed(Number(btn.dataset.speed));
  });
  setReplaySpeed(Number(store.get(SPEED_KEY)) || 1, { save: false });
  // A click on a replay button leaves focus where it was, so Space goes on
  // playing and pausing rather than pressing that button again.
  replayBar.querySelectorAll("button").forEach((btn) => btn.addEventListener("pointerdown", (e) => e.preventDefault()));
  // Scrubbing: dragging the timeline pauses, moves the board with the
  // thumb, and carries on playing from where it was let go if it was
  // playing before, unless that is the end.
  let resumeAfterScrub = false;
  const startScrub = () => {
    if (session?.kind !== "replay") return;
    if (session.playing) resumeAfterScrub = true;
    setReplayPlaying(false);
  };
  const endScrub = () => {
    if (session?.kind !== "replay" || !resumeAfterScrub) return;
    resumeAfterScrub = false;
    if (session.player.tick < session.player.ticks) setReplayPlaying(true);
  };
  seek.addEventListener("pointerdown", startScrub);
  seek.addEventListener("input", () => {
    if (session?.kind !== "replay") return;
    if (session.playing) startScrub();
    session.player.seek(Number(seek.value));
    renderReplay();
  });
  seek.addEventListener("change", endScrub);
  seek.addEventListener("pointerup", endScrub);
  seek.addEventListener("pointercancel", endScrub);

  // Leaving the tab pauses a game on this device, so nothing is lost.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") pauseAll();
  });

  renderEditions();
  hydrateIcons();
  layout();
  requestAnimationFrame(frame);

  return {
    pause: pauseAll,
    showStart,
    openReplay,
    startHost,
    startRemote,
    showRemote,
    remoteOver,
    placeRefused,
    endParty,
    queueInput: enqueue,
    // A watcher's wall or fruit from a guest, applied at the next move.
    queuePlace: (tool, x, y) =>
      new Promise((resolve) => {
        if (session?.kind !== "local" || !session.party) return resolve(false);
        session.places.push({ tool, x, y, done: resolve });
      }),
    get session() {
      return session;
    },
    localState: () => (session?.kind === "local" ? session.state : returnTo?.session?.kind === "local" ? returnTo.session.state : null),
    setPausedByHost: (paused) => session?.kind === "local" && session.party && setPaused(paused),
  };
}
