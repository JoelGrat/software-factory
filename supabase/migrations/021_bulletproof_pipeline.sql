-- supabase/migrations/021_bulletproof_pipeline.sql
-- Adds columns for the bulletproof pipeline refactor.
-- pipeline_status is a new column alongside the existing status column.
-- Existing status column is retained for UI/external consumers.

alter table change_requests
  add column if not exists pipeline_run_id uuid,
  add column if not exists input_hash text,
  add column if not exists draft_plan jsonb,
  add column if not exists pipeline_status text,
  add column if not exists failed_phase text,
  add column if not exists phase_timings jsonb;

alter table change_impacts
  add column if not exists traversal_evidence jsonb;

alter table change_plans
  add column if not exists validation_log jsonb,
  add column if not exists plan_quality_score float;
