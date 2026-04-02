-- supabase/migrations/008_execution.sql

-- execution_trace: per-task, per-iteration observability record
create table execution_trace (
  id             uuid primary key default gen_random_uuid(),
  change_id      uuid not null references change_requests(id) on delete cascade,
  iteration      int not null,
  task_id        uuid not null references change_plan_tasks(id) on delete cascade,
  context_mode   text not null check (context_mode in ('symbol', 'multi-symbol', 'file')),
  input_hash     text not null,
  output_hash    text,
  strategy_used  text not null,
  failure_type   text check (failure_type in ('syntax','type','runtime','test','timeout')),
  confidence     int,
  created_at     timestamptz not null default now()
);

alter table execution_trace enable row level security;
create policy "project owner access" on execution_trace for all using (
  exists (
    select 1 from change_requests cr
    join projects on projects.id = cr.project_id
    where cr.id = execution_trace.change_id and projects.owner_id = auth.uid()
  )
);

-- extend execution_snapshots with scope tracking
alter table execution_snapshots
  add column if not exists planned_files    text[] not null default '{}',
  add column if not exists propagated_files text[] not null default '{}',
  add column if not exists plan_divergence  boolean not null default false,
  add column if not exists partial_success  boolean not null default false;

-- extend change_plan_tasks status to include 'failed'
alter table change_plan_tasks drop constraint if exists change_plan_tasks_status_check;
alter table change_plan_tasks add constraint change_plan_tasks_status_check
  check (status in ('pending', 'done', 'failed'));

alter table change_plan_tasks
  add column if not exists failure_type text check (failure_type in ('syntax','type','runtime','test','timeout')),
  add column if not exists last_error   text;
