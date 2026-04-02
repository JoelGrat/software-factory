-- 010_scan_progress.sql
-- Add structured progress tracking to projects scan
alter table projects
  add column if not exists scan_progress jsonb not null default '{}';
