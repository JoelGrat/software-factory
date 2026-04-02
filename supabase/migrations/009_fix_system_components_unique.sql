-- 009_fix_system_components_unique.sql
-- Add missing unique constraint that scanner upsert depends on
alter table system_components
  add constraint system_components_project_name_key unique (project_id, name);
