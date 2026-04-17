# Change Preview — Design Spec

**Date:** 2026-04-17  
**Status:** Approved

---

## Goal

Add a "Launch Preview" button to the change review page that spins up an isolated Docker container running the generated branch, then opens the app in a new browser tab for manual testing.

---

## Architecture

Three coupled parts:

1. **Project env vars + preview config** — per-project settings: env vars, install/start commands, health check, resource limits
2. **Preview manager** — API routes + backend logic to start/stop Docker containers, allocate ports, enforce idle timeout
3. **Review page UI** — Launch / Stop / Restart controls, status indicator, startup logs, missing-vars prompt

The port-binding layer is abstracted behind a `PreviewUrlStrategy` so cloud deployment (reverse-proxy / subdomain routing) can replace `localhost:{PORT}` without changing anything else.

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

### `project_preview_config`

Per-project preview settings. One row per project (upserted).

```sql
id               uuid primary key default gen_random_uuid()
project_id       uuid not null references projects(id) on delete cascade unique
install_command  text not null default 'auto'   -- 'auto' = detect from lockfile
start_command    text not null default 'auto'   -- 'auto' = detect from package.json scripts
work_dir         text not null default '.'      -- relative path for monorepos
health_path      text not null default '/'      -- URL path to poll for readiness
health_text      text                           -- optional: response body must contain this string
port_internal    int  not null default 3000     -- port the app listens on inside container
expected_keys    text[]  not null default '{}'  -- keys user has declared they intend to set
max_memory_mb    int  not null default 1024
max_cpu_shares   int  not null default 512      -- Docker --cpu-shares (1024 = 1 core)
updated_at       timestamptz not null default now()
```

### `preview_containers`

One row per preview attempt (running or recently stopped).

```sql
id               uuid primary key default gen_random_uuid()
change_id        uuid not null references change_requests(id) on delete cascade
project_id       uuid not null references projects(id) on delete cascade
container_id     text                        -- Docker container ID (null until docker run succeeds)
port             int                         -- allocated host port
status           text not null default 'starting'
                 check (status in ('starting','running','stopped','error'))
startup_log      text                        -- last 100 lines of npm output, updated during start
started_at       timestamptz not null default now()
last_activity_at timestamptz not null default now()
stopped_at       timestamptz
error_message    text
```

---

## Package Manager + Start Command Detection

When `install_command = 'auto'` or `start_command = 'auto'`, the server detects from the cloned repo:

**Install command detection** (checked in order):
1. `pnpm-lock.yaml` → `pnpm install --frozen-lockfile`
2. `yarn.lock` → `yarn install --frozen-lockfile`
3. `bun.lockb` → `bun install`
4. `package-lock.json` → `npm ci`
5. fallback → `npm install`

**Start command detection** (checked in order):
1. `package.json` has `scripts.preview` → use it
2. `package.json` has `scripts.start` → use it
3. `package.json` has `scripts.dev` → use it
4. fallback → `npm run dev`

User can override both in project settings. This covers monorepos via `work_dir`.

---

## Port Management

- Allocate from range **3100–3999** (900 slots, expandable)
- On start: query `preview_containers` for ports currently `starting` or `running`; pick lowest free port in range
- If range exhausted: return error `port_pool_exhausted` — user must stop an existing preview

**Orphan cleanup:** On every `start` request, before allocating, sweep `preview_containers` where `status IN ('starting','running')`:
- If `started_at` older than 30 minutes and status is still `starting` → mark `error`, release port
- For `running` rows: run `docker inspect {container_id}` — if container no longer exists → mark `stopped`, release port

This keeps the port pool self-healing without an external scheduler.

---

## API Routes

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/change-requests/[id]/preview/start` | Spin up container, return `{ previewId, status }` |
| `POST` | `/api/change-requests/[id]/preview/stop` | `docker stop`, mark stopped |
| `GET`  | `/api/change-requests/[id]/preview/status` | `{ status, port, url, lastActivityAt, missingKeys, startupLog }` |
| `POST` | `/api/change-requests/[id]/preview/keepalive` | Update `last_activity_at` |

All routes require authenticated user who owns the project. Each `status` and `keepalive` call also runs the idle expiry check (see below).

---

## Container Start Flow

```
POST /preview/start
  │
  ▼
Run orphan cleanup (sweep stale starting/running rows)
  │
  ▼
Load project_preview_config + project_env_vars (decrypt)
  │
  ▼
Compute missingKeys = expected_keys − keys present in project_env_vars
  │
  ├─ missingKeys non-empty?
  │     → return { status: 'needs_config', missingKeys }
  │     → UI: modal — "Use saved values" / "Import from .env.local" / "Continue anyway"
  │       (if user chooses "continue": re-POST with { force: true }, skip this check)
  │
  └─ proceed
        │
        ▼
      Allocate port (3100–3999, lowest free)
      INSERT preview_containers row (status='starting', port=allocated)
        │
        ▼
      docker run -d --rm \
        -p {PORT}:{port_internal} \
        --memory={max_memory_mb}m \
        --cpu-shares={max_cpu_shares} \
        node:20-slim tail -f /dev/null
        │
        ▼
      UPDATE container_id in preview_containers
      Clone branch into container at work_dir
      Write .env file (decrypted vars) inside container — never touches host disk
        │
        ▼
      Run install_command inside container (stream stdout → startup_log, last 100 lines)
      Run start_command & in background
        │
        ▼
      Poll GET http://localhost:{PORT}{health_path} every 2 s, max 90 s
        If health_text set: response body must contain it
        │
        ├─ responds correctly → UPDATE status='running' → return { url, previewId }
        └─ timeout → UPDATE status='error', error_message='startup timeout'
                     startup_log preserved for display
```

---

## Idle Timeout

- Browser tab sends `POST /preview/keepalive` every 60 seconds while the preview tab is open
- **No external scheduler required.** On every API call (`status`, `keepalive`, `start`), run:

```typescript
await db.from('preview_containers')
  .update({ status: 'stopped', stopped_at: now() })
  .eq('project_id', projectId)
  .eq('status', 'running')
  .lt('last_activity_at', new Date(Date.now() - 20 * 60 * 1000).toISOString())
// then docker stop each returned container_id
```

- Preview containers are never killed solely because the user navigated away from FactoryOS — the 20-minute window covers normal back-and-forth usage
- Local machines: 20-minute default. Cloud deployments can lower this via config.

---

## Resource Constraints

Every preview container starts with hard limits:

| Constraint | Default | Config field |
|-----------|---------|-------------|
| Memory | 1024 MB | `max_memory_mb` |
| CPU shares | 512 (½ core) | `max_cpu_shares` |
| Max concurrent previews per project | 3 | hardcoded constant `MAX_CONCURRENT_PREVIEWS = 3` |

On start, if `COUNT(status IN ('starting','running')) >= MAX_CONCURRENT_PREVIEWS` for the project → return error `max_previews_reached`, tell user to stop an existing one first.

---

## Env Var Management

### Storage
- Stored in `project_env_vars`, value encrypted with AES-256-GCM using server-side `PREVIEW_SECRET_KEY` env var
- Never exposed to the browser in plaintext — decryption happens server-side at container start only

### Missing Key Detection
- `project_preview_config.expected_keys` is a user-maintained list of keys they intend to set (e.g. `["DATABASE_URL", "NEXTAUTH_SECRET"]`)
- `missingKeys = expected_keys − saved keys` — no "required" flag, no runtime inference
- If `expected_keys` is empty, missing detection is skipped entirely — no prompt, just launch

### Project Settings Page
- New **"Preview"** section with two sub-sections:
  - **Environment Variables**: list, add, edit, delete vars + "Expected keys" field (comma-separated)
  - **Preview Config**: install command, start command, work dir, health path, health text, internal port, resource limits
- Values masked in the UI (show/hide toggle per row)
- **"Import from .env.local"** button: server-side reads the host `.env.local`, returns key/value list to the browser — user reviews the prefilled form and saves explicitly. No silent mounting.

### Missing Vars Prompt (at launch)
Triggered only when `missingKeys` is non-empty. User choices:

1. **Use saved values** — proceed with what's in the DB; may be partial
2. **Import from .env.local** — one-click import into project settings, then launch
3. **Continue with limited preview** — launch anyway; review page shows `⚠ Preview running with N missing variables — [Configure]`

---

## Startup Logs

`startup_log` is updated during container start (install + app boot output, last 100 lines).  
Exposed on the `status` endpoint and surfaced in the UI whenever status is `error` or `starting`:

- Collapsible **"View startup logs"** panel below the status indicator
- Monospace, scrollable, max 300px height
- **"Copy"** button
- Shown automatically (expanded) when status = `error`

This makes "Retry" actionable — user can see exactly what failed.

---

## Review Page UI

### Button states

| State | UI |
|-------|-----|
| No preview / stopped | **Launch Preview** button (primary) |
| Starting | Spinner + "Starting preview…" + collapsible startup log |
| Running | Green dot + URL chip + **Open** link + **Stop** + **Restart** |
| Error | Red dot + error message + expanded startup log + **Retry** |
| needs_config | Missing vars modal |
| max_previews_reached | Inline error: "Stop an existing preview first" |

### Placement
Sits in the action bar alongside Re-run and Approve. Does not replace either.

### Missing vars warning (running state)
`⚠ Preview running with 2 missing variables — [Configure]` — inline below the URL chip, links to project settings.

---

## Security Rules

- Env var values never touch the browser in plaintext
- Containers run with `--rm` — filesystem destroyed on stop
- `.env` written inside the container; never written to host disk
- Port range is localhost-only; no external binding by default
- Use test/staging credentials in project settings — not production secrets

---

## Out of Scope

- E2E test runner (separate feature)
- Multi-user preview sharing / public URLs
- Cloud reverse-proxy implementation (abstraction point is ready; implementation deferred)
- Preview for non-Node apps
- Per-var "required" enforcement (replaced by `expected_keys` list)
- Warning banner inside the preview tab itself ("Preview will stop in 2 min")
