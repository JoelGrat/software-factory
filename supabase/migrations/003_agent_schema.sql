-- 003_agent_schema.sql

-- Add target project path to projects
alter table projects
  add column if not exists target_path text,
  add column if not exists test_command text;

-- Jobs: one per requirement run
create table if not exists jobs (
  id                 uuid primary key default gen_random_uuid(),
  project_id         uuid not null references projects(id) on delete cascade,
  requirement_id     uuid not null references requirements(id) on delete cascade,
  status             text not null default 'pending',
  -- pending | plan_loop | awaiting_plan_approval | coding | awaiting_review | done | failed | cancelled
  branch_name        text,
  iteration_count    integer not null default 0,
  error              text,
  created_at         timestamptz not null default now(),
  completed_at       timestamptz
);

-- Plans: one per job (written by planner agent)
create table if not exists agent_plans (
  id               uuid primary key default gen_random_uuid(),
  job_id           uuid not null references jobs(id) on delete cascade,
  tasks            jsonb not null default '[]',
  files_to_create  text[] not null default '{}',
  files_to_modify  text[] not null default '{}',
  test_approach    text not null default '',
  branch_name      text not null default '',
  created_at       timestamptz not null default now()
);

-- Logs: append-only, Realtime-enabled for live execution screen
create table if not exists job_logs (
  id         uuid primary key default gen_random_uuid(),
  job_id     uuid not null references jobs(id) on delete cascade,
  phase      text not null, -- requirements | planning | coding | system
  level      text not null, -- info | warn | error | success
  message    text not null,
  created_at timestamptz not null default now()
);
