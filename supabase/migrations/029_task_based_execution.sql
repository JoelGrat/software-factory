-- supabase/migrations/029_task_based_execution.sql

-- Task dependencies: task IDs that must be 'done' before this task can start
ALTER TABLE change_plan_tasks
  ADD COLUMN IF NOT EXISTS dependencies uuid[] NOT NULL DEFAULT '{}';

-- Lock timing: used for crash recovery (zombie task cleanup)
ALTER TABLE change_plan_tasks
  ADD COLUMN IF NOT EXISTS locked_at timestamptz;

-- Outcome timestamps / diagnostics
ALTER TABLE change_plan_tasks
  ADD COLUMN IF NOT EXISTS completed_at timestamptz;

ALTER TABLE change_plan_tasks
  ADD COLUMN IF NOT EXISTS failure_reason text;

-- Which dependency caused this task to be blocked
ALTER TABLE change_plan_tasks
  ADD COLUMN IF NOT EXISTS blocked_by_task_id uuid REFERENCES change_plan_tasks(id);

-- Index: retrigger graph traversal (find all tasks blocked by a given task)
CREATE INDEX IF NOT EXISTS change_plan_tasks_blocked_by_idx
  ON change_plan_tasks (blocked_by_task_id)
  WHERE blocked_by_task_id IS NOT NULL;

-- Index: crash recovery query (find stuck in_progress tasks by lock time)
CREATE INDEX IF NOT EXISTS change_plan_tasks_locked_at_idx
  ON change_plan_tasks (locked_at)
  WHERE status = 'in_progress';
