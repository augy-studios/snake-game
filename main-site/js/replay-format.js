// The replay format, shared by the page that plays replays and the API that
// stores and checks them. A replay is what happened, not what it scored: the
// seed, the settings and every input, which js/rules.js plays through to get
// everything else. So a replay cannot claim points its moves did not earn.
//
// {
//   v: 1,
//   kind: "solo" | "party",
//   at: ISO time the game was played,
//   mode: "solo" | "coop" | "versus",
//   grid: 40,
//   seed: "K7QX2M",
//   settings: { difficulty, start_level, game_seconds, fruit_seconds },
//   players: ["Augy"],                one name per snake, in seat order
//   ticks: 1834,                      moves the game lasted
//   events: [[t, code, ...], ...]     js/rules.js's events, in tick order
// }

import { GRID, MAX_EVENTS, MAX_SNAKES, MAX_TICKS, MODES, cleanSettings } from "./rules.js";
import { SEED_MAX, cleanSeed } from "./seed.js";

export const REPLAY_VERSION = 1;

// Control characters out, whitespace collapsed, cut to `max` characters.
export function cleanText(value, max) {
  if (typeof value !== "string") return "";
  const text = value.normalize("NFKC").replace(/\p{C}/gu, "").replace(/\s+/gu, " ").trim();
  return Array.from(text).slice(0, max).join("").trim();
}

const isInt = (n, min, max) => Number.isInteger(n) && n >= min && n <= max;

// Arguments each event code takes, and their ranges.
function cleanEvent(e, last, ticks, grid, players) {
  if (!Array.isArray(e) || !isInt(e[0], last, ticks)) return null;
  const [t, code] = e;
  if (code === 0 && e.length === 4 && isInt(e[2], 0, players - 1) && isInt(e[3], 0, 3)) return [t, 0, e[2], e[3]];
  if (code === 1 && e.length === 3 && isInt(e[2], 0, 1)) return [t, 1, e[2]];
  if (code === 2 && e.length === 5 && isInt(e[2], 0, grid - 1) && isInt(e[3], 0, grid - 1) && isInt(e[4], 0, 1)) {
    return [t, 2, e[2], e[3], e[4]];
  }
  if (code === 3 && e.length === 4 && isInt(e[2], 0, grid - 1) && isInt(e[3], 0, grid - 1)) return [t, 3, e[2], e[3]];
  return null;
}

// A replay from anywhere (a link, the API, a party host) made safe to play,
// or null if it is not one. Anything malformed is refused outright rather
// than patched, since a patched input list would be a different game.
export function cleanReplay(raw) {
  if (!raw || typeof raw !== "object" || raw.v !== REPLAY_VERSION) return null;
  const kind = raw.kind === "solo" || raw.kind === "party" ? raw.kind : null;
  const mode = MODES.includes(raw.mode) ? raw.mode : null;
  if (!kind || !mode) return null;
  if (raw.grid !== GRID) return null;

  const seed = cleanSeed(raw.seed);
  if (!seed || seed !== raw.seed || seed.length > SEED_MAX) return null;

  const players = (Array.isArray(raw.players) ? raw.players : []).map((p, i) => cleanText(p, 20) || `Player ${i + 1}`);
  if (players.length < 1 || players.length > MAX_SNAKES) return null;
  // Solo is one snake played alone; a party game is co-op or versus, with
  // one snake or more and anyone else watching.
  if (kind === "solo" && (mode !== "solo" || players.length !== 1)) return null;
  if (kind === "party" && mode === "solo") return null;

  if (!isInt(raw.ticks, 1, MAX_TICKS)) return null;
  if (!Array.isArray(raw.events) || raw.events.length > MAX_EVENTS) return null;
  const events = [];
  let last = 0;
  for (const e of raw.events) {
    const clean = cleanEvent(e, last, raw.ticks, GRID, players.length);
    if (!clean) return null;
    events.push(clean);
    last = clean[0];
  }

  const at = typeof raw.at === "string" && !Number.isNaN(Date.parse(raw.at)) ? new Date(raw.at).toISOString() : null;
  return {
    v: REPLAY_VERSION,
    kind,
    at,
    mode,
    grid: GRID,
    seed,
    settings: cleanSettings(raw.settings),
    players,
    ticks: raw.ticks,
    events,
  };
}

/* ---- The long link ----
   Offline, or when the API will not store it, a replay travels in the link
   itself: the JSON with each event's tick written as the gap since the one
   before, deflated where the browser can, as base64url. "z" or "j" in front
   says which. */

function toBase64Url(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text) {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  try {
    const bin = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

async function through(stream, bytes) {
  const out = new Blob([bytes]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

function deltas(events, sign) {
  let prev = 0;
  return events.map((e) => {
    const t = sign > 0 ? e[0] - prev : e[0] + prev;
    prev = sign > 0 ? e[0] : t;
    return [t, ...e.slice(1)];
  });
}

export async function packReplay(replay) {
  const json = new TextEncoder().encode(JSON.stringify({ ...replay, events: deltas(replay.events, 1) }));
  if (typeof CompressionStream === "function") {
    try {
      return `z${toBase64Url(await through(new CompressionStream("deflate-raw"), json))}`;
    } catch {
      // Fall through to the plain form.
    }
  }
  return `j${toBase64Url(json)}`;
}

export async function unpackReplay(packed) {
  const text = String(packed ?? "");
  const bytes = fromBase64Url(text.slice(1));
  if (!bytes || bytes.length > 512 * 1024) return null;
  try {
    let json = bytes;
    if (text[0] === "z") {
      if (typeof DecompressionStream !== "function") return null;
      json = await through(new DecompressionStream("deflate-raw"), bytes);
    } else if (text[0] !== "j") {
      return null;
    }
    const raw = JSON.parse(new TextDecoder().decode(json));
    if (!Array.isArray(raw?.events)) return null;
    return cleanReplay({ ...raw, events: deltas(raw.events, -1) });
  } catch {
    return null;
  }
}
