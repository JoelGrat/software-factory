-- 002_v2_schema.sql

-- pgvector for knowledge layer
create extension if not exists vector;

-- ── requirements ──────────────────────────────────────────────────────────────
alter table requirements
  add column if not exists domain text
    check (domain in ('saas', 'fintech', 'workflow', 'general'));

-- ── gaps ──────────────────────────────────────────────────────────────────────
alter table gaps
  add column if not exists validated        boolean not null default false,
  add column if not exists validated_by     uuid references auth.users(id);

-- Update source CHECK to include 'relation' (v2 adds relation-conflict gaps)
alter table gaps drop constraint if exists gaps_source_check;
alter table gaps add constraint gaps_source_check
  check (source in ('rule', 'ai', 'relation', 'pattern'));

-- Update resolution_source CHECK to include v2 values
alter table gaps drop constraint if exists gaps_resolution_source_check;
alter table gaps add constraint gaps_resolution_source_check
  check (resolution_source in ('question_answered', 'task_resolved', 'decision_recorded', 'risk_accepted', 'dismissed'));

-- ── requirement_relations ─────────────────────────────────────────────────────
create table if not exists requirement_relations (
  id          uuid primary key default gen_random_uuid(),
  source_id   uuid not null references requirement_items(id) on delete cascade,
  target_id   uuid not null references requirement_items(id) on delete cascade,
  type        text not null check (type in ('depends_on', 'conflicts_with', 'refines')),
  detected_by text not null check (detected_by in ('rule', 'ai')),
  created_at  timestamptz not null default now()
);

alter table requirement_relations
  add constraint requirement_relations_unique_relation
  unique (source_id, target_id, type);

-- ── risk_acceptances ──────────────────────────────────────────────────────────
create table if not exists risk_acceptances (
  id          uuid primary key default gen_random_uuid(),
  gap_id      uuid not null references gaps(id) on delete cascade,
  accepted_by uuid not null references auth.users(id),
  rationale   text not null,
  expires_at  timestamptz,
  created_at  timestamptz not null default now()
);

-- ── ai_usage_log ──────────────────────────────────────────────────────────────
create table if not exists ai_usage_log (
  id              uuid primary key default gen_random_uuid(),
  requirement_id  uuid references requirements(id) on delete set null,
  pipeline_step   text not null,
  provider        text not null,
  model           text not null,
  input_tokens    integer not null default 0,
  output_tokens   integer not null default 0,
  latency_ms      integer not null default 0,
  retry_count     integer not null default 0,
  created_at      timestamptz not null default now()
);

alter table ai_usage_log
  add column if not exists created_by uuid references auth.users(id) default auth.uid();

-- ── knowledge_cases ───────────────────────────────────────────────────────────
create table if not exists knowledge_cases (
  id                          uuid primary key default gen_random_uuid(),
  project_id                  uuid references projects(id) on delete set null,
  requirement_item_snapshot   jsonb not null,
  gap_snapshot                jsonb not null,
  resolution_snapshot         jsonb not null,
  context_tags                text[] not null default '{}',
  embedding                   vector(1536),
  created_at                  timestamptz not null default now()
);

alter table knowledge_cases
  add column if not exists created_by uuid references auth.users(id) default auth.uid();

create index if not exists knowledge_cases_embedding_idx
  on knowledge_cases using hnsw (embedding vector_cosine_ops)
  with (m = 16, ef_construction = 64);

-- ── case_feedback ─────────────────────────────────────────────────────────────
create table if not exists case_feedback (
  id          uuid primary key default gen_random_uuid(),
  case_id     uuid not null references knowledge_cases(id) on delete cascade,
  user_id     uuid not null references auth.users(id),
  helpful     boolean not null,
  used        boolean not null default false,
  overridden  boolean not null default false,
  created_at  timestamptz not null default now()
);

-- ── completeness_scores (v2 columns) ─────────────────────────────────────────
alter table completeness_scores
  add column if not exists blocking_count    integer not null default 0,
  add column if not exists high_risk_count   integer not null default 0,
  add column if not exists coverage_pct      integer not null default 0,
  add column if not exists internal_score    integer not null default 0,
  add column if not exists complexity_score  integer not null default 0,
  add column if not exists risk_flags        jsonb   not null default '[]',
  add column if not exists gap_density       decimal not null default 0;

alter table completeness_scores
  add constraint completeness_scores_coverage_pct_check check (coverage_pct between 0 and 100),
  add constraint completeness_scores_internal_score_check check (internal_score between 0 and 100),
  add constraint completeness_scores_complexity_score_check check (complexity_score between 0 and 100);

-- ── RLS ───────────────────────────────────────────────────────────────────────
alter table requirement_relations enable row level security;
alter table risk_acceptances       enable row level security;
alter table ai_usage_log           enable row level security;
alter table knowledge_cases        enable row level security;
alter table case_feedback          enable row level security;

create policy "requirement_relations_owner" on requirement_relations
  using (
    exists (
      select 1 from requirement_items ri
        join requirements r  on r.id  = ri.requirement_id
        join projects      p on p.id  = r.project_id
      where ri.id = requirement_relations.source_id
        and p.owner_id = auth.uid()
    )
  );

create policy "risk_acceptances_owner" on risk_acceptances
  using (
    exists (
      select 1 from gaps g
        join requirements r on r.id = g.requirement_id
        join projects      p on p.id = r.project_id
      where g.id = risk_acceptances.gap_id
        and p.owner_id = auth.uid()
    )
  );

drop policy if exists "ai_usage_log_owner" on ai_usage_log;
create policy "ai_usage_log_rls" on ai_usage_log
  using (created_by = auth.uid());

drop policy if exists "knowledge_cases_owner" on knowledge_cases;
create policy "knowledge_cases_rls" on knowledge_cases
  using (
    created_by = auth.uid() or
    exists (
      select 1 from projects p
      where p.id = knowledge_cases.project_id
        and p.owner_id = auth.uid()
    )
  );

create policy "case_feedback_user" on case_feedback
  using (user_id = auth.uid());

-- ── FK indexes on new tables ──────────────────────────────────────────────────
create index if not exists idx_requirement_relations_source_id on requirement_relations(source_id);
create index if not exists idx_requirement_relations_target_id on requirement_relations(target_id);
create index if not exists idx_risk_acceptances_gap_id on risk_acceptances(gap_id);
create index if not exists idx_ai_usage_log_requirement_id on ai_usage_log(requirement_id);
create index if not exists idx_case_feedback_case_id on case_feedback(case_id);

-- ── pgvector similarity RPC (used by Plan E knowledge retriever) ──────────────
create or replace function match_knowledge_cases (
  query_embedding     vector(1536),
  context_tags_filter text[],
  match_count         int default 5
)
returns table (
  id                        uuid,
  gap_snapshot              jsonb,
  resolution_snapshot       jsonb,
  context_tags              text[],
  similarity                float
)
language sql stable
as $$
  select
    kc.id,
    kc.gap_snapshot,
    kc.resolution_snapshot,
    kc.context_tags,
    1 - (kc.embedding <=> query_embedding) as similarity
  from knowledge_cases kc
  where kc.embedding is not null
    and kc.context_tags && context_tags_filter
  order by kc.embedding <=> query_embedding
  limit match_count;
$$;
