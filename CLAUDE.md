# FactoryOS — CLAUDE.md

## Commands

```bash
npm run dev           # dev server (Next.js on :3000)
npm run build         # production build
npm run test          # vitest (single run)
npm run test:watch    # vitest watch
npm run lint          # eslint via next lint
supabase db push      # apply pending migrations to local Supabase
```

## Architecture

```
app/
  (auth)/             # login / signup pages (excluded from auth middleware)
  api/                # Next.js API routes — thin handlers only, delegate to lib/
  projects/[id]/      # per-project shell: changes, system-model, settings
lib/
  ai/                 # AI abstraction — provider.ts interface, registry.ts factory, adapters/
  pipeline/           # 5-stage change pipeline
    orchestrator.ts   # runPipeline() sequences all phases
    phases/           # impact-analysis, draft-plan, plan-generation
  planning/           # plan and task generation helpers
  supabase/           # server.ts (SSR), client.ts (browser), admin.ts (service role)
components/           # shared UI — app/, change/, projects/, ui/
supabase/migrations/  # numbered SQL migrations (NNN_description.sql)
tests/                # Vitest tests — mirror lib/ structure
docs/                 # project-overview.md is the canonical feature reference
```

**Key patterns:**
- `@` alias = project root (configured in `tsconfig.json` + `vitest.config.ts`)
- API routes receive requests, create a Supabase client + AI provider, call into `lib/`
- AI provider: always go through `lib/ai/registry.ts → getProvider()`, never instantiate adapters directly
- Supabase: use `lib/supabase/server.ts` in API routes/Server Components; `admin.ts` only when you need to bypass RLS

<important if="touching the pipeline or orchestrator">
The pipeline is: **draft-plan → impact-analysis → plan-generation → applyExecutionPolicy**.
Each phase is idempotent — it checks its own preconditions before writing. Never call a phase directly from an API route; always go through `runPipeline()` in `orchestrator.ts`.
The execution policy (auto / approval / manual) lives in `project_settings.riskPolicy` (a JSON column). Low plan quality score (< 0.5) overrides `auto` → `approval` even if risk is low.
</important>

<important if="adding or changing database schema">
Write a new numbered migration in `supabase/migrations/` — never edit existing ones.
After writing: `supabase db push` to apply locally.
The service role key (`SUPABASE_SERVICE_ROLE_KEY`) is required for admin client operations; never expose it to the browser.
</important>

<important if="writing tests">
Test environment is `jsdom` (Vitest). Tests live in `tests/` mirroring `lib/`.
Use the `mock` AI provider (`new MockAIProvider()`) for unit tests — never hit real APIs in tests.
</important>

## Gotchas

- **AI provider defaults to `mock`** — `AI_PROVIDER` env var controls which adapter is used (`claude` | `openai` | `mock`). If real AI calls silently return stub data, check `.env.local`.
- **Middleware skips `/api/*`** — the middleware matcher excludes all API routes, so API handlers are not protected by the auth redirect. Guard API routes that need auth manually.
- **Docker required for execution** — Stage 5 (code execution) launches a `node:20-slim` container. The Docker daemon must be running; the feature silently stalls if it isn't.
- **Branch naming by the pipeline** — execution creates branches named `sf/<change-id-prefix>-<slug>`. Don't create branches with the `sf/` prefix manually.
- **README is stale** — the README describes the original requirements-analysis prototype. `docs/project-overview.md` is the authoritative reference.

## Workflow

- Branch naming: `feat/`, `fix/`, `chore/` + kebab-case description (e.g. `feat/bulletproof-pipeline`)
- Never create git worktrees — work directly on branches in the main repo
- One logical change per branch; keep PRs focused
- Run `npm run test && npm run lint` before committing

## Environment variables

See `.env.local.example` for the full list. Required for full functionality:

| Variable | Required for |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | everything |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | everything |
| `SUPABASE_SERVICE_ROLE_KEY` | scanner, execution (bypasses RLS) |
| `AI_PROVIDER` | AI calls (`claude` \| `openai` \| `mock`) |
| `ANTHROPIC_API_KEY` | when `AI_PROVIDER=claude` |
| `OPENAI_API_KEY` | when `AI_PROVIDER=openai` |
| `PREVIEW_SECRET_KEY` | preview feature (encrypt env vars) — 64-char hex, generate: `openssl rand -hex 32` |
