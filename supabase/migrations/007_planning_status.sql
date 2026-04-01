-- Add 'planning' status to change_requests
alter table change_requests drop constraint if exists change_requests_status_check;
alter table change_requests add constraint change_requests_status_check
  check (status in (
    'open','analyzing','analyzing_mapping','analyzing_propagation','analyzing_scoring',
    'analyzed','planning','planned','executing','review','done','failed'
  ));

-- Add branch_name to change_plans for Plan 6 execution
alter table change_plans add column if not exists branch_name text;
