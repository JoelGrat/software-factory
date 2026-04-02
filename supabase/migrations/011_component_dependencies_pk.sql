-- Add primary key to component_dependencies so upsert works reliably in PostgREST
alter table component_dependencies
  add column if not exists id uuid not null default gen_random_uuid();

-- Make it the primary key (only if not already)
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'component_dependencies'::regclass
      and contype = 'p'
  ) then
    alter table component_dependencies add primary key (id);
  end if;
end $$;
