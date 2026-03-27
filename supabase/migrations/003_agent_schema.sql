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
  status             text not null default 'pending'
                       check (status in ('pending','plan_loop','awaiting_plan_approval','coding','awaiting_review','done','failed','cancelled')),
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
  created_at       timestamptz not null default now(),
  unique (job_id)
);

-- Logs: append-only, Realtime-enabled for live execution screen
create table if not exists job_logs (
  id         uuid primary key default gen_random_uuid(),
  job_id     uuid not null references jobs(id) on delete cascade,
  phase      text not null check (phase in ('requirements','planning','coding','system')),
  level      text not null check (level in ('info','warn','error','success')),
  message    text not null,
  created_at timestamptz not null default now()
);

-- Indexes
create index on jobs(project_id);
create index on jobs(requirement_id);
create index on jobs(status) where status not in ('done', 'failed', 'cancelled');
create index on agent_plans(job_id);
create index on job_logs(job_id, created_at desc);

-- Row Level Security
alter table jobs        enable row level security;
alter table agent_plans enable row level security;
alter table job_logs    enable row level security;

-- jobs: owner can access via project ownership
create policy "jobs_owner" on jobs
  using (project_id in (select id from projects where owner_id = auth.uid()));

-- agent_plans: owner can access via job -> project ownership
create policy "agent_plans_owner" on agent_plans
  using (job_id in (select id from jobs where project_id in (select id from projects where owner_id = auth.uid())));

-- job_logs: same chain
create policy "job_logs_owner" on job_logs
  using (job_id in (select id from jobs where project_id in (select id from projects where owner_id = auth.uid())));
