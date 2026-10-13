// POST /api/replay/create  { replay } -> { id }
//
// Stores a replay in js/replay-format.js's format and returns the id for its
// short link, /r/<id>. Used for games that are not on the leaderboard: a
// game shared before or instead of submitting it, an autoplayed one, or a
// party game. A submitted game gets its replay from submit, verified.
//
// The replay is cleaned and played through js/rules.js like a submission, so
// a stored link always plays, but it is kept unverified: nothing ties it to
// a run, so it may not have been played when or how it says.

import { endpoint, HttpError } from "../_lib/http.js";
import { cleanName } from "../_lib/names.js";
import { rpc } from "../_lib/supabase.js";
import { playThrough } from "../../js/rules.js";
import { cleanReplay } from "../../js/replay-format.js";

const MAX_BYTES = 256 * 1024;

function nameOrNull(value) {
  try {
    return cleanName(value);
  } catch {
    return null;
  }
}

export default endpoint("POST", async ({ body }) => {
  const replay = cleanReplay(body.replay);
  if (!replay) throw new HttpError(400, "bad_replay", "That is not a replay.");
  // Names go through the leaderboard's checks, so a link never shows a word
  // the board would refuse.
  replay.players = replay.players.map((p, i) => nameOrNull(p) ?? `Player ${i + 1}`);

  const played = playThrough(replay);
  if (played.error) throw new HttpError(400, "bad_replay", "That replay does not play.");

  if (new TextEncoder().encode(JSON.stringify(replay)).length > MAX_BYTES) {
    throw new HttpError(413, "too_big", "That game is too long to store. Share the long link instead.");
  }

  const id = await rpc("uwusnek_store_replay", { p_kind: replay.kind, p_verified: false, p_run_id: null, p_body: replay });
  return { id };
});
