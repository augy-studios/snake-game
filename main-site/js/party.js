// Party games: people on the same network playing on one board, together or
// against each other, with anyone past the four snakes watching and dropping
// walls in the way or extra fruit.
//
// One device hosts and runs the game (js/rules.js, through js/game.js); the
// others join with a six character code, a link or a QR code, and talk to it
// directly over WebRTC, set up through PeerJS's public broker with STUN only,
// per STUN-p2p-spec.md. The host is authoritative: guests send turns and
// placements, and the host sends the whole board back on every move and at
// least twenty times a second, which doubles as the heartbeat.

import { GRID, MAX_SNAKES } from "./rules.js";
import { cleanText } from "./replay-format.js";
import { CODE_LENGTH, Guest, Host, PROTOCOL_VERSION, generateCode, isValidCode, normaliseCode } from "./p2p.js";
import { qrToSvg } from "./qr.js";
import { getSettings } from "./settings.js";
import { closeModal, escapeHtml, openModal, store } from "./ui.js";
import { TOOL_COOLDOWN_MS } from "./game.js";

const MAX_GUESTS = 7;
const CODE_KEY = "uwusnek.hostCode";
const LAST_KEY = "uwusnek.lastCode";
const PID_KEY = "uwusnek.partyId";
const BEAT_MS = 50;
const STALE_MS = 2500;
const PING_MS = 1000;

const $ = (id) => document.getElementById(id);

let game = null;

/* ---- Snapshots ----
   The board in as few bytes as JSON allows: bodies as flat coordinate
   lists, fruit and walls as arrays. A long snake is still a few kilobytes. */

function packView(st) {
  return {
    grid: st.grid,
    seed: st.seed,
    mode: st.mode,
    settings: st.settings,
    level: st.level,
    timeMs: st.timeMs,
    tick: st.tick,
    over: st.over,
    snakes: st.snakes.map((s) => ({ id: s.id, alive: s.alive, dir: s.dir, score: s.score, longest: s.longest, body: s.body.flat() })),
    fruits: st.fruits.map((f) => [f.x, f.y, f.extra ? 1 : 0, f.bornMs, f.limitMs]),
    walls: st.walls.map((w) => [w.untilMs, ...w.cells.flat()]),
  };
}

const num = (v, min, max) => (Number.isFinite(v) ? Math.max(min, Math.min(max, Math.round(v))) : min);
const coord = (v) => num(v, 0, GRID - 1);

function pairs(flat, max) {
  const out = [];
  if (!Array.isArray(flat)) return out;
  for (let i = 0; i + 1 < flat.length && out.length < max; i += 2) out.push([coord(flat[i]), coord(flat[i + 1])]);
  return out;
}

// A snapshot from the host, checked like any other input from another device.
function unpackView(v) {
  if (!v || typeof v !== "object" || !Array.isArray(v.snakes)) return null;
  return {
    grid: GRID,
    seed: cleanText(v.seed, 24),
    mode: v.mode === "versus" ? "versus" : "coop",
    settings: {
      difficulty: ["easy", "normal", "hard"].includes(v.settings?.difficulty) ? v.settings.difficulty : "normal",
      start_level: num(v.settings?.start_level, 0, 99),
      game_seconds: num(v.settings?.game_seconds, 0, 3600),
      fruit_seconds: num(v.settings?.fruit_seconds, 0, 60),
    },
    level: num(v.level, 0, 9999),
    timeMs: num(v.timeMs, 0, 1e9),
    tick: num(v.tick, 0, 1e7),
    over: v.over === true,
    started: true,
    snakes: v.snakes.slice(0, MAX_SNAKES).map((s, i) => ({
      id: i,
      alive: s?.alive === true,
      dir: num(s?.dir, -1, 3),
      score: num(s?.score, 0, 1e9),
      longest: num(s?.longest, 1, GRID * GRID),
      body: pairs(s?.body, GRID * GRID),
      fruits: 0,
    })),
    fruits: (Array.isArray(v.fruits) ? v.fruits.slice(0, 32) : []).map((f) => ({
      x: coord(f?.[0]),
      y: coord(f?.[1]),
      extra: f?.[2] === 1,
      bornMs: num(f?.[3], 0, 1e9),
      limitMs: num(f?.[4], 0, 1e7),
    })),
    walls: (Array.isArray(v.walls) ? v.walls.slice(0, 32) : []).map((w) => ({
      untilMs: num(w?.[0], 0, 1e9),
      cells: pairs(Array.isArray(w) ? w.slice(1) : [], 3),
    })),
  };
}

/* ---- Who is in the party ---- */

function myName() {
  return getSettings().name ?? "";
}

// A stable id for this browser, so a guest that reloads or drops gets its
// seat back rather than a new one.
function partyId() {
  let id = store.get(PID_KEY);
  if (!/^[A-Za-z0-9]{12}$/.test(id ?? "")) {
    id = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => "abcdefghijkmnpqrstuvwxyz23456789"[b % 32]).join("");
    store.set(PID_KEY, id);
  }
  return id;
}

/* ---- Hosting ---- */

const hosting = {
  host: null,
  code: null,
  retriedTaken: false,
  mode: "coop",
  phase: "lobby",
  hostRole: "play",
  people: new Map(), // pid -> { pid, link, name, role, seat, heardAt, cooldowns }
  seats: [],
  hostSeat: null,
  gameId: 0,
  lastSent: 0,
  over: null,
};

function guestList() {
  return [...hosting.people.values()];
}

function lobbyPeople() {
  return [
    { name: myName() || "Host", role: hosting.hostRole, host: true },
    ...guestList().map((p) => ({ name: p.name, role: p.role, away: performance.now() - p.heardAt > STALE_MS || !p.link })),
  ];
}

function hostMessage(base, p) {
  return { ...base, you: p.pid, mySeat: p.seat ?? null, watching: p.seat == null };
}

function broadcast(force = false) {
  const h = hosting;
  if (!h.host) return;
  const now = performance.now();
  if (!force && now - h.lastSent < BEAT_MS) return;
  h.lastSent = now;
  const st = h.phase === "play" ? game.localState() : null;
  const base = {
    type: "state",
    v: PROTOCOL_VERSION,
    phase: h.phase,
    game: h.gameId,
    mode: h.mode,
    people: lobbyPeople(),
    seats: h.seats,
    view: st ? packView(st) : null,
    countdown: st ? Math.max(0, (game.session?.countdownUntil ?? 0) - now) : 0,
    paused: Boolean(game.session?.paused),
  };
  for (const p of guestList()) if (p.link) h.host.send(hostMessage(base, p), p.link);
}

function renderHost() {
  const h = hosting;
  $("hostCode").textContent = h.code ?? "";
  const link = h.code ? `${location.origin}/join?id=${h.code}` : "";
  $("hostLink").textContent = link.replace(/^https?:\/\//, "");
  $("hostLink").dataset.link = link;
  $("hostQr").innerHTML = h.code ? qrToSvg(link, { label: `Join link for code ${h.code}` }) : "";
  document.querySelectorAll("#partyModeToggle [data-party-mode]").forEach((el) => {
    const on = el.dataset.partyMode === h.mode;
    el.classList.toggle("active", on);
    el.setAttribute("aria-pressed", String(on));
  });
  document.querySelectorAll("#hostRoleToggle [data-role]").forEach((el) => {
    const on = el.dataset.role === h.hostRole;
    el.classList.toggle("active", on);
    el.setAttribute("aria-pressed", String(on));
  });
  $("hostPeople").innerHTML = peopleHtml(lobbyPeople());
  const players = lobbyPeople().filter((p) => p.role === "play").length;
  $("partyStartBtn").disabled = players === 0 || h.phase === "play";
  $("partyStartBtn").textContent = h.phase === "play" ? "Playing" : "Start";
  $("hostCount").textContent =
    players === 0 ? "Nobody is set to play yet." : players > MAX_SNAKES ? `${players} want to play; the first ${MAX_SNAKES} do, the rest watch.` : "";
}

function peopleHtml(list, youIndex = -1) {
  return list
    .map(
      (p, i) =>
        `<li><span class="pp-name">${escapeHtml(p.name || `Player ${i + 1}`)}${p.host ? " (host)" : ""}${i === youIndex ? " (you)" : ""}</span>` +
        `<span class="pp-role">${p.role === "play" ? "Plays" : "Watches"}${p.away ? ", away" : ""}</span></li>`
    )
    .join("");
}

function setHostStatus(text) {
  $("hostStatus").textContent = text;
}

async function startHosting() {
  if (hosting.host) return showView("host");
  showView("host");
  const stored = store.get(CODE_KEY);
  const code = isValidCode(stored) ? stored : generateCode();
  store.set(CODE_KEY, code);
  hosting.code = code;
  hosting.phase = "lobby";
  renderHost();
  setHostStatus("Opening the party.");

  const host = new Host({ maxGuests: MAX_GUESTS });
  hosting.host = host;
  host.addEventListener("status", ({ detail }) => {
    if (hosting.host !== host) return;
    if (detail.taken && !hosting.retriedTaken) {
      // Another tab, or the broker still holding the code from a reload:
      // a fresh code, once.
      hosting.retriedTaken = true;
      restartWithFreshCode();
      return;
    }
    if (detail.status === "waiting") {
      hosting.retriedTaken = false;
      setHostStatus("Waiting for people to join. Everyone has to be on the same network.");
    } else if (detail.status === "connected") {
      setHostStatus("");
    } else if (detail.status === "error") {
      setHostStatus(detail.message);
    } else if (detail.status === "connecting") {
      setHostStatus("Opening the party.");
    }
    renderHost();
  });
  host.addEventListener("join", ({ detail }) => {
    const pid = typeof detail.metadata?.pid === "string" ? detail.metadata.pid.slice(0, 16) : detail.id;
    const name = cleanText(detail.metadata?.name, 20) || `Player ${hosting.people.size + 2}`;
    const known = hosting.people.get(pid);
    if (known) {
      known.link = detail.id;
      known.heardAt = performance.now();
    } else {
      const role = detail.metadata?.role === "watch" ? "watch" : "play";
      hosting.people.set(pid, { pid, link: detail.id, name, role, seat: null, heardAt: performance.now(), cooldowns: { wall: 0, fruit: 0 } });
    }
    renderHost();
    broadcast(true);
  });
  host.addEventListener("leave", ({ detail }) => {
    for (const p of guestList()) {
      if (p.link !== detail.id) continue;
      p.link = null;
      // In the lobby a guest who went is gone; mid-game they keep their seat
      // to come back to, and their snake carries on.
      if (hosting.phase !== "play") hosting.people.delete(p.pid);
    }
    renderHost();
    broadcast(true);
  });
  host.addEventListener("message", ({ detail: { message, from } }) => onGuestMessage(message, from));

  try {
    await host.start(code);
  } catch {
    hosting.host = null;
    setHostStatus("Could not load pairing. Check your connection.");
  }
}

function personByLink(link) {
  return guestList().find((p) => p.link === link) ?? null;
}

function onGuestMessage(message, from) {
  const p = personByLink(from);
  if (!p) return;
  p.heardAt = performance.now();
  switch (message.type) {
    case "hello":
      if (message.v !== PROTOCOL_VERSION) {
        hosting.host.send({ type: "reload" }, from);
        return;
      }
      broadcast(true);
      if (hosting.over) hosting.host.send({ type: "over", game: hosting.gameId, ...hosting.over }, from);
      break;
    case "role":
      if (hosting.phase === "play") return;
      p.role = message.role === "watch" ? "watch" : "play";
      renderHost();
      broadcast(true);
      break;
    case "name": {
      const name = cleanText(message.name, 20);
      if (name) p.name = name;
      renderHost();
      broadcast(true);
      break;
    }
    case "input":
      if (hosting.phase === "play" && p.seat != null && Number.isInteger(message.dir) && message.dir >= 0 && message.dir <= 3) {
        game.queueInput(p.seat, message.dir);
      }
      break;
    case "place": {
      if (hosting.phase !== "play" || p.seat != null) return;
      const tool = ["across", "down", "fruit"].includes(message.tool) ? message.tool : null;
      const kind = tool === "fruit" ? "fruit" : "wall";
      const now = performance.now();
      if (!tool || !Number.isInteger(message.x) || !Number.isInteger(message.y) || p.cooldowns[kind] > now) {
        hosting.host.send({ type: "refused", kind }, from);
        return;
      }
      p.cooldowns[kind] = now + TOOL_COOLDOWN_MS - 200;
      game.queuePlace(tool, message.x, message.y).then((ok) => {
        if (ok) return;
        p.cooldowns[kind] = 0;
        hosting.host?.send({ type: "refused", kind }, from);
      });
      break;
    }
    case "bye":
      // Leaving on purpose: the seat goes too.
      hosting.people.delete(p.pid);
      hosting.host.dropId(from);
      renderHost();
      broadcast(true);
      break;
    default:
      // Pings, and anything from a newer build: ignored, never thrown on.
      break;
  }
}

function startPartyGame() {
  const h = hosting;
  if (!h.host || h.phase === "play") return;
  const everyone = [{ pid: null, name: myName() || "Host", role: h.hostRole }, ...guestList().filter((p) => p.link)];
  const players = everyone.filter((p) => p.role === "play").slice(0, MAX_SNAKES);
  if (!players.length) return;
  for (const p of guestList()) p.seat = null;
  players.forEach((p, i) => {
    if (p.pid) h.people.get(p.pid).seat = i;
  });
  h.hostSeat = players.findIndex((p) => p.pid === null);
  if (h.hostSeat < 0) h.hostSeat = null;
  h.seats = players.map((p) => p.name);
  h.phase = "play";
  h.over = null;
  h.gameId += 1;
  closeModal("partyModal");
  game.startHost({
    mode: h.mode,
    seats: h.seats,
    mySeat: h.hostSeat,
    onTick: () => broadcast(true),
    onEnd: (result, replay) => {
      h.phase = "over";
      h.over = { result, replay };
      broadcast(true);
      hosting.host?.send({ type: "over", game: h.gameId, result, replay });
    },
  });
  wakeLock(true);
  broadcast(true);
}

function backToLobby() {
  if (hosting.host) {
    hosting.phase = "lobby";
    hosting.over = null;
    game.showStart();
    renderHost();
    broadcast(true);
    showView("host");
    openModal("partyModal");
  } else if (joining.guest) {
    game.showStart();
    showView("guest");
    openModal("partyModal");
  }
}

function stopHosting({ quiet = false } = {}) {
  const host = hosting.host;
  if (!host) return;
  if (!quiet) host.send({ type: "closed" });
  hosting.host = null;
  // A moment for the goodbye to go out before the links close.
  setTimeout(() => host.close(), 150);
  hosting.people.clear();
  hosting.phase = "lobby";
  hosting.over = null;
  wakeLock(false);
}

async function restartWithFreshCode() {
  stopHosting({ quiet: true });
  store.set(CODE_KEY, "");
  await startHosting();
}

/* ---- Joining ---- */

const joining = {
  guest: null,
  code: "",
  you: null,
  gameId: 0,
  heardAt: 0,
  pinger: null,
  lastState: null,
};

function setGuestStatus(text) {
  $("guestStatus").textContent = text;
}

async function join(input) {
  const code = normaliseCode(input);
  if (!isValidCode(code)) {
    $("partyMsg").textContent = `A code is ${CODE_LENGTH} characters.`;
    return;
  }
  if (hosting.host) stopHosting();
  joining.guest?.close();
  joining.code = code;
  showView("guest");
  setGuestStatus("Connecting.");
  $("reconnectBtn").hidden = true;

  const guest = new Guest();
  joining.guest = guest;
  guest.addEventListener("status", ({ detail }) => {
    if (joining.guest !== guest) return;
    const s = detail.status;
    $("reconnectBtn").hidden = !(s === "dropped" || s === "unreachable" || s === "error");
    if (s === "connecting") setGuestStatus("Connecting.");
    else if (s === "connected") {
      setGuestStatus("Connected. Waiting for the host to start.");
      store.set(LAST_KEY, code);
      wakeLock(true);
    } else if (s === "dropped") setGuestStatus("The connection dropped. Reconnect to get your place back.");
    else if (s === "unreachable") {
      setGuestStatus(
        "Could not reach the host. Both have to be on the same network: join the same wifi, or turn on a hotspot on one and join it from the other. Check the code is still the one on screen."
      );
    } else if (s === "error") setGuestStatus(detail.message);
  });
  guest.addEventListener("message", ({ detail: { message } }) => onHostMessage(message));

  clearInterval(joining.pinger);
  joining.pinger = setInterval(() => {
    guest.send({ type: "ping" });
    // The host's snapshots are the heartbeat. Measured in time, so an
    // ordinary wifi stall does not trip it.
    if (guest.status === "connected" && joining.heardAt && performance.now() - joining.heardAt > STALE_MS) {
      setGuestStatus("The connection looks stale. It may come back, or Reconnect.");
      $("reconnectBtn").hidden = false;
    }
  }, PING_MS);

  try {
    // The seat key, the name and whether to play travel with the connection,
    // so a reconnect brings all three back.
    await guest.connect(code, { pid: partyId(), name: myName(), role: wantedRole });
  } catch {
    setGuestStatus("Could not load pairing. Check your connection.");
  }
}

function onHostMessage(message) {
  joining.heardAt = performance.now();
  switch (message.type) {
    case "state":
      onHostState(message);
      break;
    case "over": {
      if (message.game !== joining.gameId) return;
      const result = message.result && typeof message.result === "object" ? message.result : null;
      if (result) game.remoteOver(sanitizeResult(result), message.replay);
      break;
    }
    case "refused":
      game.placeRefused(message.kind === "fruit" ? "fruit" : "wall");
      break;
    case "full":
      setGuestStatus("This party is full.");
      break;
    case "reload":
      setGuestStatus("The host is on a newer version. Reload this page to join.");
      break;
    case "closed":
      leave({ quiet: true });
      game.endParty();
      game.showStart({ message: "The host ended the party." });
      break;
    default:
      break;
  }
}

function sanitizeResult(r) {
  return {
    score: num(r.score, 0, 1e9),
    fruits: num(r.fruits, 0, 1e6),
    length: num(r.length, 1, GRID * GRID),
    level: num(r.level, 0, 9999),
    durationMs: num(r.durationMs, 0, 1e9),
    reason: r.reason === "time" ? "time" : r.reason === "last" ? "last" : "crash",
    winner: Number.isInteger(r.winner) ? num(r.winner, 0, MAX_SNAKES - 1) : null,
    autoplayed: false,
    snakes: (Array.isArray(r.snakes) ? r.snakes.slice(0, MAX_SNAKES) : []).map((s) => ({
      score: num(s?.score, 0, 1e9),
      fruits: num(s?.fruits, 0, 1e6),
      length: num(s?.length, 1, GRID * GRID),
      cause: ["self", "wall", "snake", "head"].includes(s?.cause) ? s.cause : null,
    })),
  };
}

function onHostState(m) {
  joining.lastState = m;
  const people = Array.isArray(m.people) ? m.people.slice(0, MAX_GUESTS + 1) : [];
  const clean = people.map((p) => ({ name: cleanText(p?.name, 20), role: p?.role === "watch" ? "watch" : "play", host: p?.host === true, away: p?.away === true }));
  const mine = guestRole();
  $("guestPeople").innerHTML = peopleHtml(clean);
  $("guestMode").textContent = m.mode === "versus" ? "Against each other" : "Playing together";
  document.querySelectorAll("#guestRoleToggle [data-role]").forEach((el) => {
    const on = el.dataset.role === mine;
    el.classList.toggle("active", on);
    el.setAttribute("aria-pressed", String(on));
  });

  if ((m.phase === "play" || m.phase === "over") && m.view) {
    const seats = (Array.isArray(m.seats) ? m.seats.slice(0, MAX_SNAKES) : []).map((s, i) => cleanText(s, 20) || `Player ${i + 1}`);
    const mySeat = Number.isInteger(m.mySeat) && m.mySeat < seats.length ? m.mySeat : null;
    if (m.game !== joining.gameId) {
      if (m.phase === "over") return;
      joining.gameId = m.game;
      closeModal("partyModal");
      game.startRemote({
        seats,
        mySeat,
        watching: mySeat === null,
        send: (msg) => joining.guest?.send(msg),
      });
    }
    const view = unpackView(m.view);
    if (view) game.showRemote(view, { countdown: num(m.countdown, 0, 10000), paused: m.paused === true });
  } else if (m.phase === "lobby" && game.session?.kind === "remote" && !game.session.view?.over) {
    // The host went back to the lobby mid-game.
    backToLobby();
  }
}

let wantedRole = store.get("uwusnek.partyRole") === "watch" ? "watch" : "play";
function guestRole() {
  return wantedRole;
}

function leave({ quiet = false } = {}) {
  clearInterval(joining.pinger);
  if (!quiet) joining.guest?.leave();
  else joining.guest?.close();
  joining.guest = null;
  joining.gameId = 0;
  store.set(LAST_KEY, "");
  wakeLock(false);
}

/* ---- Screen wake lock, while a party is on ---- */

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

/* ---- The window ---- */

function showView(which) {
  $("partyChoose").hidden = which !== "choose";
  $("partyHost").hidden = which !== "host";
  $("partyGuest").hidden = which !== "guest";
}

export function openParty({ code = "" } = {}) {
  game.pause();
  if (hosting.host) {
    renderHost();
    showView("host");
  } else if (joining.guest) {
    showView("guest");
  } else {
    showView("choose");
    $("partyMsg").textContent = navigator.onLine === false ? "Playing with others needs a connection to pair." : "";
    $("joinCode").value = code || store.get(LAST_KEY) || "";
  }
  openModal("partyModal");
}

export function initParty(controller) {
  game = controller;
  $("hostBtn").addEventListener("click", startHosting);
  $("joinForm").addEventListener("submit", (e) => {
    e.preventDefault();
    join($("joinCode").value);
  });
  $("partyModeToggle").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-party-mode]");
    if (!btn || hosting.phase === "play") return;
    hosting.mode = btn.dataset.partyMode === "versus" ? "versus" : "coop";
    renderHost();
    broadcast(true);
  });
  $("hostRoleToggle").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-role]");
    if (!btn || hosting.phase === "play") return;
    hosting.hostRole = btn.dataset.role === "watch" ? "watch" : "play";
    renderHost();
    broadcast(true);
  });
  $("guestRoleToggle").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-role]");
    if (!btn) return;
    wantedRole = btn.dataset.role === "watch" ? "watch" : "play";
    store.set("uwusnek.partyRole", wantedRole);
    joining.guest?.send({ type: "role", role: wantedRole });
    if (joining.lastState) onHostState(joining.lastState);
  });
  $("partyStartBtn").addEventListener("click", startPartyGame);
  $("newCodeBtn").addEventListener("click", () => {
    if (hosting.phase !== "play") restartWithFreshCode();
  });
  $("stopHostBtn").addEventListener("click", () => {
    stopHosting();
    game.endParty();
    showView("choose");
  });
  $("copyJoinBtn").addEventListener("click", async () => {
    const label = $("copyJoinBtn").querySelector(".copy-label");
    try {
      await navigator.clipboard.writeText($("hostLink").dataset.link);
      label.textContent = "Copied";
    } catch {
      getSelection()?.selectAllChildren($("hostLink"));
      label.textContent = "Selected";
    }
    setTimeout(() => {
      label.textContent = "Copy";
    }, 1500);
  });
  $("leaveBtn").addEventListener("click", () => {
    leave();
    game.endParty();
    showView("choose");
  });
  $("reconnectBtn").addEventListener("click", () => join(joining.code));

  // A new name goes to the host as soon as it is saved.
  document.addEventListener("uwusnek:settings", () => {
    joining.guest?.send({ type: "name", name: myName() });
    if (hosting.host) {
      renderHost();
      broadcast(true);
    }
  });

  // The lobby list redraws now and then so "away" stays true, and the host
  // keeps a beat going while nobody is playing.
  setInterval(() => {
    if (!hosting.host) return;
    if (hosting.phase !== "play") broadcast();
    if (!$("partyHost").hidden) renderHost();
  }, 1000);
  setInterval(() => hosting.host && broadcast(), BEAT_MS);

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    if (wantLock) wakeLock(true);
    // Back from the background with a channel that died meanwhile.
    if (joining.guest?.status === "dropped") join(joining.code);
  });
}

export const partyHooks = {
  onBackToLobby: () => backToLobby(),
  onLeaveParty: () => {
    if (hosting.host) stopHosting();
    if (joining.guest) leave();
    game.endParty();
  },
};
