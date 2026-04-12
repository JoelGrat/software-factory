-- supabase/migrations/022_execution_runs_events.sql

-- execution_runs: one row per execution attempt of a change
create table execution_runs (
  id                       uuid primary key default gen_random_uuid(),
  change_id                uuid not null references change_requests(id) on delete cascade,
  status                   text not null default 'running'
                           check (status in ('running','success','wip','budget_exceeded','blocked','cancelled')),
  cancellation_requested   boolean not null default false,
  summary                  jsonb,
  last_heartbeat_at        timestamptz,
  started_at               timestamptz not null default now(),
  ended_at                 timestamptz
);

create index on execution_runs (change_id, started_at desc);

-- execution_events: append-only event log
create table execution_events (
  id             uuid primary key default gen_random_uuid(),
  run_id         uuid not null references execution_runs(id) on delete cascade,
  change_id      uuid not null references change_requests(id) on delete cascade,
  seq            bigint not null,
  iteration      int not null default 0,
  event_type     text not null,
  phase          text,
  schema_version int not null default 1,
  payload        jsonb not null default '{}',
  created_at     timestamptz not null default now(),

  unique (run_id, seq)
);

create index on execution_events (run_id, seq);
create index on execution_events (change_id, run_id, created_at);

-- RLS: users can read events for their own changes
alter table execution_runs enable row level security;
alter table execution_events enable row level security;

create policy "users read own runs"
  on execution_runs for select
  using (
    change_id in (
      select cr.id from change_requests cr
      join projects p on p.id = cr.project_id
      where p.owner_id = auth.uid()
    )
  );

create policy "users read own events"
  on execution_events for select
  using (
    change_id in (
      select cr.id from change_requests cr
      join projects p on p.id = cr.project_id
      where p.owner_id = auth.uid()
    )
  );
