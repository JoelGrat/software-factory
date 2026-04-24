-- supabase/migrations/030_preview.sql

-- Env vars per project (values encrypted at rest)
create table project_env_vars (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references projects(id) on delete cascade,
  key         text not null,
  value_enc   text not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (project_id, key)
);

-- Preview config per project (one row, upserted)
create table project_preview_config (
  id               uuid primary key default gen_random_uuid(),
  project_id       uuid not null references projects(id) on delete cascade unique,
  install_command  text not null default 'auto',
  start_command    text not null default 'auto',
  work_dir         text not null default '.',
  health_path      text not null default '/',
  health_text      text,
  port_internal    int  not null default 3000,
  expected_keys    text[] not null default '{}',
  max_memory_mb    int  not null default 1024,
  max_cpu_shares   int  not null default 512,
  updated_at       timestamptz not null default now()
);

-- Preview container instances
create table preview_containers (
  id               uuid primary key default gen_random_uuid(),
  change_id        uuid not null references change_requests(id) on delete cascade,
  project_id       uuid not null references projects(id) on delete cascade,
  container_id     text,
  port             int,
  status           text not null default 'starting'
                   check (status in ('starting','running','stopped','error')),
  startup_log      text not null default '',
  started_at       timestamptz not null default now(),
  last_activity_at timestamptz not null default now(),
  stopped_at       timestamptz,
  error_message    text
);

create index on preview_containers (change_id, started_at desc);
create index on preview_containers (project_id, status);

-- RLS
alter table project_env_vars enable row level security;
alter table project_preview_config enable row level security;
alter table preview_containers enable row level security;

create policy "owner full access on env_vars"
  on project_env_vars for all
  using (project_id in (select id from projects where owner_id = auth.uid()));

create policy "owner full access on preview_config"
  on project_preview_config for all
  using (project_id in (select id from projects where owner_id = auth.uid()));

create policy "owner full access on preview_containers"
  on preview_containers for all
  using (project_id in (select id from projects where owner_id = auth.uid()));
