// POST /api/replay/create  { replay } -> { id }
//
// Stores a replay and returns the id for its short link, /r/<id>.
//
// Classic (js/replay-format.js): a game that is not on the leaderboard, a
// game shared before or instead of submitting it, an autoplayed one, or a
// party game. A submitted game gets its replay from submit, verified.
//
// Slither (js/slither-replay.js): one life in a world. It carries the world
// as it stood when the life began, so it is larger, and it is only ever
// shared this way. Run migrations/002 first.
//
// Either is cleaned and played through its rules, so a stored link always
// plays, and kept unverified: nothing ties it to a run, so it may not have
// been played when or how it says.

import { endpoint, HttpError } from "../_lib/http.js";
import { cleanName, profane } from "../_lib/names.js";
import { rpc } from "../_lib/supabase.js";
import { playThrough } from "../../js/rules.js";
import { cleanReplay } from "../../js/replay-format.js";
import { cleanSlitherReplay, playSlitherThrough } from "../../js/slither-replay.js";

const MAX_BYTES = 256 * 1024;
const MAX_SLITHER_BYTES = 1024 * 1024;

function nameOrNull(value) {
  try {
    return cleanName(value);
  } catch {
    return null;
  }
}

// Every name in a Slither replay through the leaderboard's checks: the
// player's, and each snake's and player's in the world it starts from.
function cleanSlitherNames(replay) {
  const fix = (n, fallback) => (n && !profane(n) ? nameOrNull(n) ?? fallback : fallback);
  replay.name = fix(replay.name, "Player");
  for (const e of replay.events) if (e[1] === 2) e[3] = fix(e[3], "Player");
  const state = replay.start.state;
  if (state) {
    for (const p of Object.values(state.players)) p.name = fix(p.name, "Player");
    for (const s of state.snakes) s.name = fix(s.name, "Snake");
  }
}

function slither(raw) {
  const replay = cleanSlitherReplay(raw);
  if (!replay) throw new HttpError(400, "bad_replay", "That is not a replay.");
  cleanSlitherNames(replay);
  if (new TextEncoder().encode(JSON.stringify(replay)).length > MAX_SLITHER_BYTES) {
    throw new HttpError(413, "too_big", "That game is too long to share.");
  }
  try {
    playSlitherThrough(replay);
  } catch {
    throw new HttpError(400, "bad_replay", "That replay does not play.");
  }
  return replay;
}

function classic(raw) {
  const replay = cleanReplay(raw);
  if (!replay) throw new HttpError(400, "bad_replay", "That is not a replay.");
  // Names go through the leaderboard's checks, so a link never shows a word
  // the board would refuse.
  replay.players = replay.players.map((p, i) => nameOrNull(p) ?? `Player ${i + 1}`);
  const played = playThrough(replay);
  if (played.error) throw new HttpError(400, "bad_replay", "That replay does not play.");
  if (new TextEncoder().encode(JSON.stringify(replay)).length > MAX_BYTES) {
    throw new HttpError(413, "too_big", "That game is too long to store. Share the long link instead.");
  }
  return replay;
}

export default endpoint("POST", async ({ body }) => {
  const isSlither = body.replay?.kind === "slither";
  const replay = isSlither ? slither(body.replay) : classic(body.replay);
  const id = await rpc("uwusnek_store_replay", { p_kind: replay.kind, p_verified: false, p_run_id: null, p_body: replay });
  return { id };
});
