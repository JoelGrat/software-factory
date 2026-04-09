-- Migration 019: dashboard signals fix 2
-- Fixes: unique version constraint, ownership guard on increment function,
--        snapshot_status check constraint, partial/covering indexes, bigint analysis_version

-- Critical 1: unique constraint on (project_id, version) in event_history
-- Drop the old standalone index first since the unique constraint creates a better one
drop index if exists event_history_project_version_idx;
alter table event_history
  add constraint event_history_project_version_unique
  unique (project_id, version);

-- Critical 2: ownership guard in increment_project_event_version
create or replace function increment_project_event_version(p_project_id uuid)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v bigint;
begin
  -- Allow service-role (auth.uid() is null) but block cross-tenant authenticated calls
  if auth.uid() is not null and not exists (
    select 1 from projects where id = p_project_id and owner_id = auth.uid()
  ) then
    raise exception 'not authorized' using errcode = 'insufficient_privilege';
  end if;

  insert into project_event_counter (project_id, version)
  values (p_project_id, 1)
  on conflict (project_id) do update
    set version = project_event_counter.version + 1
  returning version into v;
  return v;
end;
$$;

-- Critical 3: check constraint on change_requests.snapshot_status
alter table change_requests
  add constraint change_requests_snapshot_status_check
  check (snapshot_status in ('pending_enrichment', 'ok', 'enrichment_failed'));

-- Important 4: partial index for unresolved action items
create index action_items_unresolved_idx
  on action_items(project_id, priority_score desc)
  where resolved_at is null;

-- Important 5: index on risk_scores.computed_at for staleness queries
create index risk_scores_project_computed_idx
  on risk_scores(project_id, computed_at desc);

-- Important 6: change analysis_version from int to bigint for consistency
alter table change_requests
  alter column analysis_version type bigint;
