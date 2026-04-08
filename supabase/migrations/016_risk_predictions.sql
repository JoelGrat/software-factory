-- 016_risk_predictions.sql
-- Log predicted risk at planning time and actual outcomes at approval/failure.
-- Used to calibrate risk weights over time.
create table if not exists risk_predictions (
  id                        uuid primary key default gen_random_uuid(),
  change_id                 uuid not null references change_requests(id) on delete cascade,
  predicted_risk_level      text not null,
  predicted_uncertainty     numeric not null,
  new_file_count            int not null default 0,
  new_file_in_critical_domain boolean not null default false,
  new_edges_created         numeric not null default 0,
  -- outcome written when change is approved, rejected, or rolled back
  outcome                   text,          -- 'approved' | 'rejected' | 'rolled_back'
  had_test_failures         boolean,
  had_execution_errors      boolean,
  created_at                timestamptz not null default now(),
  resolved_at               timestamptz
);

alter table risk_predictions enable row level security;
create policy "project owner access" on risk_predictions for all using (
  exists (
    select 1 from change_requests cr
    join projects p on p.id = cr.project_id
    where cr.id = risk_predictions.change_id
      and p.owner_id = auth.uid()
  )
);

create index risk_predictions_change_idx on risk_predictions(change_id);
