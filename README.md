# Software Factory

An AI-powered requirements analysis platform. Paste raw product requirements and the app parses them into structured items, detects gaps, and generates clarifying questions — so nothing falls through the cracks before development begins.

## What it does

- **Parses requirements** — classifies raw text into functional, non-functional, constraint, and assumption items with priority scores
- **Detects gaps** — identifies missing, ambiguous, conflicting, or incomplete requirements using AI and rule-based analysis
- **Generates questions** — produces targeted clarifying questions for each gap
- **Tracks projects** — organises requirements documents per project with per-user ownership

## Tech stack

- **Framework**: Next.js 14 (App Router)
- **Database**: Supabase (Postgres + Auth)
- **AI**: Claude (Anthropic) or OpenAI — swappable via env var
- **Styling**: Tailwind CSS
- **Testing**: Vitest
- **Language**: TypeScript

## Getting started

### Prerequisites

- Node.js 18+
- A [Supabase](https://supabase.com) project
- An [Anthropic](https://console.anthropic.com) or OpenAI API key

### Install

```bash
npm install
```

### Configure environment

Copy the example env file and fill in your values:

```bash
cp .env.local.example .env.local
```

| Variable | Description |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Your Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon/public key |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key |
| `AI_PROVIDER` | `claude`, `openai`, or `mock` |
| `ANTHROPIC_API_KEY` | Required if `AI_PROVIDER=claude` |
| `OPENAI_API_KEY` | Required if `AI_PROVIDER=openai` |

### Set up the database

```bash
npx supabase link --project-ref <your-project-ref>
npx supabase db push
```

### Run

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start development server |
| `npm run build` | Build for production |
| `npm start` | Start production server |
| `npm test` | Run tests |
| `npm run test:watch` | Run tests in watch mode |
| `npm run test:coverage` | Run tests with coverage report |
| `npm run lint` | Lint the codebase |

## Database migrations

```bash
npx supabase migration new <name>   # create a new migration
npx supabase db push                # apply migrations to remote
npx supabase db pull                # pull schema changes from remote
```
