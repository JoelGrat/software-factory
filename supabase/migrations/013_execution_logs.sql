-- supabase/migrations/013_execution_logs.sql

create table execution_logs (
  id         bigint generated always as identity primary key,
  change_id  uuid not null references change_requests(id) on delete cascade,
  iteration  int,
  level      text not null check (level in ('info', 'success', 'error', 'docker')),
  message    text not null,
  created_at timestamptz not null default now()
);

create index execution_logs_change_id_idx on execution_logs (change_id, id);

alter table execution_logs enable row level security;
create policy "project owner access" on execution_logs for all using (
  exists (
    select 1 from change_requests cr
    join projects on projects.id = cr.project_id
    where cr.id = execution_logs.change_id and projects.owner_id = auth.uid()
  )
);
