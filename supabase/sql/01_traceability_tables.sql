-- Körs i Supabase SQL editor.
--
-- Nya tabeller för spårbarhet:
--   scan_history    - 90 dagars append-only historik per KOF (inga chaufförsnamn, inga bilder)
--   audit_log       - 90 dagars logg över varje manuell mutation
--   split_decisions - 90 dagars AI-vs-människa-splitbeslut per ark (promptkvalitet)

-- 90-day append-only per-KOF history (one batch of rows per committed scan;
-- a KOF re-scanned another day = new rows). No driver names, no images.
create table public.scan_history (
  id          bigint generated always as identity primary key,
  kof         text not null,
  route       text not null,
  store_name  text,
  pall        text,
  bur         text,
  hlv         text,
  units       integer not null default 0,
  confidence  text,                -- 'high' | 'medium' | 'low' (från Opus, per KOF)
  sort_order  integer,
  device_id   text,
  scanned_at  timestamptz not null default now()
);
create index scan_history_kof_time_idx on public.scan_history (kof, scanned_at desc);
create index scan_history_time_idx     on public.scan_history (scanned_at);

-- 90-day audit of every manual mutation.
create table public.audit_log (
  id          bigint generated always as identity primary key,
  action      text not null,       -- 'route_change' | 'split_here' | 'review_move'
                                   -- | 'edit_kof' | 'delete_kof' | 'delete_route' | 'clear_all'
  kof         text,                -- null för rutt-/dataset-nivå
  route       text,
  old_value   text,
  new_value   text,
  device_id   text,
  occurred_at timestamptz not null default now()
);
create index audit_log_time_idx on public.audit_log (occurred_at);
create index audit_log_kof_idx  on public.audit_log (kof) where kof is not null;

-- 90-day AI-vs-human split decision per sheet (prompt-quality measurement).
create table public.split_decisions (
  id                   bigint generated always as identity primary key,
  route                text,               -- routeNumber från arket
  entry_count          integer not null,
  opus_split_index     integer,            -- null = Opus såg ingen S-rutt
  judge_split_index    integer,            -- null = judgen såg ingen / failade
  proposed_split_index integer,            -- förvalet människan fick se
  final_split_index    integer,            -- index för första S-posten vid commit; null = ingen S-rutt
  human_changed        boolean not null,   -- final skiljer sig från förslaget
  moved_kofs           integer not null default 0,  -- antal per-KOF-flytt i granskningen
  device_id            text,
  scanned_at           timestamptz not null default now()
);
create index split_decisions_time_idx on public.split_decisions (scanned_at);
