-- Migration 020: Add awaiting_approval status to change_requests
-- This status is set by the plan generator when risk policy = 'approval',
-- meaning planning is complete but execution requires explicit user approval.

alter table change_requests drop constraint if exists change_requests_status_check;
alter table change_requests add constraint change_requests_status_check
  check (status in (
    'open','analyzing','analyzing_mapping','analyzing_propagation','analyzing_scoring',
    'analyzed','planning','planned','awaiting_approval','executing','review','done','failed'
  ));
