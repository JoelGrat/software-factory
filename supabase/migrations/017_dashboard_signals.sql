-- supabase/migrations/017_dashboard_signals.sql

-- ── Project event version counter ──────────────────────────────────────────
create table if not exists project_event_counter (
  project_id uuid primary key references projects(id) on delete cascade,
  version    bigint not null default 0
);

-- Upsert function: atomically increments version, inserts row on first call
create or replace function increment_project_event_version(p_project_id uuid)
returns bigint
language plpgsql
as $$
declare
  v bigint;
begin
  insert into project_event_counter (project_id, version)
  values (p_project_id, 1)
  on conflict (project_id) do update
    set version = project_event_counter.version + 1
  returning version into v;
  return v;
end;
$$;

-- ── SSE event replay buffer ────────────────────────────────────────────────
create table if not exists event_history (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  version    bigint not null,
  event_json jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists event_history_project_version_idx
  on event_history(project_id, version desc);

-- ── Analysis result snapshot ───────────────────────────────────────────────
create table if not exists analysis_result_snapshot (
  id               uuid primary key default gen_random_uuid(),
  change_id        uuid not null references change_requests(id) on delete cascade,
  version          bigint not null,
  execution_outcome text not null check (execution_outcome in ('success', 'failure')),
  snapshot_status  text not null default 'pending_enrichment'
    check (snapshot_status in ('pending_enrichment', 'ok', 'enrichment_failed')),
  minimal          boolean not null default true,
  analysis_status  text not null
    check (analysis_status in ('completed', 'failed', 'stalled')),
  stages_completed text[] not null default '{}',
  files_modified   text[] not null default '{}',
  components_affected text[] not null default '{}',
  jaccard_accuracy numeric,
  miss_rate        numeric,
  model_miss       jsonb,
  failure_cause    jsonb,
  duration_ms      bigint,
  completed_at     timestamptz not null default now(),
  unique (change_id)
);

create index if not exists analysis_result_snapshot_change_idx
  on analysis_result_snapshot(change_id);

alter table analysis_result_snapshot enable row level security;
create policy "project owner access" on analysis_result_snapshot for all using (
  exists (
    select 1 from change_requests cr
    join projects p on p.id = cr.project_id
    where cr.id = analysis_result_snapshot.change_id
      and p.owner_id = auth.uid()
  )
);

-- ── Risk scores (precomputed) ─────────────────────────────────────────────
create table if not exists risk_scores (
  component_id uuid not null references system_components(id) on delete cascade,
  project_id   uuid not null references projects(id) on delete cascade,
  risk_score   numeric not null,
  tier         text not null check (tier in ('HIGH', 'MEDIUM')),
  computed_at  timestamptz not null default now(),
  primary key (component_id)
);

create index if not exists risk_scores_project_idx
  on risk_scores(project_id, risk_score desc);

alter table risk_scores enable row level security;
create policy "project owner access" on risk_scores for all using (
  exists (select 1 from projects p where p.id = risk_scores.project_id and p.owner_id = auth.uid())
);

-- ── Action items (precomputed) ────────────────────────────────────────────
create table if not exists action_items (
  id             uuid primary key default gen_random_uuid(),
  project_id     uuid not null references projects(id) on delete cascade,
  tier           int not null,
  priority_score numeric not null,
  source         text not null,
  payload_json   jsonb not null,
  resolved_at    timestamptz
);

create index if not exists action_items_project_idx
  on action_items(project_id, priority_score desc);

alter table action_items enable row level security;
create policy "project owner access" on action_items for all using (
  exists (select 1 from projects p where p.id = action_items.project_id and p.owner_id = auth.uid())
);

-- ── System signal snapshot (one row per project) ──────────────────────────
create table if not exists system_signal_snapshot (
  project_id   uuid primary key references projects(id) on delete cascade,
  payload_json jsonb not null,
  computed_at  timestamptz not null default now()
);

alter table system_signal_snapshot enable row level security;
create policy "project owner access" on system_signal_snapshot for all using (
  exists (select 1 from projects p where p.id = system_signal_snapshot.project_id and p.owner_id = auth.uid())
);

-- ── Extend change_requests ────────────────────────────────────────────────
alter table change_requests
  add column if not exists analysis_status text default 'pending'
    check (analysis_status in ('pending', 'running', 'completed', 'failed', 'stalled')),
  add column if not exists analysis_version int not null default 0,
  add column if not exists client_request_id uuid,
  add column if not exists snapshot_status text,
  add column if not exists last_stage_started_at timestamptz,
  add column if not exists expected_stage_duration_ms bigint;
