-- supabase/migrations/004_vision_schema.sql

-- Track project creation mode
alter table projects
  add column if not exists setup_mode text not null default 'scratch'
    check (setup_mode in ('scratch', 'imported'));

-- Vision content + generation status (one per project)
create table if not exists project_visions (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null references projects(id) on delete cascade,
  mode            text not null default 'free_form'
                    check (mode in ('free_form', 'structured')),
  free_form_text  text not null default '',
  goal            text not null default '',
  tech_stack      text not null default '',
  target_users    text not null default '',
  key_features    text not null default '',
  constraints     text not null default '',
  status          text not null default 'draft'
                    check (status in ('draft', 'generating', 'done', 'failed')),
  error           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (project_id)
);

-- Append-only log feed (Realtime)
create table if not exists vision_logs (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  phase      text not null check (phase in ('parsing', 'generating', 'system')),
  level      text not null check (level in ('info', 'warn', 'error', 'success')),
  message    text not null,
  created_at timestamptz not null default now()
);

create index if not exists project_visions_project_id on project_visions(project_id);
create index if not exists vision_logs_project_id on vision_logs(project_id);

-- Enable Realtime on new tables and requirement_items
alter publication supabase_realtime add table project_visions;
alter publication supabase_realtime add table vision_logs;
alter publication supabase_realtime add table requirement_items;
