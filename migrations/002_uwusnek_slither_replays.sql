-- Snake Game: Slither replays behind the same short links /r/<id>.
-- Paste into the Supabase SQL editor and run once, after 001.
-- Safe to run again: the constraint is dropped if it exists and added back.
--
-- A Slither replay is one life in a world: the world as it stood when the
-- life began, and every input after it (main-site/js/slither-replay.js).
-- It is never verified, since the computer snakes and everyone in the world
-- ran on players' own devices; the API only checks that it plays.

alter table uwusnek_replays drop constraint if exists uwusnek_replays_kind_check;
alter table uwusnek_replays
  add constraint uwusnek_replays_kind_check check (kind in ('solo', 'party', 'slither'));
