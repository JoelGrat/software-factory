-- Add reviewer feedback field to change_requests.
-- Populated from the review page when an execution is rejected.
-- Included in the next execution's AI prompt so the model knows what to fix.
alter table change_requests
  add column if not exists review_feedback text;
