-- Add spec_markdown column to agent_plans for storing generated implementation spec
alter table agent_plans add column if not exists spec_markdown text;
