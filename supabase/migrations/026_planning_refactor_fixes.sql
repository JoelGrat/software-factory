-- supabase/migrations/026_planning_refactor_fixes.sql

-- 1. RLS on change_specs (matches pattern from other tables)
alter table change_specs enable row level security;
create policy "project owner access" on change_specs for all using (
  exists (
    select 1 from change_requests cr
    join projects on projects.id = cr.project_id
    where cr.id = change_specs.change_id and projects.owner_id = auth.uid()
  )
);

-- 2. Unique constraint on (change_id, version)
alter table change_specs
  add constraint change_specs_change_version_unique unique (change_id, version);

-- 3. Fix drift_ratio type: float → numeric
alter table change_impacts
  alter column drift_ratio type numeric using drift_ratio::numeric;
