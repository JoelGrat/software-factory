-- supabase/migrations/028_change_requests_failed_stage.sql

-- Add failed_stage to change_requests for pipeline retry tracking
alter table change_requests
  add column if not exists failed_stage text;
