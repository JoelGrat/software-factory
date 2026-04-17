# Change Preview — Design Spec

**Date:** 2026-04-17  
**Status:** Approved

---

## Goal

Add a "Launch Preview" button to the change review page that spins up an isolated Docker container running the generated branch, then opens the app in a new browser tab for manual testing.

---

## Architecture

Three coupled parts:

1. **Project env vars** — per-project key/value store in FactoryOS settings, supplies secrets to preview containers
2. **Preview manager** — API routes + backend logic to start/stop Docker containers, allocate ports, enforce idle timeout
3. **Review page UI** — Launch / Stop / Restart controls, status indicator, missing-vars prompt

The port-binding layer is abstracted so that cloud deployment (reverse-proxy / subdomain routing) can replace the `localhost:{PORT}` strategy without changing anything else.

---

## Data Model

### `project_env_vars`

Stores env vars per project. Values are encrypted at rest.

```sql
id          uuid primary key default gen_random_uuid()
project_id  uuid not null references projects(id) on delete cascade
key         text not null
value_enc   text not null          -- AES-256-GCM encrypted
created_at  timestamptz not null default now()
updated_at  timestamptz not null default now()

unique (project_id, key)
```

### `preview_containers`

One row per preview attempt (running or recently stopped).

```sql
id               uuid primary key default gen_random_uuid()
change_id        uuid not null references change_requests(id) on delete cascade
project_id       uuid not null references projects(id) on delete cascade
container_id     text                        -- Docker container ID
port             int                         -- allocated host port
status           text not null default 'starting'
                 check (status in ('starting','running','stopped','error'))
started_at       timestamptz not null default now()
last_activity_at timestamptz not null default now()
stopped_at       timestamptz
error_message    text
```

---

## Port Management

- Local: allocate from fixed range **3100–3199** (avoids 3000 = FactoryOS dev server)
- On start: pick lowest port not currently in a `starting` or `running` row
- On cloud: replace with a `PreviewUrlStrategy` interface that returns the right URL — all other code unchanged

---

## API Routes

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/change-requests/[id]/preview/start` | Spin up container, return `{ previewId, status }` |
| `POST` | `/api/change-requests/[id]/preview/stop` | `docker stop`, mark stopped |
| `GET`  | `/api/change-requests/[id]/preview/status` | `{ status, port, url, lastActivityAt, missingVars }` |
| `POST` | `/api/change-requests/[id]/preview/keepalive` | Update `last_activity_at` (called every 60 s from open tab) |

All routes require authenticated user who owns the project.

---

## Container Start Flow

```
User clicks "Launch Preview"
  │
  ▼
GET /preview/status
  │
  ├─ already running? → open URL in new tab (done)
  │
  └─ not running → POST /preview/start
        │
        ▼
      Fetch project env vars from DB (decrypt)
      Check for missing keys declared as required
        │
        ├─ missing vars? → return { status: 'needs_config', missingVars: [...] }
        │     UI: modal — "Use saved values" / "Import from .env.local" / "Continue anyway"
        │
        └─ proceed
              │
              ▼
            Allocate port (3100–3199, lowest free)
            INSERT preview_containers row (status=starting)
              │
              ▼
            docker run -d -p {PORT}:3000 node:20-slim tail -f /dev/null
            Clone branch into container
            Write .env file (decrypted vars) into container — never to disk on host
            npm install && npm run dev &
              │
              ▼
            Poll http://localhost:{PORT} every 2 s (max 90 s)
            → responds? UPDATE status=running, return { url }
            → timeout? UPDATE status=error, return error
              │
              ▼
            Frontend opens url in new tab
```

---

## Idle Timeout

- Browser tab sends `POST /preview/keepalive` every 60 seconds while open
- Background job (Next.js route handler triggered by a cron or on each keepalive) checks all `running` containers:
  - `last_activity_at` older than **20 minutes** → `docker stop {container_id}`, mark `stopped`
- Local machines use a 20-minute default; cloud deployments can configure stricter limits

No preview container is killed solely because the user navigated away from FactoryOS — session signals are a hint only.

---

## Env Var Management

### Storage
- Stored in `project_env_vars`, value encrypted with AES-256-GCM using a server-side key (`PREVIEW_SECRET_KEY` env var)
- Never exposed to the browser in plaintext — decryption happens server-side at container start only

### Project Settings Page
- New "Environment Variables" section: list, add, edit, delete vars
- Values masked in the UI (show/hide toggle)
- "Import from .env.local" button: server-side reads the host `.env.local`, returns key list to the browser — user reviews and saves explicitly. No silent mounting.

### Missing Vars Prompt
Triggered at launch if any var stored as `required` is absent. User choices:

1. **Use saved values** — proceed with what's in the DB (may be partial)
2. **Import from .env.local** — one-click import, then launch
3. **Continue with limited preview** — launch anyway; preview UI shows `⚠ Preview running with N missing variables`

---

## Review Page UI

### Button states

| State | UI |
|-------|-----|
| No preview / stopped | **Launch Preview** button (primary) |
| Starting | Spinner + "Starting preview…" (disabled) |
| Running | Green dot + URL chip + **Open** link + **Stop** + **Restart** |
| Error | Red dot + error message + **Retry** |

### Placement
Sits in the action bar alongside Re-run and Approve. Does not replace either.

### Missing vars warning
When running with incomplete vars: `⚠ Preview running with 2 missing variables — [Configure]` inline below the URL chip.

---

## Security Rules

- Env var values never touch the browser in plaintext
- Containers are ephemeral (`--rm` flag) — filesystem is gone on stop
- `.env` written inside the container is not persisted anywhere on the host
- Port range is localhost-only; no external exposure by default
- Production secrets should not be used — project settings should use test/staging credentials

---

## Out of Scope

- E2E test runner (separate feature)
- Multi-user preview sharing / public URLs
- Cloud reverse-proxy implementation (abstraction point is ready; implementation deferred)
- Preview for non-Node / non-Next.js apps
- Per-var "required" flag UI (ship as all-optional initially)
