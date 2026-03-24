-- Enable UUID extension
create extension if not exists "uuid-ossp";

-- Projects
create table projects (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  owner_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

-- Requirements documents
create table requirements (
  id uuid primary key default uuid_generate_v4(),
  project_id uuid not null references projects(id) on delete cascade,
  title text not null,
  raw_input text not null default '',
  status text not null default 'draft'
    check (status in ('draft','analyzing','incomplete','review_required','ready_for_dev','blocked')),
  blocked_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Structured requirement items
create table requirement_items (
  id uuid primary key default uuid_generate_v4(),
  requirement_id uuid not null references requirements(id) on delete cascade,
  type text not null check (type in ('functional','non-functional','constraint','assumption')),
  title text not null,
  description text not null,
  priority text not null check (priority in ('high','medium','low')),
  source_text text,
  nfr_category text check (nfr_category in ('security','performance','auditability')),
  created_at timestamptz not null default now()
);

-- Detected gaps
create table gaps (
  id uuid primary key default uuid_generate_v4(),
  requirement_id uuid not null references requirements(id) on delete cascade,
  item_id uuid references requirement_items(id) on delete set null,
  severity text not null check (severity in ('critical','major','minor')),
  category text not null check (category in ('missing','ambiguous','conflicting','incomplete')),
  description text not null,
  source text not null check (source in ('rule','ai','pattern')),
  rule_id text,
  priority_score integer not null default 0,
  confidence integer not null default 100 check (confidence between 0 and 100),
  question_generated boolean not null default false,
  merged_into uuid references gaps(id) on delete set null,
  resolved_at timestamptz,
  resolution_source text check (resolution_source in ('question_answered','task_resolved','decision_recorded')),
  created_at timestamptz not null default now()
);

-- Clarifying questions
create table questions (
  id uuid primary key default uuid_generate_v4(),
  gap_id uuid not null references gaps(id) on delete cascade,
  requirement_id uuid not null references requirements(id) on delete cascade,
  question_text text not null,
  target_role text not null check (target_role in ('ba','architect','po','dev')),
  status text not null default 'open' check (status in ('open','answered','dismissed')),
  answer text,
  answered_at timestamptz,
  created_at timestamptz not null default now()
);

-- Investigation tasks
create table investigation_tasks (
  id uuid primary key default uuid_generate_v4(),
  requirement_id uuid not null references requirements(id) on delete cascade,
  linked_gap_id uuid references gaps(id) on delete set null,
  title text not null,
  description text not null,
  priority text not null check (priority in ('high','medium','low')),
  status text not null default 'open' check (status in ('open','in-progress','resolved','dismissed')),
  created_at timestamptz not null default now()
);

-- Audit log (append-only)
create table audit_log (
  id uuid primary key default uuid_generate_v4(),
  entity_type text not null,
  entity_id uuid not null,
  action text not null check (action in ('created','updated','deleted','analyzed','scored')),
  actor_id uuid references auth.users(id) on delete set null,
  diff jsonb,
  created_at timestamptz not null default now()
);

-- Decision log
create table decision_log (
  id uuid primary key default uuid_generate_v4(),
  requirement_id uuid not null references requirements(id) on delete cascade,
  related_gap_id uuid references gaps(id) on delete set null,
  related_question_id uuid references questions(id) on delete set null,
  decision text not null check (length(decision) > 0),
  rationale text not null check (length(rationale) > 0),
  decided_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);

-- Completeness scores (versioned)
create table completeness_scores (
  id uuid primary key default uuid_generate_v4(),
  requirement_id uuid not null references requirements(id) on delete cascade,
  overall_score integer not null check (overall_score between 0 and 100),
  completeness integer not null check (completeness between 0 and 100),
  nfr_score integer not null check (nfr_score between 0 and 100),
  confidence integer not null check (confidence between 0 and 100),
  breakdown jsonb not null,
  scored_at timestamptz not null default now()
);

-- Knowledge: gap patterns
create table gap_patterns (
  id uuid primary key default uuid_generate_v4(),
  project_id uuid references projects(id) on delete cascade,
  category text not null check (category in ('missing','ambiguous','conflicting','incomplete')),
  severity text not null check (severity in ('critical','major','minor')),
  description_template text not null,
  occurrence_count integer not null default 1,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- Knowledge: resolution patterns
create table resolution_patterns (
  id uuid primary key default uuid_generate_v4(),
  gap_pattern_id uuid not null references gap_patterns(id) on delete cascade,
  project_id uuid references projects(id) on delete cascade,
  resolution_summary text not null,
  source_decision_id uuid references decision_log(id) on delete set null,
  use_count integer not null default 0,
  created_at timestamptz not null default now()
);

-- Knowledge: domain templates
create table domain_templates (
  id uuid primary key default uuid_generate_v4(),
  project_id uuid references projects(id) on delete cascade,
  domain text not null,
  name text not null,
  requirement_areas jsonb not null,
  created_at timestamptz not null default now()
);

-- Indexes for common queries
create index on gaps(requirement_id);
create index on gaps(resolved_at) where resolved_at is null;
create index on questions(requirement_id);
create index on questions(gap_id);
create index on investigation_tasks(requirement_id);
create index on audit_log(entity_id);
create index on completeness_scores(requirement_id, scored_at desc);
create index on gap_patterns(project_id, category);

-- Row Level Security
alter table projects enable row level security;
alter table requirements enable row level security;
alter table requirement_items enable row level security;
alter table gaps enable row level security;
alter table questions enable row level security;
alter table investigation_tasks enable row level security;
alter table audit_log enable row level security;
alter table decision_log enable row level security;
alter table completeness_scores enable row level security;
alter table gap_patterns enable row level security;
alter table resolution_patterns enable row level security;
alter table domain_templates enable row level security;

-- RLS policies
create policy "owner_all" on projects for all using (owner_id = auth.uid());
create policy "project_member_requirements" on requirements for all
  using (project_id in (select id from projects where owner_id = auth.uid()));
create policy "project_member_items" on requirement_items for all
  using (requirement_id in (
    select r.id from requirements r
    join projects p on p.id = r.project_id
    where p.owner_id = auth.uid()
  ));
create policy "via_requirement" on gaps for all
  using (requirement_id in (
    select r.id from requirements r join projects p on p.id = r.project_id where p.owner_id = auth.uid()
  ));
create policy "via_requirement" on questions for all
  using (requirement_id in (
    select r.id from requirements r join projects p on p.id = r.project_id where p.owner_id = auth.uid()
  ));
create policy "via_requirement" on investigation_tasks for all
  using (requirement_id in (
    select r.id from requirements r join projects p on p.id = r.project_id where p.owner_id = auth.uid()
  ));
create policy "via_project_ownership" on audit_log for all
  using (
    entity_id in (select id from projects where owner_id = auth.uid())
    or entity_id in (
      select r.id from requirements r join projects p on p.id = r.project_id where p.owner_id = auth.uid()
    )
    or entity_id in (
      select g.id from gaps g
      join requirements r on r.id = g.requirement_id
      join projects p on p.id = r.project_id
      where p.owner_id = auth.uid()
    )
    or entity_id in (
      select q.id from questions q
      join requirements r on r.id = q.requirement_id
      join projects p on p.id = r.project_id
      where p.owner_id = auth.uid()
    )
    or entity_id in (
      select t.id from investigation_tasks t
      join requirements r on r.id = t.requirement_id
      join projects p on p.id = r.project_id
      where p.owner_id = auth.uid()
    )
  );
create policy "via_requirement" on decision_log for all
  using (requirement_id in (
    select r.id from requirements r join projects p on p.id = r.project_id where p.owner_id = auth.uid()
  ));
create policy "via_requirement" on completeness_scores for all
  using (requirement_id in (
    select r.id from requirements r join projects p on p.id = r.project_id where p.owner_id = auth.uid()
  ));
create policy "project_scoped" on gap_patterns for all
  using (project_id is null or project_id in (select id from projects where owner_id = auth.uid()));
create policy "project_scoped" on resolution_patterns for all
  using (project_id is null or project_id in (select id from projects where owner_id = auth.uid()));
create policy "project_scoped" on domain_templates for all
  using (project_id is null or project_id in (select id from projects where owner_id = auth.uid()));
