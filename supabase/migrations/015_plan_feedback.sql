-- 015_plan_feedback.sql
-- Add draft_plan and impact_feedback jsonb columns to change_plans.
-- Stores the draft projection and derived risk feedback from the planning loop for auditability.
alter table change_plans
  add column if not exists draft_plan jsonb,
  add column if not exists impact_feedback jsonb;
