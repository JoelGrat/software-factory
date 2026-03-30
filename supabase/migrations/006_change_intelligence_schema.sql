-- 006_change_intelligence_schema.sql
-- Replaces all pipeline tables with Change Intelligence schema.
-- projects table is kept; all other old tables are dropped.

-- ── Drop old tables (reverse dependency order) ────────────────────────────────

drop table if exists job_logs             cascade;
drop table if exists agent_plans          cascade;
drop table if exists jobs                 cascade;

drop table if exists vision_logs          cascade;
drop table if exists project_visions      cascade;

drop table if exists case_feedback        cascade;
drop table if exists knowledge_cases      cascade;
drop table if exists resolution_patterns  cascade;
drop table if exists gap_patterns         cascade;
drop table if exists domain_templates     cascade;
drop table if exists completeness_scores  cascade;
drop table if exists ai_usage_log         cascade;
drop table if exists decision_log         cascade;
drop table if exists audit_log            cascade;
drop table if exists risk_acceptances     cascade;
drop table if exists investigation_tasks  cascade;
drop table if exists questions            cascade;
drop table if exists gaps                 cascade;
drop table if exists requirement_relations cascade;
drop table if exists requirement_items    cascade;
drop table if exists requirements         cascade;

-- ── Alter projects ────────────────────────────────────────────────────────────

alter table projects
  drop column if exists setup_mode,
  drop column if exists target_path,
  drop column if exists test_command;

alter table projects
  add column if not exists repo_url    text,
  add column if not exists repo_token  text,
  add column if not exists scan_status text not null default 'pending'
    check (scan_status in ('pending','scanning','ready','failed')),
  add column if not exists scan_error  text,
  add column if not exists lock_version int not null default 0;

-- ── Canonical file registry ───────────────────────────────────────────────────

create table files (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  path       text not null,
  hash       text,
  unique(project_id, path)
);

alter table files enable row level security;
create policy "project owner access" on files for all using (
  exists (select 1 from projects where projects.id = files.project_id and projects.owner_id = auth.uid())
);

create index files_project_path_idx on files(project_id, path);

-- ── System model ──────────────────────────────────────────────────────────────

create table system_components (
  id                 uuid primary key default gen_random_uuid(),
  project_id         uuid not null references projects(id) on delete cascade,
  name               text not null,
  type               text not null check (type in ('service','module','api','db','ui')),
  exposed_interfaces text[] not null default '{}',
  status             text not null default 'stable' check (status in ('stable','unstable')),
  is_anchored        boolean not null default false,
  scan_count         int not null default 0,
  last_updated       timestamptz not null default now(),
  deleted_at         timestamptz
);

alter table system_components enable row level security;
create policy "project owner access" on system_components for all using (
  exists (select 1 from projects where projects.id = system_components.project_id and projects.owner_id = auth.uid())
);

create index system_components_project_idx on system_components(project_id);

-- component_assignment replaces system_component_files
create table component_assignment (
  file_id              uuid not null references files(id) on delete cascade,
  component_id         uuid references system_components(id) on delete set null,
  confidence           int not null default 0 check (confidence between 0 and 100),
  is_primary           boolean not null default true,
  status               text not null default 'assigned' check (status in ('assigned','unassigned')),
  reassignment_count   int not null default 0,
  last_validated_at    timestamptz not null default now(),
  last_moved_at        timestamptz not null default now()
);

alter table component_assignment enable row level security;
create policy "project owner access" on component_assignment for all using (
  exists (
    select 1 from files
    join projects on projects.id = files.project_id
    where files.id = component_assignment.file_id and projects.owner_id = auth.uid()
  )
);

-- Only one primary owner per file
create unique index component_assignment_primary_idx
  on component_assignment(file_id) where is_primary = true;

create table component_dependencies (
  from_id    uuid not null references system_components(id) on delete cascade,
  to_id      uuid not null references system_components(id) on delete cascade,
  type       text not null check (type in ('sync','async','data','api')),
  deleted_at timestamptz,
  unique(from_id, to_id)
);

alter table component_dependencies enable row level security;
create policy "project owner access" on component_dependencies for all using (
  exists (
    select 1 from system_components sc
    join projects on projects.id = sc.project_id
    where sc.id = component_dependencies.from_id and projects.owner_id = auth.uid()
  )
);

create index component_dependencies_from_idx on component_dependencies(from_id);
create index component_dependencies_to_idx   on component_dependencies(to_id);

create table system_component_versions (
  id           uuid primary key default gen_random_uuid(),
  component_id uuid not null references system_components(id) on delete cascade,
  version      int not null,
  snapshot     jsonb not null,
  created_at   timestamptz not null default now()
);

alter table system_component_versions enable row level security;
create policy "project owner access" on system_component_versions for all using (
  exists (
    select 1 from system_components sc
    join projects on projects.id = sc.project_id
    where sc.id = system_component_versions.component_id and projects.owner_id = auth.uid()
  )
);

create table component_tests (
  id           uuid primary key default gen_random_uuid(),
  component_id uuid not null references system_components(id) on delete cascade,
  test_path    text not null,
  unique(component_id, test_path)
);

alter table component_tests enable row level security;
create policy "project owner access" on component_tests for all using (
  exists (
    select 1 from system_components sc
    join projects on projects.id = sc.project_id
    where sc.id = component_tests.component_id and projects.owner_id = auth.uid()
  )
);

create table test_coverage_map (
  test_path text not null,
  file_id   uuid not null references files(id) on delete cascade,
  unique(test_path, file_id)
);

alter table test_coverage_map enable row level security;
create policy "project owner access" on test_coverage_map for all using (
  exists (
    select 1 from files
    join projects on projects.id = files.project_id
    where files.id = test_coverage_map.file_id and projects.owner_id = auth.uid()
  )
);

create table component_graph_edges (
  from_file_id uuid not null references files(id) on delete cascade,
  to_file_id   uuid not null references files(id) on delete cascade,
  project_id   uuid not null references projects(id) on delete cascade,
  edge_type    text not null check (
    edge_type in ('static','re-export','dynamic-static-string','dynamic-template','dynamic-computed')
  ),
  unique(from_file_id, to_file_id)
);

alter table component_graph_edges enable row level security;
create policy "project owner access" on component_graph_edges for all using (
  exists (select 1 from projects where projects.id = component_graph_edges.project_id and projects.owner_id = auth.uid())
);

create index component_graph_edges_from_idx on component_graph_edges(from_file_id);
create index component_graph_edges_to_idx   on component_graph_edges(to_file_id);

create table component_evolution_signals (
  id                   uuid primary key default gen_random_uuid(),
  component_id         uuid not null references system_components(id) on delete cascade,
  type                 text not null check (type in ('split','merge')),
  target_component_id  uuid references system_components(id) on delete set null,
  confidence           int not null check (confidence between 0 and 100),
  created_at           timestamptz not null default now(),
  expires_at           timestamptz not null default (now() + interval '30 days'),
  unique(component_id, type, target_component_id)
);

alter table component_evolution_signals enable row level security;
create policy "project owner access" on component_evolution_signals for all using (
  exists (
    select 1 from system_components sc
    join projects on projects.id = sc.project_id
    where sc.id = component_evolution_signals.component_id and projects.owner_id = auth.uid()
  )
);

-- ── Change layer ──────────────────────────────────────────────────────────────

create table change_requests (
  id                   uuid primary key default gen_random_uuid(),
  project_id           uuid not null references projects(id) on delete cascade,
  title                text not null,
  intent               text not null,
  type                 text not null check (type in ('bug','feature','refactor','hotfix')),
  priority             text not null default 'medium' check (priority in ('low','medium','high')),
  status               text not null default 'open' check (
    status in (
      'open','analyzing','analyzing_mapping','analyzing_propagation','analyzing_scoring',
      'analyzed','planned','executing','review','done','failed'
    )
  ),
  risk_level           text check (risk_level in ('low','medium','high')),
  confidence_score     int check (confidence_score between 0 and 100),
  confidence_breakdown jsonb,
  analysis_quality     text check (analysis_quality in ('high','medium','low')),
  lock_version         int not null default 0,
  execution_group      text,
  created_by           uuid references auth.users(id) on delete set null,
  triggered_by         text not null default 'user' check (triggered_by in ('user','system','production_event')),
  tags                 text[] not null default '{}',
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

alter table change_requests enable row level security;
create policy "project owner access" on change_requests for all using (
  exists (select 1 from projects where projects.id = change_requests.project_id and projects.owner_id = auth.uid())
);

create index change_requests_project_status_idx on change_requests(project_id, status);

create table change_request_components (
  change_id    uuid not null references change_requests(id) on delete cascade,
  component_id uuid not null references system_components(id) on delete cascade,
  unique(change_id, component_id)
);

alter table change_request_components enable row level security;
create policy "project owner access" on change_request_components for all using (
  exists (
    select 1 from change_requests cr
    join projects on projects.id = cr.project_id
    where cr.id = change_request_components.change_id and projects.owner_id = auth.uid()
  )
);

create index change_request_components_component_idx on change_request_components(component_id);

create table change_request_files (
  change_id uuid not null references change_requests(id) on delete cascade,
  file_id   uuid not null references files(id) on delete cascade,
  unique(change_id, file_id)
);

alter table change_request_files enable row level security;
create policy "project owner access" on change_request_files for all using (
  exists (
    select 1 from change_requests cr
    join projects on projects.id = cr.project_id
    where cr.id = change_request_files.change_id and projects.owner_id = auth.uid()
  )
);

create table change_risk_factors (
  id        uuid primary key default gen_random_uuid(),
  change_id uuid not null references change_requests(id) on delete cascade,
  factor    text not null,
  weight    int not null
);

alter table change_risk_factors enable row level security;
create policy "project owner access" on change_risk_factors for all using (
  exists (
    select 1 from change_requests cr
    join projects on projects.id = cr.project_id
    where cr.id = change_risk_factors.change_id and projects.owner_id = auth.uid()
  )
);

create table change_decisions (
  id              uuid primary key default gen_random_uuid(),
  change_id       uuid not null references change_requests(id) on delete cascade,
  stage           text not null check (stage in ('analysis','planning','execution')),
  decision_type   text not null,
  rationale       text,
  input_snapshot  jsonb,
  output_snapshot jsonb,
  created_at      timestamptz not null default now()
);

alter table change_decisions enable row level security;
create policy "project owner access" on change_decisions for all using (
  exists (
    select 1 from change_requests cr
    join projects on projects.id = cr.project_id
    where cr.id = change_decisions.change_id and projects.owner_id = auth.uid()
  )
);

create table change_system_snapshot_components (
  change_id            uuid not null references change_requests(id) on delete cascade,
  component_version_id uuid not null references system_component_versions(id) on delete cascade,
  unique(change_id, component_version_id)
);

alter table change_system_snapshot_components enable row level security;
create policy "project owner access" on change_system_snapshot_components for all using (
  exists (
    select 1 from change_requests cr
    join projects on projects.id = cr.project_id
    where cr.id = change_system_snapshot_components.change_id and projects.owner_id = auth.uid()
  )
);

create table change_impacts (
  id                   uuid primary key default gen_random_uuid(),
  change_id            uuid not null references change_requests(id) on delete cascade,
  risk_score           numeric not null default 0,
  blast_radius         numeric not null default 0,
  primary_risk_factor  text,
  analysis_quality     text not null default 'high' check (analysis_quality in ('high','medium','low')),
  requires_migration   boolean not null default false,
  requires_data_change boolean not null default false
);

alter table change_impacts enable row level security;
create policy "project owner access" on change_impacts for all using (
  exists (
    select 1 from change_requests cr
    join projects on projects.id = cr.project_id
    where cr.id = change_impacts.change_id and projects.owner_id = auth.uid()
  )
);

create table change_impact_components (
  impact_id     uuid not null references change_impacts(id) on delete cascade,
  component_id  uuid not null references system_components(id) on delete cascade,
  impact_weight numeric not null default 0,
  source        text not null check (source in ('directly_mapped','via_dependency','via_file')),
  source_detail text,
  unique(impact_id, component_id)
);

alter table change_impact_components enable row level security;
create policy "project owner access" on change_impact_components for all using (
  exists (
    select 1 from change_impacts ci
    join change_requests cr on cr.id = ci.change_id
    join projects on projects.id = cr.project_id
    where ci.id = change_impact_components.impact_id and projects.owner_id = auth.uid()
  )
);

create index change_impact_components_component_idx on change_impact_components(component_id);

create table change_impact_files (
  impact_id uuid not null references change_impacts(id) on delete cascade,
  file_id   uuid not null references files(id) on delete cascade,
  unique(impact_id, file_id)
);

alter table change_impact_files enable row level security;
create policy "project owner access" on change_impact_files for all using (
  exists (
    select 1 from change_impacts ci
    join change_requests cr on cr.id = ci.change_id
    join projects on projects.id = cr.project_id
    where ci.id = change_impact_files.impact_id and projects.owner_id = auth.uid()
  )
);

create table change_plans (
  id              uuid primary key default gen_random_uuid(),
  change_id       uuid not null references change_requests(id) on delete cascade,
  status          text not null default 'draft' check (status in ('draft','approved','rejected')),
  spec_markdown   text,
  estimated_tasks int,
  estimated_files int,
  created_at      timestamptz not null default now(),
  approved_at     timestamptz
);

alter table change_plans enable row level security;
create policy "project owner access" on change_plans for all using (
  exists (
    select 1 from change_requests cr
    join projects on projects.id = cr.project_id
    where cr.id = change_plans.change_id and projects.owner_id = auth.uid()
  )
);

create table change_plan_tasks (
  id           uuid primary key default gen_random_uuid(),
  plan_id      uuid not null references change_plans(id) on delete cascade,
  component_id uuid references system_components(id) on delete set null,
  description  text not null,
  order_index  int not null default 0,
  status       text not null default 'pending' check (status in ('pending','done'))
);

alter table change_plan_tasks enable row level security;
create policy "project owner access" on change_plan_tasks for all using (
  exists (
    select 1 from change_plans cp
    join change_requests cr on cr.id = cp.change_id
    join projects on projects.id = cr.project_id
    where cp.id = change_plan_tasks.plan_id and projects.owner_id = auth.uid()
  )
);
