-- 006_change_intelligence_schema.sql
-- Replaces all pipeline tables with Change Intelligence schema.
-- projects table is kept; all other old tables are dropped.

-- ── Drop old tables (reverse dependency order) ────────────────────────────────

drop table if exists job_logs             cascade;
drop table if exists agent_plans          cascade;
drop table if exists jobs                 cascade;

drop table if exists vision_logs          cascade;
drop table if exists project_visions      cascade;

drop table if exists case_feedback        cascade;
drop table if exists knowledge_cases      cascade;
drop table if exists resolution_patterns  cascade;
drop table if exists gap_patterns         cascade;
drop table if exists domain_templates     cascade;
drop table if exists completeness_scores  cascade;
drop table if exists ai_usage_log         cascade;
drop table if exists decision_log         cascade;
drop table if exists audit_log            cascade;
drop table if exists risk_acceptances     cascade;
drop table if exists investigation_tasks  cascade;
drop table if exists questions            cascade;
drop table if exists gaps                 cascade;
drop table if exists requirement_relations cascade;
drop table if exists requirement_items    cascade;
drop table if exists requirements         cascade;

-- ── Alter projects ────────────────────────────────────────────────────────────

alter table projects
  drop column if exists setup_mode,
  drop column if exists target_path,
  drop column if exists test_command;

alter table projects
  add column if not exists repo_url    text,
  add column if not exists repo_token  text,
  add column if not exists scan_status text not null default 'pending'
    check (scan_status in ('pending','scanning','ready','failed')),
  add column if not exists scan_error  text,
  add column if not exists lock_version int not null default 0;
