// Slither, on screen: the world on the full-screen canvas, steering by
// pointer or finger, boosting, the join code top left, dying and playing
// again, instant replays and sharing them, the skin builder, and the
// networking that lets anyone on the same network drop into the world.
//
// Everyone in a world runs it side by side. The device that started it is
// the host: it gathers every player's input, stamps each with the tick it
// lands on, steps the world and sends those inputs on, twenty-odd times a
// second. Joiners start from a snapshot and step their own copy with the
// same inputs, so the copies stay identical (js/slither-rules.js), checked
// by a fingerprint every two seconds. Because every joiner holds the whole
// world, when the host leaves the first of them to have joined carries on
// hosting it under the same code, and the rest reconnect to them.

import { api } from "./api.js";
import { icon } from "./icons.js";
import { CODE_LENGTH, Guest, Host, PROTOCOL_VERSION, generateCode } from "./p2p.js";
import { qrToSvg } from "./qr.js";
import { makeSeed } from "./seed.js";
import { getSettings, saveSettings } from "./settings.js";
import {
  ANG,
  RULES_VERSION,
  SUB,
  TICK_MS,
  angleDiff,
  applyEvent,
  autoSteer,
  iatan2,
  newWorld,
  radiusOf,
  restore,
  snakeOf,
  snapshot,
  standings,
  step,
  worldHash,
} from "./slither-rules.js";
import { SlitherPlayer, cleanSlitherReplay } from "./slither-replay.js";
import { drawPreview, drawWorld, readTheme } from "./slither-render.js";
import { MAX_COLORS, OUTFITS, PALETTE, PATTERNS, PRESETS, cleanSkin, parseSkin, saveName, saveSkin, skinCode, storedName, storedSkin } from "./slither-skins.js";
import { closeModal, escapeHtml, hydrateIcons, openModal, store } from "./ui.js";

const MAX_JOINERS = 12;
const BEST_KEY = "uwusnek.slitherBest";
const PID_KEY = "uwusnek.partyId";
const SPEED_KEY = "uwusnek.replaySpeed";
const REPLAY_SPEEDS = [0.5, 1, 2, 4];
const REPLAY_STEP = 8; // ticks, a quarter of a second
const HASH_EVERY = 64;
const CHUNK = 16000;
const OVER_DELAY_MS = 1100;
const TRIPLE_TAP_MS = 400;
const ANGLE_STEP = 6; // the least change of heading worth sending

const $ = (id) => document.getElementById(id);
const isTouch = () => window.matchMedia("(pointer: coarse)").matches || (navigator.maxTouchPoints || 0) > 0;
const clock = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

function browserId() {
  let id = store.get(PID_KEY);
  if (!/^[A-Za-z0-9]{12}$/.test(id ?? "")) {
    id = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => "abcdefghijkmnpqrstuvwxyz23456789"[b % 32]).join("");
    store.set(PID_KEY, id);
  }
  return id;
}

export function playerName() {
  return storedName(store) || getSettings().name || "Player";
}

export function initSlither({ showStart }) {
  const canvas = $("world");
  const ctx = canvas.getContext("2d", { alpha: false, desynchronized: true }) ?? canvas.getContext("2d");
  let theme = readTheme();
  let w = 0;
  let h = 0;
  let dpr = 1;

  /* ---- State ---- */

  let active = false; // in a world
  let world = null;
  let prev = null; // each snake's positions a tick ago, for drawing between ticks
  let role = null; // "host" or "guest"
  let me = 0; // this player's id in the world
  let acc = 0; // ms into the next tick, when hosting
  let lastTickAt = 0; // when the last tick was stepped, when joined
  let paused = false;
  let pending = []; // inputs for the next tick, when hosting
  let frames = []; // ticks from the host waiting to be stepped, when joined
  let fresh = false; // a world started here and not yet stepped
  let life = null; // this life: where it began, for the replay
  let log = []; // every input since this life began
  let deathAt = null;
  let lastHead = null; // where the camera was, for after a death
  let finished = null; // the last life, for the panel and its replay
  let autoplay = false;
  let zoom = 1;
  let replay = null; // a replay on screen

  const input = { angle: 0, boost: false, keyTurn: 0, keyBoost: false, mouseBoost: false, touchBoost: false, buttonBoost: false, applied: -1, appliedBoost: false, sentAt: 0 };

  /* ---- Canvas ---- */

  function fit() {
    const vv = window.visualViewport;
    const nw = Math.round(vv ? vv.width : window.innerWidth);
    const nh = Math.round(vv ? vv.height : window.innerHeight);
    const quality = getSettings().graphics;
    const ratio = quality === "low" ? 1 : Math.min(2, window.devicePixelRatio || 1);
    if (nw === w && nh === h && ratio === dpr) return;
    w = nw;
    h = nh;
    dpr = ratio;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }

  /* ---- Entering and leaving ---- */

  function enter() {
    active = true;
    document.body.classList.add("slither", "playing");
    document.body.classList.remove("guest");
    for (const id of ["startOverlay", "pauseOverlay", "gameOverOverlay", "slitherOver"]) $(id).classList.add("hidden");
    $("slitherHud").hidden = false;
    $("boostBtn").hidden = !isTouch();
    fit();
    wakeLock(true);
  }

  // A new world, hosted here from its first tick.
  function start({ seed = makeSeed() } = {}) {
    stopNet();
    world = newWorld(seed);
    fresh = true;
    role = "host";
    me = 0;
    pending = [[2, me, playerName(), storedSkin(store), browserId()]];
    frames = [];
    acc = 0;
    paused = false;
    autoplay = false;
    finished = null;
    life = null;
    deathAt = null;
    nextPlayer = 1;
    enter();
    renderSeed();
    startHosting();
  }

  function leave() {
    closeReplay(false);
    if (role === "host" && guestsConnected() > 0) handOver();
    else if (role === "guest") net.guest?.send({ type: "bye" });
    stopNet();
    active = false;
    world = null;
    replay = null;
    document.body.classList.remove("slither", "playing");
    $("slitherHud").hidden = true;
    $("boostBtn").hidden = true;
    $("slitherOver").classList.add("hidden");
    setNote("");
    wakeLock(false);
    showStart();
  }

  /* ---- Input ---- */

  // Steering points from the head, which is the middle of the screen,
  // towards the pointer or finger.
  function aimAt(x, y) {
    const dx = x - w / 2;
    const dy = y - h / 2;
    if (dx * dx + dy * dy < 16) return;
    input.angle = iatan2(Math.round(dy * 8), Math.round(dx * 8));
    input.keyTurn = 0;
  }

  const boosting = () => input.keyBoost || input.mouseBoost || input.touchBoost || input.buttonBoost;
  const pointers = new Map();

  function onPointerDown(e) {
    if (!active || replay) return;
    if (e.pointerType === "mouse") {
      if (e.button === 0) input.mouseBoost = true;
      aimAt(e.clientX, e.clientY);
      return;
    }
    e.preventDefault();
    pointers.set(e.pointerId, true);
    // A second finger down boosts while it stays down.
    if (pointers.size > 1) input.touchBoost = true;
    else aimAt(e.clientX, e.clientY);
  }

  function onPointerMove(e) {
    if (!active || replay) return;
    if (e.pointerType === "mouse" || pointers.size <= 1 || e.isPrimary) aimAt(e.clientX, e.clientY);
  }

  function onPointerUp(e) {
    if (e.pointerType === "mouse") {
      if (e.button === 0) input.mouseBoost = false;
      return;
    }
    pointers.delete(e.pointerId);
    if (pointers.size < 2) input.touchBoost = false;
  }

  const TURN_KEYS = { ArrowLeft: -1, KeyA: -1, ArrowRight: 1, KeyD: 1 };

  function onKeyDown(e) {
    if (!active && !replay) return;
    if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
    if (e.defaultPrevented || document.body.classList.contains("modal-open")) return;
    if (replay) return onReplayKey(e);
    if (e.target instanceof Element && e.target.closest("input, textarea, select")) return;
    if (e.key === "F2") {
      // Autoplay, on and off. Kept out of every hint on purpose.
      e.preventDefault();
      if (!e.repeat) toggleAutoplay();
      return;
    }
    if (e.key === "Escape") {
      if (canPause()) setPaused(!paused);
      return;
    }
    if (!$("slitherOver").classList.contains("hidden")) return;
    const turn = TURN_KEYS[e.code] ?? TURN_KEYS[e.key];
    if (turn) {
      e.preventDefault();
      input.keyTurn = turn;
      return;
    }
    if (e.key === " " || e.code === "KeyW" || e.key === "ArrowUp") {
      e.preventDefault();
      input.keyBoost = true;
    }
  }

  function onKeyUp(e) {
    const turn = TURN_KEYS[e.code] ?? TURN_KEYS[e.key];
    if (turn && input.keyTurn === turn) input.keyTurn = 0;
    if (e.key === " " || e.code === "KeyW" || e.key === "ArrowUp") input.keyBoost = false;
  }

  // Held arrow keys turn the heading round, a little every frame.
  function keySteer(dt) {
    if (!input.keyTurn) return;
    input.angle = (input.angle + Math.round(input.keyTurn * dt * 0.9)) & (ANG - 1);
  }

  // What this player wants this tick: their own steering, or autoplay's.
  function wanted() {
    if (autoplay && world && snakeOf(world, me)) return autoSteer(world, me);
    return { angle: input.angle, boost: boosting() };
  }

  /* ---- Autoplay ----
     F2, or three quick taps on the game's name on a touch screen. It
     steers for the player with the computer's sharpest steering. A life it
     touched does not count towards the best on this device. */

  function toggleAutoplay() {
    if (!active || !world) return;
    autoplay = !autoplay;
    if (autoplay && life) life.autoplayed = true;
    sendOrQueue([5, me, autoplay ? 1 : 0], { type: "auto", on: autoplay ? 1 : 0 });
  }

  let taps = 0;
  let lastTapAt = 0;
  function onBrandTap(e) {
    if (!active || e.pointerType !== "touch") return;
    e.preventDefault();
    const now = performance.now();
    taps = now - lastTapAt <= TRIPLE_TAP_MS ? taps + 1 : 1;
    lastTapAt = now;
    if (taps < 3) return;
    taps = 0;
    toggleAutoplay();
  }

  // An input from this player: queued for the next tick when hosting, sent
  // to the host when joined.
  function sendOrQueue(event, message) {
    if (role === "host") pending.push(event);
    else net.guest?.send(message);
  }

  /* ---- Ticks ---- */

  function keepPrev() {
    prev = new Map(world.snakes.map((s) => [s.id, { xs: [...s.xs], ys: [...s.ys] }]));
  }

  // A life begins when this player's snake spawns: the world as it stood
  // just before, or the seed if it is a new world, goes in the replay.
  function maybeBeginLife(t, events) {
    if (!events.some((e) => (e[1] === 2 || e[1] === 4) && e[2] === me)) return;
    life = {
      from: t,
      start: t === 0 && fresh ? { fresh: true } : { state: JSON.parse(JSON.stringify(snapshot(world))) },
      at: new Date().toISOString(),
      autoplayed: autoplay,
      bestRank: 99,
    };
    log = [];
    deathAt = null;
    finished = null;
    $("slitherOver").classList.add("hidden");
  }

  function hostTick() {
    const t = world.tick;
    const due = [];
    // This player's own steering, if it changed enough to matter.
    if (snakeOf(world, me)) {
      const want = wanted();
      if (input.applied < 0 || Math.abs(angleDiff(input.applied, want.angle)) >= ANGLE_STEP) {
        due.push([t, 0, me, want.angle]);
        input.applied = want.angle;
      }
      if (want.boost !== input.appliedBoost) {
        due.push([t, 1, me, want.boost ? 1 : 0]);
        input.appliedBoost = want.boost;
      }
    }
    for (const e of pending.splice(0)) due.push([t, ...e]);
    maybeBeginLife(t, due);
    const applied = due.filter((e) => applyEvent(world, e));
    if (life) log.push(...applied);
    keepPrev();
    step(world);
    fresh = false;
    lastTickAt = performance.now();
    broadcast({ type: "f", t, e: applied, h: t % HASH_EVERY === 0 ? worldHash(world) : undefined });
    afterTick();
  }

  function guestTick(f) {
    maybeBeginLife(f.t, f.e);
    for (const e of f.e) applyEvent(world, e);
    if (life) log.push(...f.e);
    keepPrev();
    step(world);
    lastTickAt = performance.now();
    if (f.h !== undefined && worldHash(world) !== f.h) {
      // This copy has drifted from the host's: start again from theirs.
      net.guest?.send({ type: "resync" });
      frames = [];
      net.waiting = true;
    }
    afterTick();
  }

  function afterTick() {
    const mine = snakeOf(world, me);
    if (mine) {
      lastHead = [mine.xs[0], mine.ys[0]];
      const rank = standings(world).indexOf(mine) + 1;
      if (life && rank > 0) life.bestRank = Math.min(life.bestRank, rank);
      if (life) life.length = mine.mass;
      if (life) life.kills = mine.kills;
    }
    const death = world.happened.find((hp) => hp.type === "death" && hp.player === me);
    if (death && life && deathAt === null) {
      deathAt = world.tick;
      life.death = death;
      autoplay = false;
      const number = deathAt;
      setTimeout(() => {
        if (active && deathAt === number) showOver();
      }, OVER_DELAY_MS);
    }
  }

  /* ---- The death panel ---- */

  function replayOfLife() {
    if (!life) return null;
    return {
      v: 1,
      kind: "slither",
      at: life.at,
      seed: world.seed,
      focus: me,
      name: playerName(),
      start: life.start,
      from: life.from,
      to: world.tick,
      events: log.slice(),
    };
  }

  function showOver() {
    const d = life.death;
    const length = life.length ?? 10;
    const best = Number(store.get(BEST_KEY)) || 0;
    const counts = !life.autoplayed;
    const newBest = counts && length > best;
    if (newBest) store.set(BEST_KEY, String(length));
    finished = { replay: replayOfLife(), replayId: null, length };
    $("sOverTitle").textContent = newBest ? "New best" : d.cause === "edge" ? "Off the edge" : "Eaten";
    $("sOverCause").textContent =
      d.cause === "edge"
        ? "You ran into the edge of the world."
        : d.cause === "gone"
          ? "Your snake left the world."
          : `You ran into ${d.killerName ?? "another snake"}.`;
    $("sFinalLength").textContent = String(length);
    $("sFinalKills").textContent = String(life.kills ?? 0);
    $("sFinalRank").textContent = life.bestRank < 99 ? `#${life.bestRank}` : "-";
    $("sFinalTime").textContent = clock((deathAt - life.from) * TICK_MS);
    $("sBest").textContent = life.autoplayed ? "Autoplay played this life, so it does not count towards your best." : `Your best: ${Math.max(best, length)}.`;
    $("sShareMsg").textContent = "";
    $("sShareRow").hidden = true;
    renderSeed();
    $("slitherOver").classList.remove("hidden");
    $("sAgainBtn").focus();
  }

  function playAgain() {
    if (!active) return;
    $("slitherOver").classList.add("hidden");
    input.applied = -1;
    sendOrQueue([4, me], { type: "spawn" });
  }

  function renderSeed() {
    document.querySelectorAll("#slitherOver .seed-code").forEach((el) => {
      el.textContent = world?.seed ?? "";
    });
  }

  /* ---- Pause: only with nobody else in the world ---- */

  const canPause = () => active && role === "host" && guestsConnected() === 0 && !replay;

  function setPaused(next) {
    if (!canPause() && next) return;
    paused = next;
    acc = 0;
    $("pauseOverlay").classList.toggle("hidden", !paused);
    document.body.classList.toggle("party-pause", false);
    if (paused) $("continueBtn").focus();
  }

  /* ---- The loop ---- */

  let last = performance.now();
  let hudAt = 0;
  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(250, now - last);
    last = now;
    if (!active && !replay) return;
    fit();
    keySteer(dt);

    if (active && world) {
      if (role === "host" && !paused) {
        acc += dt;
        for (let n = 0; acc >= TICK_MS && n < 6; n += 1) {
          acc -= TICK_MS;
          hostTick();
        }
        if (acc > TICK_MS * 4) acc = 0;
      } else if (role === "guest" && !net.waiting) {
        // Behind by more than a few ticks, it catches up quicker.
        const budget = frames.length > 8 ? 12 : 3;
        for (let n = 0; n < budget && frames.length; n += 1) {
          const f = frames.shift();
          if (f.t < world.tick) continue;
          if (f.t > world.tick) {
            net.guest?.send({ type: "resync" });
            frames = [];
            net.waiting = true;
            break;
          }
          guestTick(f);
        }
        sendInput(now);
      }
    }
    if (replay) updateReplay(dt);
    draw(now);
    if (now - hudAt > 200) {
      hudAt = now;
      renderHud();
    }
  }

  // A joiner's steering goes to the host as it changes, at most a tick apart.
  function sendInput(now) {
    if (!net.guest || !snakeOf(world, me) || now - input.sentAt < TICK_MS) return;
    const want = wanted();
    const turned = input.applied < 0 || Math.abs(angleDiff(input.applied, want.angle)) >= ANGLE_STEP;
    if (!turned && want.boost === input.appliedBoost) return;
    input.applied = want.angle;
    input.appliedBoost = want.boost;
    input.sentAt = now;
    net.guest.send({ type: "in", a: want.angle, b: want.boost ? 1 : 0 });
  }

  function draw(now) {
    const shown = replay ? replay.player.world : world;
    if (!shown) return;
    const showPrev = replay ? replay.player.prev : prev;
    const alpha = replay
      ? Math.min(1, replay.acc / TICK_MS)
      : role === "host"
        ? (paused ? 1 : Math.min(1, acc / TICK_MS))
        : Math.min(1, (now - lastTickAt) / TICK_MS);
    const focusPlayer = replay ? replay.player.replay.focus : me;
    const focus = snakeOf(shown, focusPlayer);
    let camX;
    let camY;
    if (focus) {
      const p = showPrev?.get(focus.id);
      camX = p ? p.xs[0] + (focus.xs[0] - p.xs[0]) * alpha : focus.xs[0];
      camY = p ? p.ys[0] + (focus.ys[0] - p.ys[0]) * alpha : focus.ys[0];
      if (replay) replay.lastHead = [camX, camY];
      else lastHead = [camX, camY];
    } else {
      [camX, camY] = (replay ? replay.lastHead : lastHead) ?? [0, 0];
    }
    // Zoomed to the screen, and out as the snake grows.
    const base = Math.max(0.55, Math.min(1.3, Math.min(w, h) / 760));
    const r = focus ? radiusOf(focus.mass) / SUB : 9;
    const target = base * Math.max(0.42, Math.min(1.1, 1.18 - (r - 9) / 55));
    zoom += (target - zoom) * 0.06;
    drawWorld(ctx, {
      world: shown,
      prev: showPrev,
      alpha,
      camX,
      camY,
      zoom,
      quality: getSettings().graphics,
      now,
      me: focus?.id ?? -1,
      look: !replay && focus && !autoplay ? (input.angle / ANG) * Math.PI * 2 : null,
      theme,
      w,
      h,
      dpr,
      safe: { right: 0, bottom: isTouch() ? 0 : 0 },
      hideMinimap: Boolean(replay) && w < 520,
    });
  }

  /* ---- The stats, top left ---- */

  let hudCache = "";
  function renderHud() {
    const shown = replay ? replay.player.world : world;
    if (!shown) return;
    const focusPlayer = replay ? replay.player.replay.focus : me;
    const mine = snakeOf(shown, focusPlayer);
    const order = standings(shown);
    const rank = mine ? order.indexOf(mine) + 1 : 0;
    const top = order
      .slice(0, 5)
      .map((s, i) => `<li class="${s === mine ? "me" : ""}"><span>${i + 1}. ${escapeHtml(s.name)}</span><b>${s.mass}</b></li>`)
      .join("");
    const html =
      `<p class="hud-line"><span class="hud-pair">Length <b>${mine ? mine.mass : finished?.length ?? 0}</b></span>` +
      `<span class="hud-pair">Rank <b>${rank || "-"}</b> of <b>${order.length}</b></span></p>` +
      `<ol class="slither-top">${top}</ol>`;
    if (html !== hudCache) {
      hudCache = html;
      $("slitherStats").innerHTML = html;
    }
    renderJoinChip();
  }

  function setNote(text) {
    const el = $("slitherNote");
    if (el.textContent !== text) el.textContent = text;
    el.hidden = !text;
  }

  /* ---- Hosting ---- */

  const net = {
    host: null,
    guest: null,
    code: null,
    status: "off",
    peers: new Map(), // link id -> { browser, name, skin, player, ready }
    succession: [],
    hostBrowser: null,
    chunks: null,
    waiting: false,
    migrating: false,
    handover: false,
    retry: null,
  };
  let nextPlayer = 1;

  const guestsConnected = () => [...net.peers.values()].filter((p) => p.ready).length;

  function renderJoinChip() {
    const chip = $("joinChip");
    const code = $("joinCodeText");
    const label =
      net.status === "open"
        ? net.code
        : net.status === "connecting"
          ? "..."
          : net.status === "migrating"
            ? "moving"
            : "offline";
    if (code.textContent !== label) code.textContent = label;
    chip.classList.toggle("off", net.status !== "open");
    const n = role === "host" ? guestsConnected() : Object.values(world?.players ?? {}).filter((p) => p.connected).length - 1;
    const people = n > 0 ? `${n} joined` : "";
    if ($("joinCount").textContent !== people) $("joinCount").textContent = people;
  }

  async function startHosting(code = generateCode(), { retries = 0 } = {}) {
    net.code = code;
    net.status = "connecting";
    const host = new Host({ maxGuests: MAX_JOINERS });
    net.host = host;
    let triedFresh = false;
    host.addEventListener("status", ({ detail }) => {
      if (net.host !== host) return;
      if (detail.taken) {
        host.close();
        if (net.migrating && retries < 12) {
          // The old host's id is still held by the broker: wait and try again.
          net.retry = setTimeout(() => startHosting(code, { retries: retries + 1 }), 1500);
        } else if (net.migrating) {
          // Somebody else has the world: join them instead.
          net.migrating = false;
          becomeGuestOf(code);
        } else if (!triedFresh) {
          triedFresh = true;
          startHosting(generateCode());
        }
        return;
      }
      if (detail.status === "waiting" || detail.status === "connected") {
        net.status = "open";
        if (net.migrating) {
          net.migrating = false;
          setNote("");
        }
      } else if (detail.status === "error") {
        net.status = "off";
      }
      renderJoinChip();
      renderWorldModal();
    });
    host.addEventListener("join", ({ detail }) => {
      const m = detail.metadata ?? {};
      net.peers.set(detail.id, {
        browser: typeof m.pid === "string" ? m.pid.slice(0, 24) : detail.id,
        name: String(m.sname || m.name || "").slice(0, 20) || `Player ${nextPlayer + 1}`,
        skin: cleanSkin(m.skin),
        player: null,
        ready: false,
      });
    });
    host.addEventListener("leave", ({ detail }) => {
      const peer = net.peers.get(detail.id);
      net.peers.delete(detail.id);
      if (peer?.player != null) pending.push([3, peer.player]);
      sendSuccession();
      renderWorldModal();
    });
    host.addEventListener("message", ({ detail }) => onGuestMessage(detail.message, detail.from));
    try {
      await host.start(code);
    } catch {
      if (net.host === host) net.status = "off";
    }
  }

  function onGuestMessage(m, from) {
    const peer = net.peers.get(from);
    if (!peer || !world) return;
    const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
    switch (m.type) {
      case "hello":
        if (m.v !== PROTOCOL_VERSION) {
          net.host.send({ type: "reload" }, from);
          return;
        }
        net.host.send({ type: "edition", edition: "slither", rules: RULES_VERSION }, from);
        welcome(from, peer);
        break;
      case "resync":
        welcome(from, peer, { again: true });
        break;
      case "in":
        if (peer.player == null) return;
        if (int(m.a, 0, ANG - 1)) pending.push([0, peer.player, m.a]);
        if (int(m.b, 0, 1)) pending.push([1, peer.player, m.b]);
        break;
      case "spawn":
        if (peer.player != null) pending.push([4, peer.player]);
        break;
      case "skin":
        if (peer.player != null) pending.push([6, peer.player, cleanSkin(m.skin)]);
        break;
      case "auto":
        if (peer.player != null && int(m.on, 0, 1)) pending.push([5, peer.player, m.on]);
        break;
      case "bye":
        if (peer.player != null) pending.push([3, peer.player]);
        net.peers.delete(from);
        net.host.dropId(from);
        sendSuccession();
        break;
      default:
        break;
    }
  }

  // Sends a joiner the world as it stands between ticks, in pieces, then
  // who they are in it. A browser seen before gets its player, and its
  // snake if the computer has been keeping it going.
  function welcome(link, peer, { again = false } = {}) {
    if (guestsConnected() >= MAX_JOINERS && !peer.ready) {
      net.host.send({ type: "full" }, link);
      return;
    }
    let player = peer.player;
    if (player == null) {
      const known = Object.entries(world.players).find(([, p]) => p.browser === peer.browser);
      player = known ? Number(known[0]) : nextFreePlayer();
      peer.player = player;
      if (known) pending.push([7, player]);
      else pending.push([2, player, peer.name, peer.skin, peer.browser]);
    }
    const json = JSON.stringify(snapshot(world));
    const id = Math.floor(Math.random() * 1e9);
    const parts = Math.ceil(json.length / CHUNK);
    for (let i = 0; i < parts; i += 1) net.host.send({ type: "snap", id, i, n: parts, d: json.slice(i * CHUNK, (i + 1) * CHUNK) }, link);
    net.host.send({ type: "welcome", id, you: player, tick: world.tick, again }, link);
    peer.ready = true;
    sendSuccession();
    renderWorldModal();
  }

  function nextFreePlayer() {
    const used = Object.keys(world.players).map(Number);
    nextPlayer = Math.max(nextPlayer, ...used.map((n) => n + 1), 1);
    return nextPlayer++;
  }

  function broadcast(message) {
    if (!net.host) return;
    for (const [id, p] of net.peers) if (p.ready) net.host.send(message, id);
  }

  // Who carries on if this device goes: the joiners in the order they came.
  function sendSuccession() {
    const list = [...net.peers.values()].filter((p) => p.ready).map((p) => p.browser);
    broadcast({ type: "succ", list, host: browserId() });
  }

  // Leaving on purpose with others still playing: the first of them takes
  // the world over at once, instead of noticing the host has gone.
  function handOver() {
    broadcast({ type: "handover" });
  }

  /* ---- Joining ---- */

  // Called by js/party.js once a host says its world is a Slither one. The
  // connection is already open and has said hello.
  function joinWith(guest, code, hello = {}) {
    if (hello.rules !== RULES_VERSION) {
      guest.close();
      showStart({ message: "That world is on a different version of the game. Reload this page, and ask the host to as well." });
      return;
    }
    stopNet({ keepGuest: guest });
    net.guest = guest;
    net.code = code;
    net.status = "open";
    net.waiting = true;
    role = "guest";
    world = null;
    frames = [];
    guest.addEventListener("message", ({ detail }) => {
      if (net.guest === guest) onHostMessage(detail.message);
    });
    guest.addEventListener("status", ({ detail }) => {
      if (net.guest !== guest) return;
      if (detail.status === "dropped" || detail.status === "unreachable" || detail.status === "error") hostLost();
    });
    closeModal("partyModal");
    setNote("Joining the world.");
    enter();
  }

  function onHostMessage(m) {
    switch (m.type) {
      case "edition":
        break;
      case "snap":
        if (!net.chunks || net.chunks.id !== m.id) net.chunks = { id: m.id, parts: [] };
        if (Number.isInteger(m.i) && m.i >= 0 && m.i < 64 && typeof m.d === "string") net.chunks.parts[m.i] = m.d;
        break;
      case "welcome": {
        const c = net.chunks;
        if (!c || c.id !== m.id) return;
        let snap;
        try {
          snap = JSON.parse(c.parts.join(""));
        } catch {
          return;
        }
        net.chunks = null;
        // Checked like any replay's starting world before it is trusted.
        const check = cleanSlitherReplay({ v: 1, kind: "slither", seed: snap.seed, focus: 0, from: snap.tick, to: snap.tick + 1, start: { state: snap }, events: [] });
        if (!check) return;
        world = restore(check.start.state);
        // The browser ids are needed here to carry on hosting.
        for (const [k, p] of Object.entries(snap.players ?? {})) if (world.players[k]) world.players[k].browser = String(p.browser ?? "").slice(0, 24);
        me = Number.isInteger(m.you) ? m.you : 0;
        frames = frames.filter((f) => f.t >= world.tick);
        prev = null;
        net.waiting = false;
        if (!m.again) {
          life = null;
          finished = null;
          const mine = snakeOf(world, me);
          if (mine) {
            // Back in a world after a reload, with the snake the computer
            // kept going: this life's replay starts from here.
            life = { from: world.tick, start: { state: JSON.parse(JSON.stringify(snapshot(world))) }, at: new Date().toISOString(), autoplayed: false, bestRank: 99 };
            log = [];
            deathAt = null;
          } else if (world.players[me]) {
            // Back, but the snake is gone: a new one.
            net.guest?.send({ type: "spawn" });
          }
        }
        setNote("");
        renderSeed();
        break;
      }
      case "f":
        if (!Number.isInteger(m.t) || !Array.isArray(m.e)) return;
        frames.push({ t: m.t, e: m.e.filter(Array.isArray).slice(0, 200), h: Number.isInteger(m.h) ? m.h : undefined });
        break;
      case "succ":
        net.succession = Array.isArray(m.list) ? m.list.filter((x) => typeof x === "string").slice(0, MAX_JOINERS) : [];
        net.hostBrowser = typeof m.host === "string" ? m.host : null;
        renderWorldModal();
        break;
      case "handover":
        net.handover = true;
        break;
      case "full":
        leave();
        showStart({ message: "That world is full." });
        break;
      case "reload":
        leave();
        showStart({ message: "That world is on a newer version. Reload this page to join." });
        break;
      default:
        break;
    }
  }

  /* ---- Host migration ----
     The host's connection went. The first joiner in the succession list
     carries on hosting the world from its own copy, under the same code;
     everyone else reconnects to that code and is sent the world afresh. */

  function hostLost() {
    if (!active || net.migrating || role !== "guest") return;
    net.migrating = true;
    net.status = "migrating";
    const guest = net.guest;
    net.guest = null;
    guest?.close();
    const oldHost = net.hostBrowser;
    const successor = net.succession[0];
    if (world && successor === browserId()) {
      setNote("The host left. You are hosting the world now.");
      role = "host";
      acc = 0;
      frames = [];
      net.peers.clear();
      const old = Object.entries(world.players).find(([, p]) => p.browser === oldHost);
      if (old) pending.push([3, Number(old[0])]);
      setTimeout(() => startHosting(net.code), net.handover ? 300 : 1200);
    } else {
      setNote("The host left. Joining whoever carries on.");
      setTimeout(() => becomeGuestOf(net.code), net.handover ? 900 : 2000);
    }
    net.handover = false;
  }

  let reconnects = 0;
  async function becomeGuestOf(code) {
    if (!active) return;
    const guest = new Guest();
    net.guest = guest;
    role = "guest";
    net.waiting = true;
    guest.addEventListener("message", ({ detail }) => {
      if (net.guest === guest) onHostMessage(detail.message);
    });
    guest.addEventListener("status", ({ detail }) => {
      if (net.guest !== guest) return;
      if (detail.status === "connected") {
        reconnects = 0;
        net.migrating = false;
        net.status = "open";
      } else if (detail.status === "dropped") {
        hostLost();
      } else if (detail.status === "unreachable" || detail.status === "error") {
        if (++reconnects < 15) setTimeout(() => net.guest === guest && becomeGuestOf(code), 2000);
        else {
          leave();
          showStart({ message: "The world ended when its host left." });
        }
      }
    });
    try {
      await guest.connect(code, { pid: browserId(), name: playerName(), sname: playerName(), skin: storedSkin(store) });
    } catch {
      setNote("Could not reconnect. Check your connection.");
    }
  }

  function stopNet({ keepGuest = null } = {}) {
    clearTimeout(net.retry);
    if (net.host) {
      const host = net.host;
      net.host = null;
      setTimeout(() => host.close(), 200);
    }
    if (net.guest && net.guest !== keepGuest) {
      const guest = net.guest;
      net.guest = null;
      guest.close();
    }
    net.peers.clear();
    net.succession = [];
    net.status = "off";
    net.migrating = false;
    net.waiting = false;
    net.chunks = null;
  }

  /* ---- The world window: code, QR, link, who is in ---- */

  function renderWorldModal() {
    if ($("worldModal").classList.contains("hidden")) return;
    const open = net.status === "open";
    $("worldCode").textContent = open ? net.code : "";
    const link = open ? `${location.origin}/join?id=${net.code}` : "";
    $("worldLink").textContent = link.replace(/^https?:\/\//, "");
    $("worldLink").dataset.link = link;
    $("worldQr").innerHTML = open ? qrToSvg(link, { label: `Join link for code ${net.code}` }) : "";
    $("worldStatus").textContent = open
      ? "Anyone on the same network can join now, any time, up to twelve."
      : net.status === "connecting"
        ? "Opening the world to others."
        : net.status === "migrating"
          ? "The world is moving to a new host."
          : "Others cannot join right now: pairing needs a connection. Playing on works.";
    const people = Object.entries(world?.players ?? {})
      .filter(([, p]) => p.connected)
      .map(([k, p]) => `<li><span class="pp-name">${escapeHtml(p.name)}${Number(k) === me ? " (you)" : ""}</span></li>`)
      .join("");
    $("worldPeople").innerHTML = people;
  }

  function openWorld() {
    openModal("worldModal");
    renderWorldModal();
  }

  /* ---- Sharing the replay of a life ---- */

  async function shareReplay() {
    const f = finished;
    if (!f?.replay) return;
    const btn = $("sShareBtn");
    const msg = $("sShareMsg");
    btn.disabled = true;
    msg.textContent = "Making a link.";
    try {
      if (!f.replayId) {
        const { id } = await api.createReplay(f.replay);
        f.replayId = id;
      }
      const url = `${location.origin}/r/${f.replayId}`;
      $("sShareLink").value = url;
      $("sShareRow").hidden = false;
      if (navigator.share && isTouch()) {
        try {
          await navigator.share({ title: "Snake Game replay", text: `Length ${f.length} in Slither. Watch how it went:`, url });
          msg.textContent = "Shared.";
          return;
        } catch (err) {
          if (err?.name === "AbortError") {
            msg.textContent = "";
            return;
          }
        }
      }
      try {
        await navigator.clipboard.writeText(url);
        msg.textContent = "Link copied.";
      } catch {
        $("sShareLink").select();
        msg.textContent = "Copy the link below.";
      }
    } catch (err) {
      msg.textContent =
        err.code === "offline"
          ? "Sharing a Slither replay needs a connection: the whole world goes with it, too much for a link on its own."
          : err.status >= 500 || !err.message || err.message === err.code
            ? "Sharing is not available right now. Try again in a moment."
            : err.message;
    } finally {
      btn.disabled = false;
    }
  }

  /* ---- Instant replay ----
     Played on the canvas while the world goes on underneath, since others
     may still be playing in it. Steps are a quarter of a second. */

  let replaySpeed = 1;

  function openReplay(raw, { shared = false, verified = false } = {}) {
    const clean = shared ? cleanSlitherReplay(raw) : raw;
    if (!clean) return false;
    let player;
    try {
      player = new SlitherPlayer(clean);
    } catch (err) {
      console.warn("replay did not play:", err);
      return false;
    }
    replay = { player, playing: false, acc: 0, shared, lastHead: null };
    replaySpeed = Number(store.get(SPEED_KEY)) || 1;
    if (!REPLAY_SPEEDS.includes(replaySpeed)) replaySpeed = 1;
    document.body.classList.add("slither", "replaying");
    $("slitherHud").hidden = false;
    $("slitherOver").classList.add("hidden");
    for (const id of ["startOverlay", "pauseOverlay", "gameOverOverlay"]) $(id).classList.add("hidden");
    $("replayBar").hidden = false;
    $("replaySeedBtn").classList.toggle("hidden", !shared);
    $("replayNote").hidden = !shared;
    $("replayNote").textContent = shared ? `${clean.name}'s Slither game${verified ? "" : ", shared"}.` : "";
    const seek = $("replaySeek");
    seek.min = String(clean.from);
    seek.max = String(clean.to);
    const span = Math.max(1, clean.to - clean.from);
    $("replayMarks").innerHTML = player.marks.map((t) => `<span style="left: ${((t - clean.from) / span) * 100}%"></span>`).join("");
    syncSpeed();
    fit();
    setReplayPlaying(true);
    renderReplay();
    $("replayPlay").focus();
    return true;
  }

  function closeReplay(back = true) {
    if (!replay) return;
    const shared = replay.shared;
    replay = null;
    $("replayBar").hidden = true;
    document.body.classList.remove("replaying");
    $("replaySeek").min = "0";
    if (!back) return;
    if (active) {
      $("slitherOver").classList.remove("hidden");
      $("sReplayBtn").focus();
    } else {
      document.body.classList.remove("slither");
      $("slitherHud").hidden = true;
      if (shared && (location.pathname !== "/" || location.search)) history.replaceState(null, "", "/");
      showStart();
    }
  }

  function setReplayPlaying(playing) {
    if (!replay) return;
    if (playing && replay.player.world.tick >= replay.player.ticks) replay.player.seek(replay.player.replay.from);
    replay.playing = playing;
    replay.acc = 0;
    const btn = $("replayPlay");
    btn.innerHTML = icon(playing ? "pause" : "play");
    btn.setAttribute("aria-label", playing ? "Pause replay" : "Play replay");
    $("replayCaption").setAttribute("aria-live", playing ? "off" : "polite");
  }

  function syncSpeed() {
    $("replaySpeed").querySelectorAll("[data-speed]").forEach((el) => {
      const on = Number(el.dataset.speed) === replaySpeed;
      el.classList.toggle("active", on);
      el.setAttribute("aria-checked", String(on));
    });
  }

  function updateReplay(dt) {
    if (!replay.playing) return;
    replay.acc += dt * replaySpeed;
    let moved = false;
    while (replay.acc >= TICK_MS) {
      replay.acc -= TICK_MS;
      if (!replay.player.forward()) {
        setReplayPlaying(false);
        break;
      }
      moved = true;
    }
    if (moved) renderReplay();
  }

  function stepReplay(ticks) {
    if (!replay) return;
    setReplayPlaying(false);
    replay.player.seek(replay.player.world.tick + ticks);
    renderReplay();
  }

  function captionFor(list, focus) {
    const own = replay.player.replay.focus;
    for (const hp of list) {
      if (hp.type === "death" && hp.player === own) return { text: hp.cause === "edge" ? "Ran into the edge of the world" : "Ran into another snake", bad: true };
      if (hp.type === "death") return { text: `${hp.name} ran into you`, bad: false };
    }
    for (const hp of list) {
      if (hp.type === "eat" && hp.gained >= 5) return { text: `Ate ${hp.gained} at once` };
      if (hp.type === "join" || hp.type === "spawn") return { text: hp.player === focus ? "In the world" : `${hp.name} joined` };
    }
    return null;
  }

  function renderReplay() {
    const p = replay.player;
    const t = p.world.tick;
    let caption = { text: "Playing back", bad: false };
    for (let k = t; k >= Math.max(p.replay.from, t - 160); k -= 1) {
      const list = p.notes.get(k);
      const c = list && captionFor(list, p.replay.focus);
      if (c) {
        caption = c;
        break;
      }
    }
    $("replayCaption").textContent = caption.text;
    $("replayCaption").classList.toggle("bad", Boolean(caption.bad));
    $("replayTime").textContent = `${clock((t - p.replay.from) * TICK_MS)} / ${clock((p.replay.to - p.replay.from) * TICK_MS)}`;
    $("replaySeek").value = String(t);
    const span = Math.max(1, p.replay.to - p.replay.from);
    $("replayMarks").style.setProperty("--played", `${((t - p.replay.from) / span) * 100}%`);
  }

  function onReplayKey(e) {
    const key = e.key;
    const on = e.target instanceof Element ? e.target : null;
    if (key === "Escape") closeReplay();
    else if (key === " ") {
      if (on?.closest("button, a")) return;
      e.preventDefault();
      if (!e.repeat) setReplayPlaying(!replay.playing);
    } else if ((key === "ArrowLeft" || key === "ArrowRight") && !on?.closest("input")) {
      e.preventDefault();
      stepReplay(key === "ArrowRight" ? REPLAY_STEP : -REPLAY_STEP);
    } else if ((key === "Home" || key === "End") && !on?.closest("input")) {
      e.preventDefault();
      setReplayPlaying(false);
      replay.player.seek(key === "End" ? replay.player.ticks : replay.player.replay.from);
      renderReplay();
    }
  }

  /* ---- The skin builder ---- */

  let draft = parseSkin(storedSkin(store));

  function renderSkin() {
    const code = skinCode(draft);
    const pv = $("skinPreview");
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    const cw = pv.clientWidth || 360;
    const ch = pv.clientHeight || 90;
    pv.width = Math.round(cw * ratio);
    pv.height = Math.round(ch * ratio);
    const pctx = pv.getContext("2d");
    pctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    drawPreview(pctx, cw, ch, code);
    $("skinSeq").innerHTML = draft.colors
      .map(
        (c, i) =>
          `<button class="seq-dot${PALETTE[c].star ? " star" : ""}" type="button" data-remove="${i}" style="--dot:${PALETTE[c].hex}" aria-label="Remove colour ${i + 1}"></button>`
      )
      .join("");
    $("skinSeqNote").textContent = `${draft.colors.length} of ${MAX_COLORS}. Tap a colour below to add it, or one here to take it out.`;
    document.querySelectorAll("#skinPattern [data-pattern]").forEach((el) => {
      const on = el.dataset.pattern === draft.pattern;
      el.classList.toggle("active", on);
      el.setAttribute("aria-pressed", String(on));
    });
    document.querySelectorAll("#skinOutfit [data-outfit]").forEach((el) => {
      const on = el.dataset.outfit === draft.outfit;
      el.classList.toggle("active", on);
      el.setAttribute("aria-pressed", String(on));
    });
  }

  function buildSkinModal() {
    $("skinPresets").innerHTML = PRESETS.map((code, i) => {
      const s = parseSkin(code);
      const dots = s.colors.slice(0, 3).map((c) => `<span style="background:${PALETTE[c].hex}"></span>`).join("");
      return `<button class="preset" type="button" data-preset="${i}" aria-label="Ready-made skin ${i + 1}">${dots}</button>`;
    }).join("");
    $("skinPalette").innerHTML = PALETTE.map(
      (p, i) => `<button class="pal-dot${p.star ? " star" : ""}" type="button" data-color="${i}" style="--dot:${p.hex}" aria-label="Colour ${i + 1}${p.star ? ", starred" : ""}"></button>`
    ).join("");
    $("skinPattern").innerHTML = PATTERNS.map((p) => `<button class="mode-btn" type="button" data-pattern="${p.id}">${p.label}</button>`).join("");
    $("skinOutfit").innerHTML = OUTFITS.map((o) => `<button class="mode-btn" type="button" data-outfit="${o.id}">${o.label}</button>`).join("");

    $("skinPresets").addEventListener("click", (e) => {
      const b = e.target.closest("[data-preset]");
      if (!b) return;
      draft = parseSkin(PRESETS[Number(b.dataset.preset)]);
      renderSkin();
    });
    $("skinPalette").addEventListener("click", (e) => {
      const b = e.target.closest("[data-color]");
      if (!b) return;
      // A fresh build starts from the first colour picked.
      if (draft.building !== true) {
        draft = { ...draft, colors: [], building: true };
      }
      if (draft.colors.length < MAX_COLORS) draft.colors.push(Number(b.dataset.color));
      renderSkin();
    });
    $("skinSeq").addEventListener("click", (e) => {
      const b = e.target.closest("[data-remove]");
      if (!b || draft.colors.length <= 1) return;
      draft.colors.splice(Number(b.dataset.remove), 1);
      renderSkin();
    });
    $("skinClear").addEventListener("click", () => {
      draft = { ...draft, colors: [draft.colors[0]], building: true };
      renderSkin();
    });
    $("skinPattern").addEventListener("click", (e) => {
      const b = e.target.closest("[data-pattern]");
      if (b) draft.pattern = b.dataset.pattern;
      renderSkin();
    });
    $("skinOutfit").addEventListener("click", (e) => {
      const b = e.target.closest("[data-outfit]");
      if (b) draft.outfit = b.dataset.outfit;
      renderSkin();
    });
    $("skinForm").addEventListener("submit", (e) => {
      e.preventDefault();
      const code = cleanSkin(skinCode(draft));
      saveSkin(store, code);
      saveName(store, $("skinName").value);
      // In a world, others see the new skin from the next tick.
      if (active && world) sendOrQueue([6, me, code], { type: "skin", skin: code });
      closeModal("skinModal");
      document.dispatchEvent(new CustomEvent("uwusnek:skin"));
    });
  }

  function openSkin() {
    draft = parseSkin(storedSkin(store));
    $("skinName").value = storedName(store) || getSettings().name || "";
    openModal("skinModal");
    requestAnimationFrame(renderSkin);
  }

  /* ---- Screen wake lock, while in a world ---- */

  let lock = null;
  async function wakeLock(on) {
    if (!on) {
      lock?.release?.().catch(() => {});
      lock = null;
      return;
    }
    if (lock || !("wakeLock" in navigator) || document.visibilityState !== "visible") return;
    try {
      lock = await navigator.wakeLock.request("screen");
      lock.addEventListener("release", () => {
        lock = null;
      });
    } catch {
      // Refused: the screen may sleep.
    }
  }

  /* ---- Wiring ---- */

  const stage = $("stage");
  stage.addEventListener("pointerdown", onPointerDown);
  stage.addEventListener("pointermove", onPointerMove);
  stage.addEventListener("pointerup", onPointerUp);
  stage.addEventListener("pointercancel", onPointerUp);
  window.addEventListener("pointerup", (e) => e.pointerType === "mouse" && e.button === 0 && (input.mouseBoost = false));
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", () => {
    input.keyBoost = input.mouseBoost = input.touchBoost = input.buttonBoost = false;
    input.keyTurn = 0;
  });
  $("brand").addEventListener("pointerdown", onBrandTap);

  const boostBtn = $("boostBtn");
  boostBtn.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    input.buttonBoost = true;
    boostBtn.classList.add("on");
  });
  const boostOff = () => {
    input.buttonBoost = false;
    boostBtn.classList.remove("on");
  };
  boostBtn.addEventListener("pointerup", boostOff);
  boostBtn.addEventListener("pointercancel", boostOff);
  boostBtn.addEventListener("pointerleave", boostOff);

  $("joinChip").addEventListener("click", openWorld);
  $("worldLeaveBtn").addEventListener("click", () => {
    closeModal("worldModal");
    leave();
  });
  $("worldCopyBtn").addEventListener("click", async () => {
    const label = $("worldCopyBtn").querySelector(".copy-label");
    try {
      await navigator.clipboard.writeText($("worldLink").dataset.link);
      label.textContent = "Copied";
    } catch {
      getSelection()?.selectAllChildren($("worldLink"));
      label.textContent = "Selected";
    }
    setTimeout(() => {
      label.textContent = "Copy";
    }, 1500);
  });

  $("sAgainBtn").addEventListener("click", playAgain);
  $("sReplayBtn").addEventListener("click", () => finished?.replay && openReplay(finished.replay));
  $("sShareBtn").addEventListener("click", shareReplay);
  $("sCopyLinkBtn").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText($("sShareLink").value);
      $("sShareMsg").textContent = "Link copied.";
    } catch {
      $("sShareLink").select();
    }
  });
  $("sSkinBtn").addEventListener("click", openSkin);
  $("sLeaveBtn").addEventListener("click", leave);
  $("startSkinBtn").addEventListener("click", openSkin);

  // The replay bar is shared with Classic; these act only on a Slither replay.
  $("replayPlay").addEventListener("click", () => replay && setReplayPlaying(!replay.playing));
  $("replayBack").addEventListener("click", () => replay && stepReplay(-REPLAY_STEP));
  $("replayForward").addEventListener("click", () => replay && stepReplay(REPLAY_STEP));
  $("replayClose").addEventListener("click", () => replay && closeReplay());
  $("replaySpeed").addEventListener("click", (e) => {
    const b = e.target.closest("[data-speed]");
    if (!b || !replay) return;
    replaySpeed = Number(b.dataset.speed);
    store.set(SPEED_KEY, String(replaySpeed));
    syncSpeed();
  });
  let resumeAfterScrub = false;
  const seek = $("replaySeek");
  seek.addEventListener("pointerdown", () => {
    if (!replay) return;
    resumeAfterScrub = replay.playing;
    setReplayPlaying(false);
  });
  seek.addEventListener("input", () => {
    if (!replay) return;
    if (replay.playing) {
      resumeAfterScrub = true;
      setReplayPlaying(false);
    }
    replay.player.seek(Number(seek.value));
    renderReplay();
  });
  const endScrub = () => {
    if (!replay || !resumeAfterScrub) return;
    resumeAfterScrub = false;
    if (replay.player.world.tick < replay.player.ticks) setReplayPlaying(true);
  };
  seek.addEventListener("change", endScrub);
  seek.addEventListener("pointerup", endScrub);
  $("replaySeedBtn").addEventListener("click", () => {
    if (!replay?.shared) return;
    const seed = replay.player.replay.seed;
    closeReplay(false);
    document.body.classList.remove("slither");
    $("slitherHud").hidden = true;
    history.replaceState(null, "", "/");
    showStart({ edition: "slither", seed, message: "The replay's seed is filled in." });
  });

  $("pauseBtn").addEventListener("click", () => {
    if (!active) return;
    if (canPause()) setPaused(!paused);
    else setNote(paused ? "" : "Others are in this world, so it carries on.");
  });
  $("continueBtn").addEventListener("click", () => active && setPaused(false));

  document.addEventListener("visibilitychange", () => {
    if (!active) return;
    if (document.visibilityState === "hidden") {
      input.keyBoost = input.mouseBoost = input.touchBoost = input.buttonBoost = false;
      if (canPause()) setPaused(true);
    } else {
      wakeLock(true);
    }
  });
  new MutationObserver(() => {
    theme = readTheme();
  }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-mode", "data-color-theme"] });
  document.addEventListener("uwusnek:settings", () => {
    w = 0; // the quality may have changed the pixel density
  });

  buildSkinModal();
  hydrateIcons();
  requestAnimationFrame(frame);

  return {
    start,
    joinWith,
    openReplay,
    openWorld,
    openSkin,
    pause: () => canPause() && setPaused(true),
    get active() {
      return active || Boolean(replay);
    },
    get inWorld() {
      return active;
    },
  };
}
