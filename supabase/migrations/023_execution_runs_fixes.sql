-- supabase/migrations/023_execution_runs_fixes.sql
-- Fix issues from 022: remove redundant index, add concurrency guard, add reaper index.

-- 1. Remove the redundant index (unique constraint already indexes run_id, seq)
drop index if exists execution_events_run_id_seq_idx;

-- 2. Partial unique index: only one active run per change at a time
--    When status transitions away from 'running', this index is released.
create unique index execution_runs_one_active_per_change
  on execution_runs (change_id)
  where status = 'running';

-- 3. Partial index for stale-run reaper queries (filters on status = 'running' globally)
create index execution_runs_active_idx
  on execution_runs (started_at)
  where status = 'running';

-- NOTE: Writes to execution_runs and execution_events MUST use the service-role client
-- (admin client, bypasses RLS). The anon/authenticated clients have SELECT-only access.
-- Using the wrong client will result in silent no-ops (RLS blocks DML without error).
