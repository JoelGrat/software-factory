-- supabase/migrations/027_execution_task_locking.sql

-- 1. Store resolved file list on each task row (projected from plan_json at task projection time)
alter table change_plan_tasks
  add column if not exists files text[] not null default '{}';

-- 2. Run-scoped lock: execution claims a task by stamping its run_id here;
--    reset logic only resets tasks belonging to the current run.
alter table change_plan_tasks
  add column if not exists locked_by_run_id uuid references execution_runs(id);

-- 3. Expand status enum to full task lifecycle
alter table change_plan_tasks
  drop constraint if exists change_plan_tasks_status_check;
alter table change_plan_tasks
  add constraint change_plan_tasks_status_check
  check (status in ('pending', 'in_progress', 'done', 'failed', 'blocked', 'skipped', 'cancelled'));

-- 4. Index for efficient per-run task queries
create index if not exists change_plan_tasks_locked_run_idx
  on change_plan_tasks (locked_by_run_id)
  where locked_by_run_id is not null;
