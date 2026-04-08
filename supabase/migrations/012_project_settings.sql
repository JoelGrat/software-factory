-- Project-level behavioral settings
alter table projects
  add column if not exists project_settings jsonb not null default '{}';
