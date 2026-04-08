-- supabase/migrations/014_new_file_task.sql
-- Add new_file_path to change_plan_tasks.
-- When non-null, this task creates a brand-new file rather than modifying an existing one.
alter table change_plan_tasks
  add column if not exists new_file_path text;
