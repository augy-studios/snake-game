// Snakes & Ladders, on screen: who plays, picked on the pre-game screen;
// the board (js/ladders-render.js); rolling the die; the counters hopping
// square by square, up ladders and down snakes; the computers' turns;
// pause; and the winner. The rules are js/ladders-rules.js.
//
// Solo is you against the computer. Two to four players opens a game for
// people on the same network: this device hosts it under a join code
// (STUN only, js/p2p.js), the others join with the code, the link or the
// QR code, and whatever seats are still empty when the host starts go to
// computers, named from wordlist.json.
//
// In a game with others the host rolls every die, its own, the computers'
// and the joiners' when they ask, and sends each roll to everyone with the
// number of turns played before it. Every device then plays that roll out
// with the same rules, so they all show the same moves at the same pace,
// and the host's copy of the game, sent now and then, puts right anyone
// who missed a roll. A joiner who drops keeps their seat, and the computer
// rolls for them until they are back.
//
// The board takes the place of Classic's, in the same spot: js/game.js
// lays both canvases out together. It shows behind the pre-game screen
// whenever this edition is picked there, so the board is the first thing
// seen, and in the theme's colours.

import { Guest, Host, PROTOCOL_VERSION, generateCode } from "./p2p.js";
import { qrToSvg } from "./qr.js";
import { LAST, MAX_PLAYERS, RULES_VERSION, newGame, playTurn, restoreGame, rollDie, snapshotGame, standings } from "./ladders-rules.js";
import { drawLaddersBoard, forgetBoard, readBoardTheme, snakePoint, spotOf } from "./ladders-render.js";
import { playerName } from "./slither-game.js";
import { closeModal, escapeHtml, store } from "./ui.js";
import { fitForSnake } from "./wordfilter.js";

const SETUP_KEY = "uwusnek.ladders";
const PID_KEY = "uwusnek.partyId";
const ROLL_MS = 550; // the die tumbling
const FACE_MS = 70; // each face it shows while it tumbles
const HOP_MS = 150; // a square
const COMPUTER_WAIT_MS = 450; // before a computer rolls
const NEXT_MS = 330; // after a move, before the next turn
const OVER_DELAY_MS = 1000;
const BEAT_MS = 1500; // the host's copy of the game, to everyone
const MAX_GUESTS = 6; // links held at once, so latecomers can be told why not
const RECONNECTS = 8;
const TAP_PX = 14;
const TRIPLE_TAP_MS = 400;

const $ = (id) => document.getElementById(id);
const isTouch = () => window.matchMedia("(pointer: coarse)").matches || (navigator.maxTouchPoints || 0) > 0;
const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const cleanName = (v) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 20);

// The die's faces: pips on a 3 by 3 grid.
const PIPS = {
  1: [[2, 2]],
  2: [[1, 1], [3, 3]],
  3: [[1, 1], [2, 2], [3, 3]],
  4: [[1, 1], [3, 1], [1, 3], [3, 3]],
  5: [[1, 1], [3, 1], [2, 2], [1, 3], [3, 3]],
  6: [[1, 1], [3, 1], [1, 2], [3, 2], [1, 3], [3, 3]],
};

function dieSvg(n) {
  const pips = PIPS[n].map(([c, r]) => `<circle cx="${c * 10}" cy="${r * 10}" r="3.6"/>`).join("");
  return `<svg viewBox="0 0 40 40" aria-hidden="true"><rect class="die-face" x="2" y="2" width="36" height="36" rx="9"/>${pips}</svg>`;
}

// The same id party games and Slither key a seat on, so a reload or a
// dropped link gets the seat back.
function browserId() {
  let id = store.get(PID_KEY);
  if (!/^[A-Za-z0-9]{12}$/.test(id ?? "")) {
    id = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => "abcdefghijkmnpqrstuvwxyz23456789"[b % 32]).join("");
    store.set(PID_KEY, id);
  }
  return id;
}

/* ---- The computers' names ----
   From wordlist.json: its everyday words, the ones all in lower case there,
   of four to nine letters that pass the word filter, capitalised. Loaded
   once, from the service worker's copy when there is one. */

const FALLBACK_NAMES = ["Pebble", "Noodle", "Biscuit", "Maple", "Pickle", "Sprout", "Waffle", "Button", "Clover", "Mango"];
let names = FALLBACK_NAMES;
let namesLoading = null;

function loadNames() {
  namesLoading ??= fetch("/wordlist.json")
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => {
      const words = Array.isArray(data?.words) ? data.words : Object.values(data ?? {}).flat();
      const list = words.filter((w) => typeof w === "string" && w === w.toLowerCase() && fitForSnake(w)).map((w) => w[0].toUpperCase() + w.slice(1));
      if (list.length > 50) names = list;
    })
    .catch(() => {
      namesLoading = null;
    });
  // Never a long wait: the built in names do until the list is in.
  return Promise.race([namesLoading, new Promise((r) => setTimeout(r, 1500))]);
}

// `count` different names, none of them one already in the game.
function pickNames(count, taken = []) {
  const used = new Set(taken.map((n) => n.toLowerCase()));
  const out = [];
  for (let tries = 0; out.length < count && tries < 500; tries += 1) {
    const name = names[Math.floor(Math.random() * names.length)];
    if (used.has(name.toLowerCase())) continue;
    used.add(name.toLowerCase());
    out.push(name);
  }
  while (out.length < count) out.push(`Computer ${out.length + 1}`);
  return out;
}

/* ---- Who plays, and by which rules ----
   Solo, against one to three computers, or two to four players with
   people from the same network. Kept from game to game in this browser. */

function cleanSetup(raw = {}) {
  const int = (v, lo, hi, fallback) => (Number.isInteger(v) && v >= lo && v <= hi ? v : fallback);
  return {
    players: int(raw.players, 1, MAX_PLAYERS, 1),
    computers: int(raw.computers, 1, MAX_PLAYERS - 1, 1),
    sixAgain: raw.sixAgain !== false,
    bounce: raw.bounce === true,
  };
}

function readSetup() {
  try {
    return cleanSetup(JSON.parse(store.get(SETUP_KEY) ?? "{}") ?? {});
  } catch {
    return cleanSetup();
  }
}

export function initLadders({ showStart }) {
  const canvas = $("laddersBoard");
  const ctx = canvas.getContext("2d");
  const dock = $("laddersDock");
  const dieBtn = $("laddersDie");
  let theme = readBoardTheme();
  let size = 0;
  let dpr = 1;
  let dirty = true;

  let setup = readSetup();
  let picked = false; // this edition is picked on the pre-game screen
  let viewing = false; // the board is on screen
  let active = false; // a game is on
  let paused = false;
  let autoplay = false;
  let game = null;
  let gameNumber = 0;
  let mySeat = 0;
  let pawns = []; // { x, y, z, face, square }, one per seat
  let phase = "idle"; // wait, rolling, moving, next, over
  let waitMs = 0;
  let rolling = null; // { value, left, faceLeft, face }
  let turn = null; // the turn being played out, from playTurn
  let segments = []; // the moves still to show for it

  // Playing with others. Each seat is { kind, name }: kind "me" alone,
  // "host" or "guest" for a person, "computer", or "open" in the lobby. On
  // the host a guest's seat also holds their browser's `pid` and the `link`
  // they are on, null while they are away; a joiner is told `away`.
  const net = {
    role: null, // null alone; "host" or "guest" with others
    host: null,
    guest: null,
    code: "",
    status: "off", // connecting, open, error
    error: "",
    lobby: false,
    size: 2,
    seats: [],
    rules: null, // a joiner's copy of the host's rules, for the lobby
    links: new Map(), // host: link id -> { pid, name }
    pending: [], // joiner: rolls from the host waiting their turn on screen
    asked: false, // joiner: asked the host to roll, not answered yet
    reconnects: 0,
    beat: null,
    retry: null,
  };

  /* ---- The pre-game screen ---- */

  function renderSetup() {
    const s = setup;
    document.querySelectorAll("#lPlayerChips [data-players]").forEach((el) => {
      const on = Number(el.dataset.players) === s.players;
      el.classList.toggle("active", on);
      el.setAttribute("aria-pressed", String(on));
    });
    document.querySelectorAll("#lBotChips [data-computers]").forEach((el) => {
      const on = Number(el.dataset.computers) === s.computers;
      el.classList.toggle("active", on);
      el.setAttribute("aria-pressed", String(on));
    });
    $("lBotsBlock").hidden = s.players > 1;
    $("lPlayersNote").textContent =
      s.players === 1
        ? `You against ${s.computers === 1 ? "the computer" : `${s.computers} computers`}.`
        : "You host, and people on the same network join with the game's code. Seats still empty when you start go to computers.";
    $("lRulesNote").textContent =
      (s.sixAgain ? "A 6 earns another roll. " : "One roll a turn, even a 6. ") +
      (s.bounce ? "A roll past 100 walks back the squares left over." : "Landing on 100 takes the exact roll; a roll past it stays put.");
  }

  function setSetup(change) {
    setup = cleanSetup({ ...setup, ...change });
    store.set(SETUP_KEY, JSON.stringify(setup));
    renderSetup();
  }

  // Whether the board shows: in a game or its lobby, and behind the
  // pre-game screen while this edition is picked there.
  function syncView() {
    const on = active || net.lobby || (picked && !$("startOverlay").classList.contains("hidden"));
    if (on === viewing) return;
    viewing = on;
    document.body.classList.toggle("ladders-view", on);
    dirty = true;
  }

  // Play, on the pre-game screen.
  async function play() {
    if (setup.players > 1) {
      openLobby();
      return;
    }
    stopNet();
    await loadNames();
    mySeat = 0;
    const me = playerName();
    net.seats = [{ kind: "me", name: me }, ...pickNames(setup.computers, [me]).map((name) => ({ kind: "computer", name }))];
    newRound();
  }

  /* ---- A game ---- */

  // A new game for the seats as they are, from the first roll.
  function newRound() {
    game = newGame({
      players: net.seats.map((s) => ({ name: s.name, computer: s.kind === "computer" })),
      sixAgain: setup.sixAgain,
      bounce: setup.bounce,
    });
    autoplay = false;
    enterGame();
    placePawns();
    beginTurn();
    if (net.role === "host") broadcast({ type: "start", game: snapshotGame(game), seats: seatsInfo() });
  }

  function enterGame() {
    gameNumber += 1;
    active = true;
    paused = false;
    net.lobby = false;
    document.body.classList.add("ladders", "playing");
    document.body.classList.remove("party-pause");
    for (const id of ["startOverlay", "pauseOverlay", "gameOverOverlay", "laddersOver", "laddersLobby"]) $(id).classList.add("hidden");
    $("laddersHud").hidden = false;
    dock.hidden = false;
    // Starting over and starting the next game are the host's to do.
    $("lRestartBtn").classList.toggle("hidden", Boolean(net.role));
    $("lOnlineNote").classList.toggle("hidden", !net.role);
    $("lAgainBtn").classList.toggle("hidden", net.role === "guest");
    $("lGuestNote").classList.toggle("hidden", net.role !== "guest");
    syncView();
    // Off the Play button, now out of sight, so Space rolls rather than presses it.
    document.activeElement?.blur?.();
    wakeLock(Boolean(net.role));
  }

  // Every counter on its square, at rest.
  function placePawns() {
    rolling = null;
    turn = null;
    segments = [];
    net.pending = [];
    net.asked = false;
    dieBtn.classList.remove("rolling");
    setDie(6);
    pawns = game.players.map((p) => ({ ...spotOf(p.square), z: 0, face: 1, square: p.square }));
    hudCache = "";
  }

  // Off the screen without going back to the pre-game screen: something
  // else, a Classic game or a replay, is taking it. Anyone else in the game
  // is told.
  function close() {
    stopNet();
    $("laddersLobby").classList.add("hidden");
    if (active) {
      active = false;
      game = null;
      phase = "idle";
      $("laddersHud").hidden = true;
      dock.hidden = true;
      for (const id of ["laddersOver", "pauseOverlay"]) $(id).classList.add("hidden");
    }
    document.body.classList.remove("ladders", "playing");
    syncView();
    wakeLock(false);
  }

  function leave(message = "") {
    close();
    showStart({ edition: "ladders", message });
  }

  /* ---- Turns ---- */

  const current = () => game.players[game.turn];
  const myTurn = () => Boolean(game) && !game.over && game.turn === mySeat;
  const isMe = (seat) => seat === mySeat;
  const who = (seat) => (isMe(seat) ? "You" : game.players[seat].name);
  function away(seat) {
    const s = net.seats[seat];
    return s?.kind === "guest" && (net.role === "host" ? !s.link : s.away);
  }

  // Whether this device rolls for a seat without anyone pressing: the
  // computers, and a joiner who is away, on the device that runs them, and
  // this player under autoplay. A joiner's device rolls for nobody else.
  function rollsItself(seat) {
    if (isMe(seat)) return autoplay;
    if (net.role === "guest") return false;
    return game.players[seat].computer || away(seat);
  }

  const canRoll = () => active && !paused && phase === "wait" && myTurn() && !autoplay && !net.asked;

  function beginTurn() {
    phase = "wait";
    waitMs = COMPUTER_WAIT_MS;
    const seat = game.turn;
    const p = current();
    if (isMe(seat)) setStatus(autoplay ? "Autoplay rolls for you" : isTouch() ? "Your turn: tap the die" : "Your turn: roll the die");
    else if (away(seat)) setStatus(`${p.name} is away, so the computer rolls for them`);
    else if (p.computer) setStatus(`${p.name} to roll`);
    else setStatus(`${p.name}'s turn`);
    renderTurn();
  }

  // This player's roll, from the die, the board, or a key.
  function tryRoll() {
    if (!canRoll()) return;
    if (net.role === "guest") askRoll();
    else roll();
  }

  // On a joiner's device: the host rolls, and says what came up.
  function askRoll() {
    net.asked = true;
    net.guest?.send({ type: "roll", seq: game.seq });
    dieBtn.classList.add("rolling");
    setStatus("You roll…");
    renderTurn();
  }

  // Rolling on this device, alone or as the host, which tells everyone.
  function roll() {
    const r = { seq: game.seq, seat: game.turn, value: rollDie() };
    startRoll(r);
    if (net.role === "host") broadcast({ type: "roll", ...r });
  }

  function startRoll({ value }) {
    phase = "rolling";
    net.asked = false;
    rolling = { value, left: ROLL_MS, faceLeft: 0, face: 0 };
    dieBtn.classList.add("rolling");
    setStatus(`${isMe(game.turn) ? "You roll" : `${current().name} rolls`}…`);
    renderTurn();
  }

  function landDie() {
    const { value } = rolling;
    rolling = null;
    dieBtn.classList.remove("rolling");
    setDie(value);
    const seat = game.turn;
    turn = playTurn(game, value);
    segments = movesFor(turn);
    if (turn.blocked) setStatus(`${who(seat)} rolled ${value}: it takes exactly ${LAST - turn.from} to land on 100`);
    else setStatus(`${who(seat)} rolled ${value}`);
    phase = "moving";
  }

  // What to show for a turn: a hop for each square, then the ladder or snake.
  function movesFor(t) {
    const list = [];
    let from = t.from;
    for (const square of t.path) {
      list.push({ kind: "hop", from, to: square, ms: HOP_MS, t: 0 });
      from = square;
    }
    if (t.jump) {
      const span = Math.abs(spotOf(t.jump.from).y - spotOf(t.jump.to).y) + 1;
      list.push({ kind: t.jump.kind, from: t.jump.from, to: t.jump.to, ms: (t.jump.kind === "ladder" ? 320 : 420) + span * 110, t: 0 });
    }
    return list;
  }

  function stepMoves(dt) {
    const seg = segments[0];
    const pawn = pawns[turn.seat];
    if (!seg) {
      endMove();
      return;
    }
    if (seg.t === 0 && seg.kind !== "hop") {
      setStatus(seg.kind === "ladder" ? `Up a ladder to ${seg.to}!` : `Down a snake to ${seg.to}`);
    }
    seg.t = Math.min(seg.ms, seg.t + dt);
    const u = seg.t / seg.ms;
    const a = spotOf(seg.from);
    const b = spotOf(seg.to);
    if (seg.kind === "snake") {
      const p = snakePoint(seg.from, ease(u));
      pawn.x = p.x;
      pawn.y = p.y;
      pawn.z = 0;
    } else {
      const k = seg.kind === "hop" ? u : ease(u);
      pawn.x = a.x + (b.x - a.x) * k;
      pawn.y = a.y + (b.y - a.y) * k;
      pawn.z = seg.kind === "hop" ? Math.sin(Math.PI * u) * 0.3 : 0;
    }
    if (b.x !== a.x && seg.kind === "hop") pawn.face = Math.sign(b.x - a.x);
    if (seg.t >= seg.ms) {
      pawn.x = b.x;
      pawn.y = b.y;
      pawn.z = 0;
      pawn.square = seg.to;
      segments.shift();
      renderHud();
    }
  }

  function endMove() {
    const t = turn;
    const p = game.players[t.seat];
    if (net.role === "host") broadcast(stateMessage());
    if (t.won) {
      phase = "over";
      setStatus(isMe(t.seat) ? "You reached 100!" : `${p.name} reached 100!`);
      renderTurn();
      const number = gameNumber;
      setTimeout(() => {
        if (active && number === gameNumber) showOver();
      }, OVER_DELAY_MS);
      return;
    }
    if (t.again) setStatus(`A 6! ${isMe(t.seat) ? "You roll" : `${p.name} rolls`} again`);
    phase = "next";
    // Long enough to read what happened before the next turn's note.
    waitMs = t.blocked ? NEXT_MS * 4 : t.again ? NEXT_MS * 2.5 : t.jump ? NEXT_MS * 2 : NEXT_MS;
  }

  function update(dt, now) {
    if (!active || !game) return;
    if (phase === "over") {
      // The winner hops for joy.
      if (game.winner !== null) pawns[game.winner].z = Math.abs(Math.sin(now / 190)) * 0.22;
      return;
    }
    // With others the game goes on behind the pause panel.
    if (paused && !net.role) return;
    if (phase === "wait") {
      if (net.role === "guest" && net.pending.length) {
        startRoll(net.pending.shift());
        return;
      }
      if (!rollsItself(game.turn) || net.asked) return;
      waitMs -= dt;
      if (waitMs > 0) return;
      if (net.role === "guest") askRoll();
      else roll();
    } else if (phase === "rolling") {
      rolling.left -= dt;
      rolling.faceLeft -= dt;
      if (rolling.faceLeft <= 0) {
        rolling.faceLeft = FACE_MS;
        let face = rolling.face;
        while (face === rolling.face) face = rollDie();
        rolling.face = face;
        setDie(face);
      }
      if (rolling.left <= 0) landDie();
    } else if (phase === "moving") {
      stepMoves(dt);
    } else if (phase === "next") {
      // A roll already in from the host: no need to linger.
      waitMs = net.pending.length ? 0 : waitMs - dt;
      if (waitMs <= 0) beginTurn();
    }
  }

  /* ---- On screen: the die, the note beside it, the players top left ---- */

  function setDie(n) {
    dieBtn.innerHTML = dieSvg(n);
  }

  function setStatus(text) {
    const el = $("laddersStatus");
    if (el.textContent !== text) el.textContent = text;
  }

  function renderTurn() {
    if (!game) return;
    const ready = canRoll();
    dieBtn.classList.toggle("ready", ready);
    dieBtn.setAttribute("aria-disabled", String(!ready));
    dock.style.setProperty("--die", `var(--snake-${game.turn + 1})`);
    renderHud();
  }

  let hudCache = "";
  function renderHud() {
    if (!game) return;
    const html = game.players
      .map((p, i) => {
        const on = !game.over && i === game.turn;
        const at = pawns[i]?.square ?? p.square;
        const tag = on ? "to roll" : away(i) ? "away" : "";
        return (
          `<li class="${on ? "turn" : ""}"><span class="dot" style="background:var(--snake-${i + 1})"></span>` +
          `${escapeHtml(isMe(i) ? "You" : p.name)}<b>${at ? at : "Start"}</b>${tag ? `<span class="out-tag">${tag}</span>` : ""}</li>`
        );
      })
      .join("");
    if (html !== hudCache) {
      hudCache = html;
      $("laddersPlayers").innerHTML = html;
    }
  }

  function showOver() {
    const w = game.winner;
    const people = game.players.filter((p) => !p.computer).length;
    $("lOverTitle").textContent = isMe(w) ? "You win!" : people === 1 ? `${game.players[w].name} wins` : `${game.players[w].name} wins!`;
    $("lOverCause").textContent = `Reached 100 in ${plural(game.players[w].rolls, "roll", "rolls")}.`;
    $("lResults").innerHTML = standings(game)
      .map(
        (p, place) =>
          `<li><span class="pr-place">${place + 1}</span><span class="dot" style="background:var(--snake-${p.seat + 1})"></span>` +
          `<span class="pr-name">${escapeHtml(isMe(p.seat) ? "You" : p.name)}` +
          `<span class="pr-len">${p.computer ? " computer," : ""} ${plural(p.climbed, "ladder", "ladders")}, ${plural(p.slid, "snake", "snakes")}</span></span>` +
          `<span class="pr-score">${p.square || "Start"}</span></li>`
      )
      .join("");
    $("laddersOver").classList.remove("hidden");
    (net.role === "guest" ? $("lLeaveBtn") : $("lAgainBtn")).focus();
  }

  // The same players again, from the start. The host's to do in a game with
  // others; its joiners are sent the new game.
  function playAgain() {
    if (net.role === "guest" || !net.seats.length) return;
    newRound();
  }

  /* ---- Pause ----
     Alone, the game stops. With others it carries on behind the panel. */

  function setPaused(next) {
    if (!active || phase === "over" || paused === next) return;
    paused = next;
    document.body.classList.remove("party-pause");
    $("pauseOverlay").classList.toggle("hidden", !paused);
    if (paused) $("continueBtn").focus();
    else document.activeElement?.blur?.();
    renderTurn();
  }

  /* ---- Autoplay ----
     F2, or three quick taps on the game's name on a touch screen: the die
     rolls itself for this player too. Not mentioned on screen, as in the
     other editions. */

  function toggleAutoplay() {
    if (!active || phase === "over") return;
    autoplay = !autoplay;
    if (phase === "wait") beginTurn();
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

  /* ---- Hosting ---- */

  function seatsInfo() {
    return net.seats.map((s) => ({ kind: s.kind, name: s.name, away: s.kind === "guest" && !s.link }));
  }

  function stateMessage() {
    return { type: "state", game: snapshotGame(game), seats: seatsInfo() };
  }

  function lobbyMessage() {
    return { type: "lobby", size: net.size, seats: seatsInfo(), rules: { sixAgain: setup.sixAgain, bounce: setup.bounce } };
  }

  // To every joiner, each told which seat is theirs.
  function broadcast(message) {
    if (!net.host) return;
    net.seats.forEach((s, seat) => {
      if (s.kind === "guest" && s.link) net.host.send({ ...message, you: seat }, s.link);
    });
  }

  function openLobby() {
    stopNet();
    net.role = "host";
    net.lobby = true;
    net.size = setup.players;
    mySeat = 0;
    net.seats = [{ kind: "host", name: playerName() }];
    while (net.seats.length < net.size) net.seats.push({ kind: "open", name: "" });
    document.body.classList.add("ladders");
    $("startOverlay").classList.add("hidden");
    $("laddersLobby").classList.remove("hidden");
    loadNames();
    syncView();
    renderLobby();
    startHosting(generateCode());
    $("lLobbyStart").focus();
  }

  async function startHosting(code, triedFresh = false) {
    net.code = code;
    net.status = "connecting";
    net.error = "";
    const host = new Host({ maxGuests: MAX_GUESTS });
    net.host = host;
    host.addEventListener("status", ({ detail }) => {
      if (net.host !== host) return;
      if (detail.taken && !triedFresh) {
        // The broker still holds that code: a fresh one, once.
        net.host = null;
        host.close();
        startHosting(generateCode(), true);
        return;
      }
      if (detail.status === "waiting" || detail.status === "connected") net.status = "open";
      else if (detail.status === "error") {
        net.status = "error";
        net.error = detail.message;
      }
      renderLobby();
    });
    // A closed host's last messages, such as a joiner's goodbye, go nowhere.
    host.addEventListener("join", ({ detail }) => {
      if (net.host !== host) return;
      const m = detail.metadata ?? {};
      const pid = typeof m.pid === "string" ? m.pid.slice(0, 24) : detail.id;
      net.links.set(detail.id, { pid, name: cleanName(m.sname || m.name) });
    });
    host.addEventListener("leave", ({ detail }) => net.host === host && dropLink(detail.id));
    host.addEventListener("message", ({ detail }) => net.host === host && onGuestMessage(detail.message, detail.from));
    clearInterval(net.beat);
    net.beat = setInterval(() => {
      if (net.host !== host) return;
      broadcast(net.lobby || !game ? lobbyMessage() : stateMessage());
      if (net.lobby) renderLobby();
    }, BEAT_MS);
    try {
      await host.start(code);
    } catch {
      if (net.host === host) {
        net.status = "error";
        net.error = "Could not load pairing. Check your connection. You can still play the computer.";
        renderLobby();
      }
    }
  }

  // A joiner said hello: their seat back if they had one, a free one in
  // the lobby, or a polite no.
  function admit(link) {
    const info = net.links.get(link);
    if (!info) return;
    let seat = net.seats.findIndex((s) => s.kind === "guest" && s.pid === info.pid);
    if (seat < 0) {
      seat = net.lobby ? net.seats.findIndex((s) => s.kind === "open") : -1;
      if (seat < 0) {
        net.host.dismiss(link, { type: net.lobby ? "full" : "started" });
        net.links.delete(link);
        return;
      }
      net.seats[seat] = { kind: "guest", pid: info.pid, name: uniqueName(info.name || `Player ${seat + 1}`), link };
    } else {
      net.seats[seat].link = link;
    }
    broadcast(net.lobby ? lobbyMessage() : stateMessage());
    renderLobby();
    if (active) {
      hudCache = "";
      if (phase === "wait" && game.turn === seat) beginTurn();
      else renderHud();
    }
  }

  function uniqueName(name) {
    const taken = new Set(net.seats.map((s) => s.name.toLowerCase()));
    let out = name;
    for (let k = 2; taken.has(out.toLowerCase()); k += 1) out = `${name} ${k}`;
    return out;
  }

  // A joiner went. In the lobby their seat opens again; in a game they keep
  // it, and the computer rolls for them until they are back.
  function dropLink(link) {
    net.links.delete(link);
    const seat = net.seats.findIndex((s) => s.kind === "guest" && s.link === link);
    if (seat < 0) return;
    if (net.lobby) net.seats[seat] = { kind: "open", name: "" };
    else net.seats[seat].link = null;
    broadcast(net.lobby ? lobbyMessage() : stateMessage());
    renderLobby();
    if (active) {
      hudCache = "";
      if (phase === "wait" && game.turn === seat) beginTurn();
      else renderHud();
    }
  }

  function onGuestMessage(m, from) {
    switch (m.type) {
      case "hello":
        if (m.v !== PROTOCOL_VERSION) {
          net.host.send({ type: "reload" }, from);
          return;
        }
        // Tells js/party.js on the other end to hand the link over here.
        net.host.send({ type: "edition", edition: "ladders", rules: RULES_VERSION }, from);
        admit(from);
        break;
      case "roll": {
        const seat = net.seats.findIndex((s) => s.kind === "guest" && s.link === from);
        if (seat >= 0 && active && phase === "wait" && game.turn === seat && m.seq === game.seq) roll();
        break;
      }
      case "bye":
        net.host.dropId(from);
        dropLink(from);
        break;
      default:
        // Pings, and anything from a newer build: ignored, never thrown on.
        break;
    }
  }

  async function startFromLobby() {
    if (net.role !== "host" || !net.lobby) return;
    await loadNames();
    if (!net.lobby) return;
    const bots = pickNames(net.seats.filter((s) => s.kind === "open").length, net.seats.map((s) => s.name));
    net.seats = net.seats.map((s) => (s.kind === "open" ? { kind: "computer", name: bots.shift() } : s));
    newRound();
  }

  /* ---- Joining ---- */

  // Called by js/party.js once a host says its game is a Snakes & Ladders
  // one. The connection is open and has said hello.
  function joinWith(guest, code, hello = {}) {
    if (hello.rules !== RULES_VERSION) {
      guest.close();
      leave("That game is on a different version. Reload this page, and ask the host to as well.");
      return;
    }
    close();
    net.role = "guest";
    net.code = code;
    net.lobby = true;
    net.status = "open";
    net.seats = [];
    net.reconnects = 0;
    mySeat = -1;
    attachGuest(guest);
    closeModal("partyModal");
    document.body.classList.add("ladders");
    $("startOverlay").classList.add("hidden");
    $("laddersLobby").classList.remove("hidden");
    syncView();
    renderLobby();
    wakeLock(true);
  }

  function attachGuest(guest) {
    net.guest = guest;
    guest.addEventListener("message", ({ detail }) => {
      if (net.guest === guest) onHostMessage(detail.message);
    });
    guest.addEventListener("status", ({ detail }) => {
      if (net.guest !== guest) return;
      if (detail.status === "connected") {
        net.reconnects = 0;
        net.status = "open";
        renderLobby();
      } else if (["dropped", "unreachable", "error"].includes(detail.status)) {
        hostLost();
      }
    });
  }

  // The link to the host went: try again for a while under the same code,
  // which gives this player their seat back.
  function hostLost() {
    const guest = net.guest;
    net.guest = null;
    guest?.close();
    if (net.role !== "guest") return;
    if (net.reconnects >= RECONNECTS) {
      leave("Lost the connection to the host.");
      return;
    }
    net.reconnects += 1;
    net.status = "connecting";
    if (active) setStatus("Reconnecting to the host…");
    renderLobby();
    clearTimeout(net.retry);
    net.retry = setTimeout(async () => {
      if (net.role !== "guest") return;
      const next = new Guest();
      attachGuest(next);
      try {
        await next.connect(net.code, { pid: browserId(), name: playerName(), sname: playerName() });
      } catch {
        hostLost();
      }
    }, 2000);
  }

  function onHostMessage(m) {
    switch (m.type) {
      case "edition":
        if (m.rules !== RULES_VERSION) leave("That game is on a different version. Reload this page.");
        break;
      case "lobby":
        if (!net.lobby) return;
        net.size = Math.min(MAX_PLAYERS, Math.max(2, Number(m.size) || 2));
        net.seats = cleanSeats(m.seats);
        mySeat = seatOf(m);
        net.rules = { sixAgain: m.rules?.sixAgain !== false, bounce: m.rules?.bounce === true };
        renderLobby();
        break;
      case "start":
      case "state": {
        const g = restoreGame(m.game);
        const seats = cleanSeats(m.seats);
        if (!g || seats.length !== g.players.length) return;
        net.seats = seats;
        mySeat = seatOf(m);
        if (m.type === "start" || net.lobby || !game) {
          game = g;
          enterGame();
          showGame();
          return;
        }
        // A copy that differs from this one, between moves: this device
        // missed a roll, and takes the host's.
        const between = phase === "wait" || phase === "next" || phase === "over";
        if (between && !net.pending.length && g.seq !== game.seq) {
          game = g;
          showGame();
        } else if (phase === "wait" && !net.pending.length) {
          // Who is away may have changed, and a roll asked for that the
          // host never took can be asked for again.
          net.asked = false;
          dieBtn.classList.remove("rolling");
          beginTurn();
        } else {
          hudCache = "";
          renderHud();
        }
        break;
      }
      case "roll": {
        if (!game || net.lobby) return;
        const ok = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
        if (!ok(m.value, 1, 6) || !ok(m.seat, 0, game.players.length - 1) || !Number.isInteger(m.seq)) return;
        // In order after whatever is still to be shown; anything else is put
        // right by the host's next copy of the game.
        if (m.seq === game.seq + (phase === "rolling" ? 1 : 0) + net.pending.length) net.pending.push(m);
        break;
      }
      case "full":
        leave("That game is full.");
        break;
      case "started":
        leave("That game has already started.");
        break;
      case "reload":
        leave("The host is on a newer version. Reload this page to join.");
        break;
      case "closed":
        leave("The host ended the game.");
        break;
      default:
        break;
    }
  }

  // The game as the host sent it, at rest.
  function showGame() {
    placePawns();
    if (game.over) {
      phase = "over";
      renderTurn();
      showOver();
    } else {
      $("laddersOver").classList.add("hidden");
      beginTurn();
    }
  }

  function cleanSeats(list) {
    const kinds = ["host", "guest", "computer", "open"];
    return (Array.isArray(list) ? list.slice(0, MAX_PLAYERS) : []).map((s, i) => ({
      kind: kinds.includes(s?.kind) ? s.kind : "open",
      name: cleanName(s?.name) || `Player ${i + 1}`,
      away: s?.away === true,
    }));
  }

  const seatOf = (m) => (Number.isInteger(m.you) && m.you >= 0 && m.you < MAX_PLAYERS ? m.you : -1);

  // Hosting or joined: everyone told, links closed.
  function stopNet() {
    clearInterval(net.beat);
    clearTimeout(net.retry);
    if (net.host) {
      const host = net.host;
      net.host = null;
      host.send({ type: "closed" });
      // A moment for the goodbye to go out before the links close.
      setTimeout(() => host.close(), 200);
    }
    if (net.guest) {
      const guest = net.guest;
      net.guest = null;
      guest.leave();
    }
    net.role = null;
    net.lobby = false;
    net.links.clear();
    net.pending = [];
    net.asked = false;
    net.status = "off";
  }

  /* ---- The lobby: the code, who is in, and Start ---- */

  function renderLobby() {
    if (!net.lobby) return;
    const hosting = net.role === "host";
    $("lLobbyTitle").textContent = hosting ? "Waiting for players" : "Waiting for the host to start";
    $("lLobbyInvite").hidden = !hosting;
    $("lLobbyStart").classList.toggle("hidden", !hosting);
    $("lLobbyLeaveLabel").textContent = hosting ? "Cancel" : "Leave";
    if (hosting) {
      const open = net.status === "open";
      const link = open ? `${location.origin}/join?id=${net.code}` : "";
      $("lLobbyCode").textContent = open ? net.code : "";
      $("lLobbyLink").textContent = link.replace(/^https?:\/\//, "");
      $("lLobbyLink").dataset.link = link;
      const qr = $("lLobbyQr");
      if (qr.dataset.code !== (open ? net.code : "")) {
        qr.dataset.code = open ? net.code : "";
        qr.innerHTML = open ? qrToSvg(link, { label: `Join link for code ${net.code}` }) : "";
      }
      $("lLobbyLinkRow").hidden = !open;
      const empty = net.seats.filter((s) => s.kind === "open").length;
      $("lLobbyStartLabel").textContent = empty ? `Start, ${empty === 1 ? "a computer" : `${empty} computers`} filling in` : "Start";
      $("lLobbyStatus").textContent =
        net.status === "error"
          ? net.error
          : net.status === "connecting"
            ? "Opening the game."
            : empty
              ? `Waiting for ${plural(empty, "more person", "more people")}. Start whenever you like.`
              : "Everyone is in.";
    } else {
      $("lLobbyStatus").textContent = net.status === "connecting" ? "Reconnecting to the host." : net.seats.length ? "" : "Joining.";
    }
    const r = hosting ? setup : (net.rules ?? setup);
    $("lLobbyRules").textContent = `${r.sixAgain ? "A 6 rolls again" : "One roll a turn"}. ${r.bounce ? "Rolls past 100 bounce back." : "100 takes the exact roll."}`;
    $("lLobbySeats").innerHTML = net.seats
      .map((s, i) => {
        const name = s.kind === "open" ? "Open seat" : escapeHtml(s.name) + (i === mySeat ? " (you)" : "");
        const role =
          s.kind === "host" ? "Host" : s.kind === "guest" ? (away(i) ? "Away" : "Joined") : s.kind === "computer" ? "Computer" : "Waiting";
        return `<li><span class="pp-name"><span class="dot" style="background:var(--snake-${i + 1})"></span> ${name}</span><span class="pp-role">${role}</span></li>`;
      })
      .join("");
  }

  /* ---- Screen wake lock, while others are in the game ---- */

  let lock = null;
  let wantLock = false;
  async function wakeLock(on) {
    wantLock = on;
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
      // Refused, as on low battery: the screen may sleep.
    }
  }

  /* ---- Input ---- */

  function onKeyDown(e) {
    if (!active) return;
    if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
    if (e.defaultPrevented || document.body.classList.contains("modal-open")) return;
    if (e.target instanceof Element && e.target.closest("input, textarea, select")) return;
    if (e.key === "F2") {
      e.preventDefault();
      if (!e.repeat) toggleAutoplay();
      return;
    }
    if (e.key === "Escape") {
      setPaused(!paused);
      return;
    }
    if (paused || phase === "over") return;
    if (e.key === " " || e.key === "Enter" || e.code === "KeyR") {
      // A focused button, the die among them, takes Space and Enter itself.
      if (e.code !== "KeyR" && e.target instanceof Element && e.target.closest("button, a")) return;
      e.preventDefault();
      if (!e.repeat) tryRoll();
    }
  }

  // A tap or click on the board rolls.
  let press = null;
  function onPointerDown(e) {
    if (!active || e.button > 0) return;
    press = { id: e.pointerId, x: e.clientX, y: e.clientY };
  }
  function onPointerUp(e) {
    if (!press || e.pointerId !== press.id) return;
    const p = press;
    press = null;
    if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > TAP_PX) return;
    const r = canvas.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return;
    tryRoll();
  }

  /* ---- The loop ---- */

  function fit() {
    const w = canvas.clientWidth;
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    if (w === size && ratio === dpr) return false;
    size = w;
    dpr = ratio;
    canvas.width = Math.max(1, Math.round(size * dpr));
    canvas.height = canvas.width;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return true;
  }

  let last = performance.now();
  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(250, now - last);
    last = now;
    if (!viewing) return;
    if (fit()) dirty = true;
    update(dt, now);
    // A game on screen moves every frame; the board behind the pre-game
    // screen or the lobby only when its size or the theme changes.
    if (!dirty && !(active && (!paused || net.role)) && phase !== "over") return;
    dirty = false;
    if (!size) return;
    drawLaddersBoard(ctx, size, theme, {
      dpr,
      pawns: active ? pawns.map((p, seat) => ({ ...p, seat })) : [],
      turn: active && !game.over ? game.turn : -1,
      pulse: now / 1000,
      glow: active && phase === "wait" && myTurn(),
    });
  }

  /* ---- Wiring ---- */

  $("lPlayerChips").addEventListener("click", (e) => {
    const chip = e.target.closest("[data-players]");
    if (chip) setSetup({ players: Number(chip.dataset.players) });
  });
  $("lBotChips").addEventListener("click", (e) => {
    const chip = e.target.closest("[data-computers]");
    if (chip) setSetup({ computers: Number(chip.dataset.computers) });
  });
  $("lRuleChips").addEventListener("click", (e) => {
    const chip = e.target.closest("[data-rule]");
    if (chip) setSetup({ [chip.dataset.rule]: !setup[chip.dataset.rule] });
  });

  $("lLobbyStart").addEventListener("click", startFromLobby);
  $("lLobbyLeave").addEventListener("click", () => leave());
  $("lLobbyCopy").addEventListener("click", async () => {
    const label = $("lLobbyCopy").querySelector(".copy-label");
    try {
      await navigator.clipboard.writeText($("lLobbyLink").dataset.link);
      label.textContent = "Copied";
    } catch {
      getSelection()?.selectAllChildren($("lLobbyLink"));
      label.textContent = "Selected";
    }
    setTimeout(() => {
      label.textContent = "Copy";
    }, 1500);
  });

  dieBtn.addEventListener("click", tryRoll);
  const stage = $("stage");
  stage.addEventListener("pointerdown", onPointerDown);
  stage.addEventListener("pointerup", onPointerUp);
  stage.addEventListener("pointercancel", () => {
    press = null;
  });
  window.addEventListener("keydown", onKeyDown);
  $("brand").addEventListener("pointerdown", onBrandTap);

  $("pauseBtn").addEventListener("click", () => active && setPaused(!paused));
  $("continueBtn").addEventListener("click", () => active && setPaused(false));
  $("lRestartBtn").addEventListener("click", () => active && !net.role && playAgain());
  $("lQuitBtn").addEventListener("click", () => active && leave());
  $("lAgainBtn").addEventListener("click", playAgain);
  $("lLeaveBtn").addEventListener("click", () => leave());

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      if (!net.role) setPaused(true);
    } else if (wantLock) {
      wakeLock(true);
    }
  });
  // The board follows the theme: new colours the moment the swatch or the
  // mode changes, including time based mode turning over at 09:00 or 18:00.
  new MutationObserver(() => {
    theme = readBoardTheme();
    dirty = true;
  }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-mode", "data-color-theme", "style"] });
  new MutationObserver(syncView).observe($("startOverlay"), { attributes: true, attributeFilter: ["class"] });
  // The numbers drawn before Jua arrived are drawn again in it.
  document.fonts?.ready.then(() => {
    forgetBoard();
    dirty = true;
  });

  renderSetup();
  requestAnimationFrame(frame);

  return {
    play,
    joinWith,
    close,
    pause: () => setPaused(true),
    // The pre-game screen's edition, as it changes.
    setPicked(on) {
      picked = on;
      if (on) (window.requestIdleCallback ?? setTimeout)(() => loadNames());
      syncView();
    },
  };
}
