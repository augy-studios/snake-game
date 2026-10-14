// POST /api/leaderboard/submit
//   { run_id, client_key, name, game: { seed, settings, ticks, events } }
//   -> { name, score, fruits, length, level, duration_ms,
//        best_score, rank, total, games, total_rank, replay_id }
//
// The game runs in the browser, so what arrives is the game itself: its
// seed, settings and every turn. It is played through js/rules.js, the module
// the page plays by, and the score, length, level and time come from that,
// never from the request. Then the database checks the play time against the
// run's server-side start. That bounds cheating; it does not prevent it.

import { clientKey, endpoint, HttpError, runId } from "../_lib/http.js";
import { cleanName } from "../_lib/names.js";
import { rpc } from "../_lib/supabase.js";
import { CLOCK_SLACK_MS, GRID, RUN_TTL_MS, playThrough, summary } from "../../js/rules.js";
import { REPLAY_VERSION, cleanReplay } from "../../js/replay-format.js";

const REFUSALS = {
  not_found: [404, "That game is not one this browser started."],
  already_submitted: [409, "That game is already on the leaderboard."],
  expired: [410, "That game is more than three hours old."],
  seed_used: [409, "This name already has a game on this seed at these settings. Play a new seed to add another."],
  implausible: [422, "That game does not add up, so it was not added."],
};

const refuse = (reason) => {
  const [status, message] = REFUSALS[reason] ?? [500, "Could not submit."];
  return new HttpError(status, REFUSALS[reason] ? reason : "server", message);
};

// The reason stays in the logs. Telling the caller which check it failed
// would only help tune the next attempt.
function implausible(id, reason, extra = {}) {
  console.warn(`implausible run ${id}: ${reason}`, extra);
  return refuse("implausible");
}

export default endpoint("POST", async ({ body }) => {
  const id = runId(body.run_id);
  const key = clientKey(body.client_key);
  const name = cleanName(body.name);
  const game = body.game ?? {};

  const replay = cleanReplay({
    v: REPLAY_VERSION,
    kind: "solo",
    at: new Date().toISOString(),
    mode: "solo",
    grid: GRID,
    seed: game.seed,
    settings: game.settings,
    players: [name],
    ticks: game.ticks,
    events: game.events,
  });
  if (!replay) throw implausible(id, "bad_game");
  // Solo games have one snake and nothing but its turns. Autoplay, or a
  // watcher's wall or fruit, means it was not played alone by hand.
  if (replay.events.some((e) => e[1] !== 0)) throw implausible(id, "not_by_hand");

  const played = playThrough(replay);
  if (played.error) throw implausible(id, played.error);
  const result = summary(played.state);
  if (!result.over || result.ticks !== replay.ticks) throw implausible(id, "not_finished", { ticks: result.ticks });
  if (result.autoplayed) throw implausible(id, "autoplay");
  if (result.fruits < 1) throw new HttpError(400, "no_fruit", "Eat at least one fruit to go on the leaderboard.");

  // The function repeats the ownership, submitted and expiry checks under a
  // row lock, and holds the game's time against the run's start.
  const [row] =
    (await rpc("uwusnek_submit", {
      p_run_id: id,
      p_client_key: key,
      p_name: name,
      p_score: result.score,
      p_fruits: result.fruits,
      p_length: result.length,
      p_level: result.level,
      p_duration_ms: result.durationMs,
      p_seed: replay.seed,
      p_difficulty: replay.settings.difficulty,
      p_start_level: replay.settings.start_level,
      p_game_seconds: replay.settings.game_seconds,
      p_fruit_seconds: replay.settings.fruit_seconds,
      p_many_apples: replay.settings.many_apples,
      p_replay: replay,
      p_slack_ms: CLOCK_SLACK_MS,
      p_ttl_ms: RUN_TTL_MS,
    })) ?? [];
  if (row?.status === "implausible") throw implausible(id, "too_long", { durationMs: result.durationMs });
  if (row?.status !== "ok") throw refuse(row?.status);

  return {
    name,
    score: result.score,
    fruits: result.fruits,
    length: result.length,
    level: result.level,
    duration_ms: result.durationMs,
    best_score: row.best_score,
    rank: Number(row.rank),
    total: Number(row.total),
    games: row.games,
    total_rank: Number(row.total_rank),
    replay_id: row.replay_id,
  };
});
