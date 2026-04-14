-- 024_pinned_action_items.sql
-- Add pinned flag so system-generated action items survive the compute-job replacement cycle.
-- Pinned items are never deleted by the background job; they must be explicitly resolved.

alter table action_items
  add column if not exists pinned boolean not null default false;
