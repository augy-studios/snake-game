-- Snake Game: the "many apples" setting on the leaderboard.
-- Paste into the Supabase SQL editor and run once, after 002, and before
-- deploying the API that sends p_many_apples. Safe to run again.
--
-- A game with many apples goes on the same boards as any other. The setting
-- is kept on each row so the "seed already used at these settings" check
-- tells a seed played with one apple from the same seed played with many.

alter table uwusnek_leaderboard
  add column if not exists many_apples boolean not null default false;

-- The submit function gains a parameter, so the old signature goes and the
-- new one takes its place. Otherwise as in 001.
drop function if exists uwusnek_submit(uuid, text, text, int, int, int, int, int, text, text, int, int, int, jsonb, int, int);

create or replace function uwusnek_submit(
  p_run_id uuid,
  p_client_key text,
  p_name text,
  p_score int,
  p_fruits int,
  p_length int,
  p_level int,
  p_duration_ms int,
  p_seed text,
  p_difficulty text,
  p_start_level int,
  p_game_seconds int,
  p_fruit_seconds int,
  p_many_apples boolean,
  p_replay jsonb,
  p_slack_ms int,
  p_ttl_ms int
)
returns table (
  status text,
  best_score int,
  rank bigint,
  total bigint,
  games int,
  total_rank bigint,
  replay_id text
)
language plpgsql
volatile
as $$
#variable_conflict use_column
declare
  v_run uwusnek_runs%rowtype;
  v_replay text;
  v_best int;
  v_best_at timestamptz;
  v_total bigint;
  v_games int;
begin
  select * into v_run
  from uwusnek_runs r
  where r.id = p_run_id and r.client_key = p_client_key
  for update;

  if not found then
    status := 'not_found';
    return next;
    return;
  end if;
  if v_run.submitted then
    status := 'already_submitted';
    return next;
    return;
  end if;
  if v_run.created_at < now() - make_interval(secs => p_ttl_ms / 1000.0) then
    status := 'expired';
    return next;
    return;
  end if;
  -- A game cannot have lasted longer than the server has known about it. A
  -- page that ran its clock fast to play at ease lands here.
  if p_duration_ms > extract(epoch from (now() - v_run.created_at)) * 1000 + p_slack_ms then
    status := 'implausible';
    return next;
    return;
  end if;
  if exists (
    select 1 from uwusnek_leaderboard l
    where lower(l.name) = lower(p_name)
      and l.seed = p_seed
      and l.difficulty = p_difficulty
      and l.start_level = p_start_level
      and l.game_seconds = p_game_seconds
      and l.fruit_seconds = p_fruit_seconds
      and l.many_apples = p_many_apples
  ) then
    status := 'seed_used';
    return next;
    return;
  end if;

  update uwusnek_runs r set submitted = true where r.id = p_run_id;
  v_replay := uwusnek_store_replay('solo', true, p_run_id, p_replay);
  insert into uwusnek_leaderboard (
    name, score, fruits, length, level, duration_ms, seed, difficulty,
    start_level, game_seconds, fruit_seconds, many_apples, run_id, replay_id
  )
  values (
    p_name, p_score, p_fruits, p_length, p_level, p_duration_ms, p_seed, p_difficulty,
    p_start_level, p_game_seconds, p_fruit_seconds, p_many_apples, p_run_id, v_replay
  );

  select l.score, l.created_at into v_best, v_best_at
  from uwusnek_leaderboard l
  where lower(l.name) = lower(p_name)
  order by l.score desc, l.created_at asc
  limit 1;

  select sum(l.score)::bigint, count(*)::int into v_total, v_games
  from uwusnek_leaderboard l
  where lower(l.name) = lower(p_name);

  status := 'ok';
  best_score := v_best;
  rank := (
    select count(*) + 1
    from uwusnek_leaderboard_best b
    where b.score > v_best or (b.score = v_best and b.created_at < v_best_at)
  );
  total := v_total;
  games := v_games;
  total_rank := (
    select count(*) + 1
    from uwusnek_leaderboard_total t
    where lower(t.name) <> lower(p_name)
      and (
        t.total > v_total
        or (t.total = v_total and t.games < v_games)
        -- This name's total was only just reached, so an equal one got there first.
        or (t.total = v_total and t.games = v_games)
      )
  );
  replay_id := v_replay;
  return next;
end;
$$;

-- Service role only.
revoke all on function uwusnek_submit(uuid, text, text, int, int, int, int, int, text, text, int, int, int, boolean, jsonb, int, int) from public, anon, authenticated;
grant execute on function uwusnek_submit(uuid, text, text, int, int, int, int, int, text, text, int, int, int, boolean, jsonb, int, int) to service_role;
