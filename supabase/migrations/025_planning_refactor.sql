-- supabase/migrations/025_planning_refactor.sql

-- 1. New table: change_specs (stores the human design contract)
create table change_specs (
  id          uuid primary key default gen_random_uuid(),
  change_id   uuid not null references change_requests(id) on delete cascade,
  version     int not null default 1,
  markdown    text,
  structured  jsonb not null,
  created_at  timestamptz not null default now()
);
create index on change_specs (change_id, version desc);

-- 2. Add new columns to change_plans
alter table change_plans
  add column if not exists plan_json        jsonb,
  add column if not exists version          int not null default 1,
  add column if not exists current_stage    text,
  add column if not exists stage_durations  jsonb,
  add column if not exists failed_stage     text,
  add column if not exists planner_version  int not null default 1,
  add column if not exists started_at       timestamptz,
  add column if not exists ended_at         timestamptz;

-- Remove columns that are now derived or relocated
alter table change_plans
  drop column if exists spec_markdown,
  drop column if exists estimated_files;

-- 3. Add projection metadata to change_plan_tasks
alter table change_plan_tasks
  add column if not exists plan_task_id  text,
  add column if not exists phase_id      text,
  add column if not exists plan_version  int;

-- 4. Add failure tracking to change_requests
alter table change_requests
  add column if not exists retryable              boolean,
  add column if not exists failure_diagnostics    jsonb;

-- Remove draft_plan (replaced by change_specs)
alter table change_requests
  drop column if exists draft_plan;

-- 5. Add drift tracking to change_impacts
alter table change_impacts
  add column if not exists direct_seeds  int,
  add column if not exists drift_ratio   float;
