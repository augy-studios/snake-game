-- Snake Game (snek.uwuapps.org): leaderboard and replay schema, in the
-- shared uwuapps Supabase project. Paste into the Supabase SQL editor and run
-- once. Safe to run again: everything is "if not exists" or "or replace".
--
-- Access model: only the Vercel functions in main-site/api touch these
-- tables, with the service role key. There is no Supabase Auth here. RLS is
-- on with no policies, so an anon key reads nothing.
--
-- The game runs in the browser. What the server holds is a run: the moment
-- a game started, by the server's clock, and whether it has been submitted.
-- A submitted game is the seed, the settings and every move; the API plays
-- it through js/rules.js and works the score out itself before calling
-- uwusnek_submit with the result.

-- One run is one game. Created by POST /api/run/start when a game begins.
create table if not exists uwusnek_runs (
  id uuid primary key default gen_random_uuid(),
  client_key text not null,
  submitted boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists uwusnek_runs_created
  on uwusnek_runs (created_at);

-- Shared replays, behind the short links /r/<id>. The body is
-- js/replay-format.js's format: the inputs, never the score. Verified means
-- the server played it through as a leaderboard submission; a replay shared
-- any other way is stored as sent, after the same clean and play through.
create table if not exists uwusnek_replays (
  id text primary key check (id ~ '^[A-Za-z0-9]{8}$'),
  kind text not null check (kind in ('solo', 'party')),
  verified boolean not null default false,
  run_id uuid unique references uwusnek_runs(id) on delete set null,
  body jsonb not null,
  created_at timestamptz not null default now()
);

-- One row per submitted game, with the numbers the server worked out.
create table if not exists uwusnek_leaderboard (
  id bigserial primary key,
  name text not null,
  score int not null check (score >= 0),
  fruits int not null check (fruits >= 0),
  length int not null check (length >= 1),
  level int not null check (level >= 0),
  duration_ms int not null check (duration_ms >= 0),
  seed text not null,
  difficulty text not null check (difficulty in ('easy', 'normal', 'hard')),
  start_level int not null check (start_level >= 0),
  game_seconds int not null default 0 check (game_seconds >= 0),
  fruit_seconds int not null default 0 check (fruit_seconds >= 0),
  run_id uuid not null unique references uwusnek_runs(id),
  replay_id text references uwusnek_replays(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists uwusnek_lb_name
  on uwusnek_leaderboard (lower(name));

create index if not exists uwusnek_lb_name_seed
  on uwusnek_leaderboard (lower(name), seed);

-- The two boards. One row per name, names compared case-insensitively.

-- Each name's best score. The earliest of an equal top score wins, and the
-- casing shown is the one attached to that score.
create or replace view uwusnek_leaderboard_best
with (security_invoker = true) as
select distinct on (lower(name)) name, score, length, level, replay_id, created_at
from uwusnek_leaderboard
order by lower(name), score desc, created_at asc;

-- Every submitted game's score added up. The casing shown is the name's most
-- recent submission. Ties go to fewer games, then to whoever got there
-- first, which is the earlier last_at.
create or replace view uwusnek_leaderboard_total
with (security_invoker = true) as
select
  (array_agg(name order by created_at desc))[1] as name,
  sum(score)::bigint as total,
  count(*)::int as games,
  max(created_at) as last_at
from uwusnek_leaderboard
group by lower(name);

alter table uwusnek_runs enable row level security;
alter table uwusnek_replays enable row level security;
alter table uwusnek_leaderboard enable row level security;

-- A replay stored under a fresh eight character id, which it returns. The
-- alphabet leaves out 0, 1, i, l, o and their capitals, so a link read
-- aloud is typed back right. random() is fine here: an id is a name, not a
-- secret.
create or replace function uwusnek_store_replay(
  p_kind text,
  p_verified boolean,
  p_run_id uuid,
  p_body jsonb
)
returns text
language plpgsql
volatile
as $$
declare
  v_alphabet constant text := '23456789abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ';
  v_id text;
begin
  for attempt in 1..5 loop
    v_id := '';
    for i in 1..8 loop
      v_id := v_id || substr(v_alphabet, 1 + floor(random() * length(v_alphabet))::int, 1);
    end loop;
    begin
      insert into uwusnek_replays (id, kind, verified, run_id, body)
      values (v_id, p_kind, p_verified, p_run_id, p_body);
      return v_id;
    exception when unique_violation then
      -- The id was taken, or this run already has a replay.
      if p_run_id is not null and exists (select 1 from uwusnek_replays r where r.run_id = p_run_id) then
        return (select r.id from uwusnek_replays r where r.run_id = p_run_id);
      end if;
    end;
  end loop;
  raise exception 'could not find a free replay id';
end;
$$;

-- Submits a finished game under a name, with numbers the API worked out by
-- playing the game through. Repeats the checks that depend on the run row
-- under a lock, so two submits at once cannot both go through. The slack
-- and time to live come from api/leaderboard/submit.js, so they are set in
-- one place.
--
-- Refuses, by status:
--   not_found          no such run for this browser
--   already_submitted  this run is on the board already
--   expired            the run is older than its time to live
--   implausible        the game lasted longer than the server has known about it
--   seed_used          this name already has this seed, at these settings, on
--                      the board: a seed played again is a game practised
--
-- Returns the name's standing on both boards, and the verified replay's id.
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
  ) then
    status := 'seed_used';
    return next;
    return;
  end if;

  update uwusnek_runs r set submitted = true where r.id = p_run_id;
  v_replay := uwusnek_store_replay('solo', true, p_run_id, p_replay);
  insert into uwusnek_leaderboard (
    name, score, fruits, length, level, duration_ms, seed, difficulty,
    start_level, game_seconds, fruit_seconds, run_id, replay_id
  )
  values (
    p_name, p_score, p_fruits, p_length, p_level, p_duration_ms, p_seed, p_difficulty,
    p_start_level, p_game_seconds, p_fruit_seconds, p_run_id, v_replay
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

-- Housekeeping, called now and then by /api/run/start: runs nobody
-- submitted that are past any use.
create or replace function uwusnek_prune()
returns void
language sql
volatile
as $$
  delete from uwusnek_runs r
  where r.created_at < now() - interval '1 day'
    and not r.submitted
    and not exists (select 1 from uwusnek_leaderboard l where l.run_id = r.id);
$$;

-- Service role only.
revoke all on function uwusnek_store_replay(text, boolean, uuid, jsonb) from public, anon, authenticated;
revoke all on function uwusnek_submit(uuid, text, text, int, int, int, int, int, text, text, int, int, int, jsonb, int, int) from public, anon, authenticated;
revoke all on function uwusnek_prune() from public, anon, authenticated;
grant execute on function uwusnek_store_replay(text, boolean, uuid, jsonb) to service_role;
grant execute on function uwusnek_submit(uuid, text, text, int, int, int, int, int, text, text, int, int, int, jsonb, int, int) to service_role;
grant execute on function uwusnek_prune() to service_role;
