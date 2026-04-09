-- Migration 018: Fix issues from 017_dashboard_signals
-- 1. Enable RLS on project_event_counter and event_history
-- 2. Fix wrong primary key on risk_scores
-- 3. Add SECURITY DEFINER + search_path to increment_project_event_version
-- 4. Fix index direction on event_history
-- 5. Remove redundant index on analysis_result_snapshot
-- 6. Add tier check constraint on action_items

-- Critical 1: Missing RLS on project_event_counter and event_history
alter table project_event_counter enable row level security;
create policy "project owner access" on project_event_counter for all using (
  exists (select 1 from projects p where p.id = project_event_counter.project_id and p.owner_id = auth.uid())
);

alter table event_history enable row level security;
create policy "project owner access" on event_history for all using (
  exists (select 1 from projects p where p.id = event_history.project_id and p.owner_id = auth.uid())
);

-- Critical 2: Wrong primary key on risk_scores
alter table risk_scores drop constraint risk_scores_pkey;
alter table risk_scores add primary key (component_id, project_id);

-- Important 3: increment_project_event_version missing SECURITY DEFINER + search_path
create or replace function increment_project_event_version(p_project_id uuid)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v bigint;
begin
  insert into project_event_counter (project_id, version)
  values (p_project_id, 1)
  on conflict (project_id) do update
    set version = project_event_counter.version + 1
  returning version into v;
  return v;
end;
$$;

-- Important 4: Wrong index direction on event_history
drop index if exists event_history_project_version_idx;
create index event_history_project_version_idx
  on event_history(project_id, version asc);

-- Important 5: Remove redundant index on analysis_result_snapshot
drop index if exists analysis_result_snapshot_change_idx;

-- Important 6: Add tier check constraint on action_items
alter table action_items add constraint action_items_tier_check check (tier between 1 and 3);
