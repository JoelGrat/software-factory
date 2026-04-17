# Change Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Launch Preview" button to the change review page that spins up an isolated Docker container running the generated branch, then opens the app in a new browser tab for manual testing.

**Architecture:** Three layers: (1) per-project env vars stored encrypted in `project_env_vars` + preview settings in `project_preview_config`; (2) a backend preview manager that allocates ports, runs Docker containers, detects package managers, and enforces idle timeout; (3) a `PreviewPanel` React component on the review page that drives a start → polling → running state machine with keepalive pings and a startup log display.

**Tech Stack:** Next.js 15 App Router, Supabase (PostgreSQL), Node.js `crypto` (AES-256-GCM), Docker CLI, TypeScript, Tailwind CSS, Vitest

---

## File Map

**Create:**
- `supabase/migrations/030_preview.sql` — three new tables + RLS
- `lib/preview/crypto.ts` — AES-256-GCM encrypt/decrypt for env var values
- `lib/preview/package-detector.ts` — detect install/start commands from lockfiles
- `lib/preview/port-manager.ts` — allocate ports 3100–3999, orphan cleanup
- `lib/preview/preview-url.ts` — `PreviewUrlStrategy` interface + `LocalStrategy`
- `lib/preview/preview-manager.ts` — `startPreview`, `stopPreview`, `getPreviewStatus`, `touchActivity`, `expireIdle`
- `app/api/projects/[id]/env-vars/route.ts` — GET list, POST upsert, DELETE
- `app/api/projects/[id]/env-vars/import/route.ts` — POST read host `.env.local`
- `app/api/projects/[id]/preview-config/route.ts` — GET, PUT
- `app/api/change-requests/[id]/preview/start/route.ts`
- `app/api/change-requests/[id]/preview/stop/route.ts`
- `app/api/change-requests/[id]/preview/status/route.ts`
- `app/api/change-requests/[id]/preview/keepalive/route.ts`
- `components/preview/PreviewPanel.tsx` — review page client component
- `tests/lib/preview/crypto.test.ts`
- `tests/lib/preview/package-detector.test.ts`
- `tests/lib/preview/port-manager.test.ts`

**Modify:**
- `app/projects/[id]/settings/project-settings-view.tsx` — add `'env-vars'` and `'preview-config'` sections
- `app/projects/[id]/settings/page.tsx` — fetch env var keys + preview config and pass as props
- `app/projects/[id]/changes/[changeId]/review/review-view.tsx` — add `PreviewPanel`

---

### Task 1: Database migration

**Files:**
- Create: `supabase/migrations/030_preview.sql`

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/030_preview.sql

-- Env vars per project (values encrypted at rest)
create table project_env_vars (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references projects(id) on delete cascade,
  key         text not null,
  value_enc   text not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (project_id, key)
);

-- Preview config per project (one row, upserted)
create table project_preview_config (
  id               uuid primary key default gen_random_uuid(),
  project_id       uuid not null references projects(id) on delete cascade unique,
  install_command  text not null default 'auto',
  start_command    text not null default 'auto',
  work_dir         text not null default '.',
  health_path      text not null default '/',
  health_text      text,
  port_internal    int  not null default 3000,
  expected_keys    text[] not null default '{}',
  max_memory_mb    int  not null default 1024,
  max_cpu_shares   int  not null default 512,
  updated_at       timestamptz not null default now()
);

-- Preview container instances
create table preview_containers (
  id               uuid primary key default gen_random_uuid(),
  change_id        uuid not null references change_requests(id) on delete cascade,
  project_id       uuid not null references projects(id) on delete cascade,
  container_id     text,
  port             int,
  status           text not null default 'starting'
                   check (status in ('starting','running','stopped','error')),
  startup_log      text not null default '',
  started_at       timestamptz not null default now(),
  last_activity_at timestamptz not null default now(),
  stopped_at       timestamptz,
  error_message    text
);

create index on preview_containers (change_id, started_at desc);
create index on preview_containers (project_id, status);

-- RLS
alter table project_env_vars enable row level security;
alter table project_preview_config enable row level security;
alter table preview_containers enable row level security;

create policy "owner full access on env_vars"
  on project_env_vars for all
  using (project_id in (select id from projects where owner_id = auth.uid()));

create policy "owner full access on preview_config"
  on project_preview_config for all
  using (project_id in (select id from projects where owner_id = auth.uid()));

create policy "owner full access on preview_containers"
  on preview_containers for all
  using (project_id in (select id from projects where owner_id = auth.uid()));
```

- [ ] **Step 2: Apply the migration**

```bash
supabase db push
```

Expected: `Applied migration 030_preview`

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/030_preview.sql
git commit -m "feat: add preview tables migration"
```

---

### Task 2: Crypto utilities

**Files:**
- Create: `lib/preview/crypto.ts`
- Test: `tests/lib/preview/crypto.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/lib/preview/crypto.test.ts
import { describe, it, expect, beforeAll } from 'vitest'
import { encrypt, decrypt } from '@/lib/preview/crypto'

beforeAll(() => {
  process.env.PREVIEW_SECRET_KEY = 'a'.repeat(64)
})

describe('encrypt / decrypt', () => {
  it('round-trips a plain string', () => {
    const plain = 'my-secret-value'
    expect(decrypt(encrypt(plain))).toBe(plain)
  })

  it('produces different ciphertext each call (random IV)', () => {
    const a = encrypt('same')
    const b = encrypt('same')
    expect(a).not.toBe(b)
  })

  it('throws on tampered ciphertext', () => {
    const enc = encrypt('value')
    const tampered = enc.slice(0, -4) + 'xxxx'
    expect(() => decrypt(tampered)).toThrow()
  })

  it('throws when PREVIEW_SECRET_KEY is missing', () => {
    const saved = process.env.PREVIEW_SECRET_KEY
    delete process.env.PREVIEW_SECRET_KEY
    expect(() => encrypt('x')).toThrow('PREVIEW_SECRET_KEY')
    process.env.PREVIEW_SECRET_KEY = saved!
  })
})
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
npx vitest run tests/lib/preview/crypto.test.ts
```

Expected: FAIL — `Cannot find module '@/lib/preview/crypto'`

- [ ] **Step 3: Implement the crypto module**

```typescript
// lib/preview/crypto.ts
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const ALGO = 'aes-256-gcm'

function getKey(): Buffer {
  const hex = process.env.PREVIEW_SECRET_KEY ?? ''
  if (hex.length !== 64) throw new Error('PREVIEW_SECRET_KEY must be a 64-char hex string (32 bytes)')
  return Buffer.from(hex, 'hex')
}

/** Encrypts a plaintext string. Returns `iv:authTag:ciphertext` (all hex). */
export function encrypt(plaintext: string): string {
  const key = getKey()
  const iv = randomBytes(12)
  const cipher = createCipheriv(ALGO, key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`
}

/** Decrypts a string produced by encrypt(). Throws on invalid input or tampered data. */
export function decrypt(encoded: string): string {
  const key = getKey()
  const parts = encoded.split(':')
  if (parts.length !== 3) throw new Error('Invalid encrypted format')
  const [ivHex, tagHex, dataHex] = parts as [string, string, string]
  const decipher = createDecipheriv(ALGO, key, Buffer.from(ivHex, 'hex'))
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'))
  return Buffer.concat([
    decipher.update(Buffer.from(dataHex, 'hex')),
    decipher.final(),
  ]).toString('utf8')
}
```

- [ ] **Step 4: Run test to confirm it passes**

```bash
npx vitest run tests/lib/preview/crypto.test.ts
```

Expected: PASS — 4 tests

- [ ] **Step 5: Commit**

```bash
git add lib/preview/crypto.ts tests/lib/preview/crypto.test.ts
git commit -m "feat: add AES-256-GCM crypto utilities for env var encryption"
```

---

### Task 3: Package manager + start command detector

**Files:**
- Create: `lib/preview/package-detector.ts`
- Test: `tests/lib/preview/package-detector.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/lib/preview/package-detector.test.ts
import { describe, it, expect } from 'vitest'
import { detectInstallCommand, detectStartCommand } from '@/lib/preview/package-detector'

describe('detectInstallCommand', () => {
  it('detects pnpm from pnpm-lock.yaml', () => {
    expect(detectInstallCommand(['pnpm-lock.yaml', 'package.json']))
      .toBe('pnpm install --frozen-lockfile')
  })
  it('detects yarn from yarn.lock', () => {
    expect(detectInstallCommand(['yarn.lock', 'package.json']))
      .toBe('yarn install --frozen-lockfile')
  })
  it('detects bun from bun.lockb', () => {
    expect(detectInstallCommand(['bun.lockb', 'package.json']))
      .toBe('bun install')
  })
  it('detects npm from package-lock.json', () => {
    expect(detectInstallCommand(['package-lock.json', 'package.json']))
      .toBe('npm ci')
  })
  it('falls back to npm install when no lockfile', () => {
    expect(detectInstallCommand(['package.json'])).toBe('npm install')
  })
  it('prefers pnpm over yarn when both present', () => {
    expect(detectInstallCommand(['pnpm-lock.yaml', 'yarn.lock']))
      .toBe('pnpm install --frozen-lockfile')
  })
})

describe('detectStartCommand', () => {
  it('prefers preview script', () => {
    expect(detectStartCommand({ preview: 'vite preview', dev: 'vite' }))
      .toBe('npm run preview')
  })
  it('uses start when no preview', () => {
    expect(detectStartCommand({ start: 'node server.js', dev: 'nodemon' }))
      .toBe('npm run start')
  })
  it('falls back to dev', () => {
    expect(detectStartCommand({ dev: 'next dev' })).toBe('npm run dev')
  })
  it('falls back to npm run dev when no scripts match', () => {
    expect(detectStartCommand({ test: 'vitest' })).toBe('npm run dev')
  })
})
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
npx vitest run tests/lib/preview/package-detector.test.ts
```

Expected: FAIL — module not found

- [ ] **Step 3: Implement the detector**

```typescript
// lib/preview/package-detector.ts

/** Given a list of filenames in the repo root, return the best install command. */
export function detectInstallCommand(files: string[]): string {
  const set = new Set(files)
  if (set.has('pnpm-lock.yaml')) return 'pnpm install --frozen-lockfile'
  if (set.has('yarn.lock'))      return 'yarn install --frozen-lockfile'
  if (set.has('bun.lockb'))      return 'bun install'
  if (set.has('package-lock.json')) return 'npm ci'
  return 'npm install'
}

/** Given package.json scripts object, return the best start command. */
export function detectStartCommand(scripts: Record<string, string>): string {
  if (scripts.preview) return 'npm run preview'
  if (scripts.start)   return 'npm run start'
  return 'npm run dev'
}
```

- [ ] **Step 4: Run test to confirm it passes**

```bash
npx vitest run tests/lib/preview/package-detector.test.ts
```

Expected: PASS — 10 tests

- [ ] **Step 5: Commit**

```bash
git add lib/preview/package-detector.ts tests/lib/preview/package-detector.test.ts
git commit -m "feat: add package manager and start command detection"
```

---

### Task 4: Port manager

**Files:**
- Create: `lib/preview/port-manager.ts`
- Test: `tests/lib/preview/port-manager.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/lib/preview/port-manager.test.ts
import { describe, it, expect } from 'vitest'
import { pickPort, PORT_MIN, PORT_MAX } from '@/lib/preview/port-manager'

describe('pickPort', () => {
  it('picks PORT_MIN when nothing is used', () => {
    expect(pickPort(new Set())).toBe(PORT_MIN)
  })
  it('skips used ports', () => {
    expect(pickPort(new Set([3100, 3101]))).toBe(3102)
  })
  it('throws port_pool_exhausted when all ports used', () => {
    const all = new Set(Array.from({ length: PORT_MAX - PORT_MIN + 1 }, (_, i) => PORT_MIN + i))
    expect(() => pickPort(all)).toThrow('port_pool_exhausted')
  })
})
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
npx vitest run tests/lib/preview/port-manager.test.ts
```

Expected: FAIL — module not found

- [ ] **Step 3: Implement port manager**

```typescript
// lib/preview/port-manager.ts
import { exec as execCb } from 'node:child_process'
import { promisify } from 'node:util'
import type { SupabaseClient } from '@supabase/supabase-js'

const exec = promisify(execCb)

export const PORT_MIN = 3100
export const PORT_MAX = 3999

/** Pure: pick lowest free port. Throws 'port_pool_exhausted' if none available. */
export function pickPort(usedPorts: Set<number>): number {
  for (let p = PORT_MIN; p <= PORT_MAX; p++) {
    if (!usedPorts.has(p)) return p
  }
  throw new Error('port_pool_exhausted')
}

/** Query DB for in-use ports, pick lowest free one. */
export async function allocatePort(db: SupabaseClient): Promise<number> {
  const { data } = await (db.from('preview_containers') as any)
    .select('port')
    .in('status', ['starting', 'running'])
  const used = new Set<number>((data ?? []).map((r: any) => r.port as number).filter(Boolean))
  return pickPort(used)
}

/**
 * Sweep stale rows and verify running containers still exist in Docker.
 * Call this before every allocatePort() to keep the pool self-healing.
 */
export async function cleanupOrphans(db: SupabaseClient): Promise<void> {
  const now = new Date().toISOString()
  const startingCutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString()

  // Mark stale 'starting' rows as error
  await (db.from('preview_containers') as any)
    .update({ status: 'error', error_message: 'startup timeout', stopped_at: now })
    .eq('status', 'starting')
    .lt('started_at', startingCutoff)

  // Check 'running' rows against Docker
  const { data: running } = await (db.from('preview_containers') as any)
    .select('id, container_id')
    .eq('status', 'running')

  for (const row of running ?? []) {
    if (!row.container_id) continue
    try {
      await exec(`docker inspect ${row.container_id}`)
    } catch {
      await (db.from('preview_containers') as any)
        .update({ status: 'stopped', stopped_at: now })
        .eq('id', row.id)
    }
  }
}
```

- [ ] **Step 4: Run test to confirm it passes**

```bash
npx vitest run tests/lib/preview/port-manager.test.ts
```

Expected: PASS — 3 tests

- [ ] **Step 5: Commit**

```bash
git add lib/preview/port-manager.ts tests/lib/preview/port-manager.test.ts
git commit -m "feat: add port manager for preview container allocation"
```

---

### Task 5: Preview URL strategy

**Files:**
- Create: `lib/preview/preview-url.ts`

- [ ] **Step 1: Write the module**

```typescript
// lib/preview/preview-url.ts

export interface PreviewUrlStrategy {
  getUrl(port: number): string
}

/** Local development: app runs on the same machine as FactoryOS. */
export class LocalStrategy implements PreviewUrlStrategy {
  getUrl(port: number): string {
    return `http://localhost:${port}`
  }
}

/** Default strategy — swap this out for cloud deployments. */
export const defaultStrategy: PreviewUrlStrategy = new LocalStrategy()
```

- [ ] **Step 2: Commit**

```bash
git add lib/preview/preview-url.ts
git commit -m "feat: add PreviewUrlStrategy with local implementation"
```

---

### Task 6: Preview manager

**Files:**
- Create: `lib/preview/preview-manager.ts`

The preview manager starts Docker containers, runs the app, polls until ready, and enforces idle timeout. It uses the port manager, package detector, and URL strategy from previous tasks.

- [ ] **Step 1: Write the module**

```typescript
// lib/preview/preview-manager.ts
import { exec as execCb } from 'node:child_process'
import { promisify } from 'node:util'
import type { SupabaseClient } from '@supabase/supabase-js'
import { allocatePort, cleanupOrphans } from './port-manager'
import { detectInstallCommand, detectStartCommand } from './package-detector'
import { defaultStrategy } from './preview-url'
import { decrypt } from './crypto'

const exec = promisify(execCb)

const MAX_CONCURRENT_PREVIEWS = 3
const IDLE_TIMEOUT_MS = 20 * 60 * 1000   // 20 minutes
const STARTUP_TIMEOUT_MS = 90 * 1000     // 90 seconds
const POLL_INTERVAL_MS = 2000

export interface PreviewConfig {
  installCommand: string
  startCommand: string
  workDir: string
  healthPath: string
  healthText: string | null
  portInternal: number
  expectedKeys: string[]
  maxMemoryMb: number
  maxCpuShares: number
}

export interface StartResult {
  status: 'running' | 'needs_config' | 'error' | 'max_previews_reached' | 'port_exhausted'
  previewId?: string
  url?: string
  missingKeys?: string[]
  errorMessage?: string
}

export interface PreviewStatus {
  status: 'none' | 'starting' | 'running' | 'stopped' | 'error'
  previewId: string | null
  url: string | null
  port: number | null
  lastActivityAt: string | null
  startupLog: string
  errorMessage: string | null
  missingKeys: string[]
}

async function dockerExec(containerId: string, command: string): Promise<string> {
  const escaped = command.replace(/"/g, '\\"')
  const { stdout, stderr } = await exec(`docker exec ${containerId} sh -c "${escaped}"`)
  return stdout + stderr
}

async function appendLog(db: SupabaseClient, previewId: string, line: string): Promise<void> {
  // Append to startup_log, keep last 100 lines
  const { data } = await (db.from('preview_containers') as any)
    .select('startup_log')
    .eq('id', previewId)
    .single()
  const existing: string = (data as any)?.startup_log ?? ''
  const lines = existing.split('\n')
  lines.push(line)
  const trimmed = lines.slice(-100).join('\n')
  await (db.from('preview_containers') as any)
    .update({ startup_log: trimmed })
    .eq('id', previewId)
}

export async function startPreview(
  db: SupabaseClient,
  changeId: string,
  projectId: string,
  repoUrl: string,
  repoToken: string,
  branchName: string,
  config: PreviewConfig,
  envVars: Record<string, string>,
  force = false,
): Promise<StartResult> {
  // 1. Orphan cleanup + check concurrency
  await cleanupOrphans(db)

  const { count } = await (db.from('preview_containers') as any)
    .select('*', { count: 'exact', head: true })
    .eq('project_id', projectId)
    .in('status', ['starting', 'running'])
  if ((count ?? 0) >= MAX_CONCURRENT_PREVIEWS) {
    return { status: 'max_previews_reached' }
  }

  // 2. Check missing expected keys
  if (!force && config.expectedKeys.length > 0) {
    const savedKeys = new Set(Object.keys(envVars))
    const missingKeys = config.expectedKeys.filter(k => !savedKeys.has(k))
    if (missingKeys.length > 0) {
      return { status: 'needs_config', missingKeys }
    }
  }

  // 3. Allocate port
  let port: number
  try {
    port = await allocatePort(db)
  } catch {
    return { status: 'port_exhausted', errorMessage: 'No ports available. Stop an existing preview first.' }
  }

  // 4. Create DB row
  const { data: row } = await (db.from('preview_containers') as any)
    .insert({ change_id: changeId, project_id: projectId, port, status: 'starting' })
    .select('id')
    .single()
  const previewId: string = (row as any).id

  // 5. Start container async (don't await — return previewId immediately)
  bootContainer(db, previewId, port, repoUrl, repoToken, branchName, config, envVars).catch(async (err) => {
    await (db.from('preview_containers') as any)
      .update({ status: 'error', error_message: String(err).slice(0, 500), stopped_at: new Date().toISOString() })
      .eq('id', previewId)
  })

  return { status: 'running', previewId, url: defaultStrategy.getUrl(port) }
}

async function bootContainer(
  db: SupabaseClient,
  previewId: string,
  port: number,
  repoUrl: string,
  repoToken: string,
  branchName: string,
  config: PreviewConfig,
  envVars: Record<string, string>,
): Promise<void> {
  const log = (line: string) => appendLog(db, previewId, line)

  // Start container
  await log('Starting container…')
  const { stdout } = await exec(
    `docker run -d --rm` +
    ` -p ${port}:${config.portInternal}` +
    ` --memory=${config.maxMemoryMb}m` +
    ` --cpu-shares=${config.maxCpuShares}` +
    ` node:20-slim tail -f /dev/null`
  )
  const containerId = stdout.trim()
  await (db.from('preview_containers') as any).update({ container_id: containerId }).eq('id', previewId)

  // Install git
  await log('Installing git…')
  await dockerExec(containerId, 'DEBIAN_FRONTEND=noninteractive apt-get update -qq && apt-get install -y git ca-certificates --no-install-recommends -qq 2>&1')

  // Clone branch
  const authedUrl = repoUrl.replace('https://', `https://oauth2:${repoToken}@`)
  const workDir = `/app/${config.workDir}`.replace('/app/.', '/app')
  await log(`Cloning ${branchName}…`)
  await dockerExec(containerId, `git clone --depth 1 ${authedUrl} /app 2>&1`)
  await dockerExec(containerId, `cd /app && (git fetch --depth 1 origin ${branchName} 2>/dev/null && git checkout ${branchName}) || true`)

  // Write .env
  const envContent = Object.entries(envVars).map(([k, v]) => `${k}=${v}`).join('\n')
  if (envContent) {
    await dockerExec(containerId, `printf '%s' "${envContent.replace(/"/g, '\\"').replace(/\n/g, '\\n')}" > ${workDir}/.env`)
  }

  // Detect package manager from root files
  const { stdout: fileList } = await dockerExec(containerId, `ls /app`).then(out => ({ stdout: out }))
  const files = fileList.split('\n').map(f => f.trim()).filter(Boolean)
  const installCmd = config.installCommand === 'auto' ? detectInstallCommand(files) : config.installCommand

  // Detect start command from package.json scripts
  let startCmd = config.startCommand
  if (startCmd === 'auto') {
    try {
      const { stdout: pkgRaw } = await exec(`docker exec ${containerId} cat ${workDir}/package.json`)
      const pkg = JSON.parse(pkgRaw)
      startCmd = detectStartCommand(pkg.scripts ?? {})
    } catch {
      startCmd = 'npm run dev'
    }
  }

  // Install dependencies
  await log(`Running: ${installCmd}`)
  const installOut = await dockerExec(containerId, `cd ${workDir} && ${installCmd} 2>&1`)
  await log(installOut.slice(-2000))

  // Start app in background
  await log(`Running: ${startCmd}`)
  await dockerExec(containerId, `cd ${workDir} && ${startCmd} > /tmp/app.log 2>&1 &`)

  // Poll health endpoint
  const url = defaultStrategy.getUrl(port)
  const healthUrl = `${url}${config.healthPath}`
  const deadline = Date.now() + STARTUP_TIMEOUT_MS
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))
    try {
      const res = await fetch(healthUrl)
      if (res.ok) {
        if (!config.healthText) {
          await (db.from('preview_containers') as any).update({ status: 'running' }).eq('id', previewId)
          await log('Preview is ready.')
          return
        }
        const text = await res.text()
        if (text.includes(config.healthText)) {
          await (db.from('preview_containers') as any).update({ status: 'running' }).eq('id', previewId)
          await log('Preview is ready.')
          return
        }
      }
    } catch { /* not ready yet */ }
    // Stream app logs
    try {
      const tail = await dockerExec(containerId, 'tail -5 /tmp/app.log 2>/dev/null || true')
      if (tail.trim()) await log(tail.trim())
    } catch { /* ignore */ }
  }
  throw new Error('Preview startup timed out after 90 seconds')
}

export async function stopPreview(db: SupabaseClient, previewId: string): Promise<void> {
  const { data } = await (db.from('preview_containers') as any)
    .select('container_id')
    .eq('id', previewId)
    .single()
  const containerId: string | null = (data as any)?.container_id ?? null
  if (containerId) {
    try { await exec(`docker stop ${containerId}`) } catch { /* already stopped */ }
  }
  await (db.from('preview_containers') as any)
    .update({ status: 'stopped', stopped_at: new Date().toISOString() })
    .eq('id', previewId)
}

export async function getPreviewStatus(db: SupabaseClient, changeId: string): Promise<PreviewStatus> {
  const { data } = await (db.from('preview_containers') as any)
    .select('id, status, port, last_activity_at, startup_log, error_message')
    .eq('change_id', changeId)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!data) {
    return { status: 'none', previewId: null, url: null, port: null, lastActivityAt: null, startupLog: '', errorMessage: null, missingKeys: [] }
  }
  const row = data as any
  return {
    status: row.status,
    previewId: row.id,
    url: row.port ? defaultStrategy.getUrl(row.port) : null,
    port: row.port,
    lastActivityAt: row.last_activity_at,
    startupLog: row.startup_log ?? '',
    errorMessage: row.error_message ?? null,
    missingKeys: [],
  }
}

export async function touchActivity(db: SupabaseClient, previewId: string): Promise<void> {
  await (db.from('preview_containers') as any)
    .update({ last_activity_at: new Date().toISOString() })
    .eq('id', previewId)
}

export async function expireIdle(db: SupabaseClient, projectId: string): Promise<void> {
  const cutoff = new Date(Date.now() - IDLE_TIMEOUT_MS).toISOString()
  const { data: expired } = await (db.from('preview_containers') as any)
    .select('id, container_id')
    .eq('project_id', projectId)
    .eq('status', 'running')
    .lt('last_activity_at', cutoff)

  for (const row of expired ?? []) {
    const r = row as any
    if (r.container_id) {
      try { await exec(`docker stop ${r.container_id}`) } catch { /* ignore */ }
    }
    await (db.from('preview_containers') as any)
      .update({ status: 'stopped', stopped_at: new Date().toISOString() })
      .eq('id', r.id)
  }
}
```

- [ ] **Step 2: Run type check**

```bash
npx tsc --noEmit
```

Expected: no new errors in `lib/preview/`

- [ ] **Step 3: Commit**

```bash
git add lib/preview/preview-manager.ts lib/preview/preview-url.ts
git commit -m "feat: add preview manager — start/stop/status/idle expiry"
```

---

### Task 7: Env var API routes

**Files:**
- Create: `app/api/projects/[id]/env-vars/route.ts`
- Create: `app/api/projects/[id]/env-vars/import/route.ts`

- [ ] **Step 1: Write the env-vars CRUD route**

```typescript
// app/api/projects/[id]/env-vars/route.ts
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { encrypt, decrypt } from '@/lib/preview/crypto'

type Params = { params: Promise<{ id: string }> }

/** GET — return keys only (never values) */
export async function GET(_req: Request, { params }: Params) {
  const { id } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: project } = await db.from('projects').select('id').eq('id', id).eq('owner_id', user.id).single()
  if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const admin = createAdminClient()
  const { data } = await (admin.from('project_env_vars') as any)
    .select('id, key, updated_at')
    .eq('project_id', id)
    .order('key')

  return NextResponse.json(data ?? [])
}

/** POST — upsert a single key/value */
export async function POST(req: Request, { params }: Params) {
  const { id } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: project } = await db.from('projects').select('id').eq('id', id).eq('owner_id', user.id).single()
  if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const body = await req.json()
  const key: string = body.key?.trim()
  const value: string = body.value

  if (!key || typeof value !== 'string') {
    return NextResponse.json({ error: 'key and value are required' }, { status: 400 })
  }

  let value_enc: string
  try {
    value_enc = encrypt(value)
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 })
  }

  const admin = createAdminClient()
  const { error } = await (admin.from('project_env_vars') as any)
    .upsert({ project_id: id, key, value_enc, updated_at: new Date().toISOString() }, { onConflict: 'project_id,key' })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}

/** DELETE — remove a single key */
export async function DELETE(req: Request, { params }: Params) {
  const { id } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: project } = await db.from('projects').select('id').eq('id', id).eq('owner_id', user.id).single()
  if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const { key } = await req.json()
  if (!key) return NextResponse.json({ error: 'key required' }, { status: 400 })

  const admin = createAdminClient()
  await (admin.from('project_env_vars') as any).delete().eq('project_id', id).eq('key', key)

  return NextResponse.json({ ok: true })
}
```

- [ ] **Step 2: Write the import-from-.env.local route**

```typescript
// app/api/projects/[id]/env-vars/import/route.ts
import { NextResponse } from 'next/server'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createClient } from '@/lib/supabase/server'

type Params = { params: Promise<{ id: string }> }

/**
 * POST — reads the host .env.local file and returns parsed key/value pairs.
 * Does NOT store anything. The client reviews and saves explicitly.
 */
export async function POST(_req: Request, { params }: Params) {
  const { id } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: project } = await db.from('projects').select('id').eq('id', id).eq('owner_id', user.id).single()
  if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const envPath = join(process.cwd(), '.env.local')
  let content: string
  try {
    content = await readFile(envPath, 'utf8')
  } catch {
    return NextResponse.json({ error: '.env.local not found' }, { status: 404 })
  }

  const pairs: { key: string; value: string }[] = []
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx < 1) continue
    const key = trimmed.slice(0, eqIdx).trim()
    const value = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '')
    pairs.push({ key, value })
  }

  return NextResponse.json({ pairs })
}
```

- [ ] **Step 3: Commit**

```bash
git add app/api/projects/[id]/env-vars/route.ts app/api/projects/[id]/env-vars/import/route.ts
git commit -m "feat: add env-vars CRUD and .env.local import API routes"
```

---

### Task 8: Preview config API route

**Files:**
- Create: `app/api/projects/[id]/preview-config/route.ts`

- [ ] **Step 1: Write the route**

```typescript
// app/api/projects/[id]/preview-config/route.ts
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

type Params = { params: Promise<{ id: string }> }

const DEFAULTS = {
  install_command: 'auto', start_command: 'auto', work_dir: '.',
  health_path: '/', health_text: null, port_internal: 3000,
  expected_keys: [], max_memory_mb: 1024, max_cpu_shares: 512,
}

export async function GET(_req: Request, { params }: Params) {
  const { id } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: project } = await db.from('projects').select('id').eq('id', id).eq('owner_id', user.id).single()
  if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const admin = createAdminClient()
  const { data } = await (admin.from('project_preview_config') as any)
    .select('*')
    .eq('project_id', id)
    .maybeSingle()

  return NextResponse.json(data ?? { ...DEFAULTS, project_id: id })
}

export async function PUT(req: Request, { params }: Params) {
  const { id } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: project } = await db.from('projects').select('id').eq('id', id).eq('owner_id', user.id).single()
  if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const body = await req.json()
  const payload = {
    project_id: id,
    install_command: body.install_command ?? DEFAULTS.install_command,
    start_command: body.start_command ?? DEFAULTS.start_command,
    work_dir: body.work_dir ?? DEFAULTS.work_dir,
    health_path: body.health_path ?? DEFAULTS.health_path,
    health_text: body.health_text ?? null,
    port_internal: body.port_internal ?? DEFAULTS.port_internal,
    expected_keys: Array.isArray(body.expected_keys) ? body.expected_keys : DEFAULTS.expected_keys,
    max_memory_mb: body.max_memory_mb ?? DEFAULTS.max_memory_mb,
    max_cpu_shares: body.max_cpu_shares ?? DEFAULTS.max_cpu_shares,
    updated_at: new Date().toISOString(),
  }

  const admin = createAdminClient()
  const { error } = await (admin.from('project_preview_config') as any)
    .upsert(payload, { onConflict: 'project_id' })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
```

- [ ] **Step 2: Commit**

```bash
git add app/api/projects/[id]/preview-config/route.ts
git commit -m "feat: add preview config GET/PUT API route"
```

---

### Task 9: Preview start / stop / status / keepalive API routes

**Files:**
- Create: `app/api/change-requests/[id]/preview/start/route.ts`
- Create: `app/api/change-requests/[id]/preview/stop/route.ts`
- Create: `app/api/change-requests/[id]/preview/status/route.ts`
- Create: `app/api/change-requests/[id]/preview/keepalive/route.ts`

Each route: verify auth + ownership, run idle expiry, call preview-manager.

- [ ] **Step 1: Write start route**

```typescript
// app/api/change-requests/[id]/preview/start/route.ts
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { decrypt } from '@/lib/preview/crypto'
import { startPreview, expireIdle } from '@/lib/preview/preview-manager'
import type { PreviewConfig } from '@/lib/preview/preview-manager'

type Params = { params: Promise<{ id: string }> }

export async function POST(req: Request, { params }: Params) {
  const { id: changeId } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const force: boolean = body.force === true

  // Load change + project (ownership check)
  const { data: change } = await db
    .from('change_requests')
    .select('id, project_id, projects!inner(id, owner_id, repo_url, repo_token, name)')
    .eq('id', changeId)
    .eq('projects.owner_id', user.id)
    .single()
  if (!change) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const proj = change.projects as unknown as { id: string; owner_id: string; repo_url: string | null; repo_token: string | null }
  if (!proj.repo_url || !proj.repo_token) {
    return NextResponse.json({ error: 'Repository not configured' }, { status: 422 })
  }

  // Load branch name from latest plan
  const { data: plan } = await db
    .from('change_plans')
    .select('plan_json')
    .eq('change_id', changeId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  const branchName: string = (plan?.plan_json as any)?.branch_name ?? `sf/${changeId.slice(0, 8)}`

  const admin = createAdminClient()

  // Load preview config
  const { data: configRow } = await (admin.from('project_preview_config') as any)
    .select('*')
    .eq('project_id', proj.id)
    .maybeSingle()

  const cfg = configRow as any ?? {}
  const config: PreviewConfig = {
    installCommand: cfg.install_command ?? 'auto',
    startCommand: cfg.start_command ?? 'auto',
    workDir: cfg.work_dir ?? '.',
    healthPath: cfg.health_path ?? '/',
    healthText: cfg.health_text ?? null,
    portInternal: cfg.port_internal ?? 3000,
    expectedKeys: cfg.expected_keys ?? [],
    maxMemoryMb: cfg.max_memory_mb ?? 1024,
    maxCpuShares: cfg.max_cpu_shares ?? 512,
  }

  // Load + decrypt env vars
  const { data: varRows } = await (admin.from('project_env_vars') as any)
    .select('key, value_enc')
    .eq('project_id', proj.id)
  const envVars: Record<string, string> = {}
  for (const row of varRows ?? []) {
    try { envVars[(row as any).key] = decrypt((row as any).value_enc) } catch { /* skip corrupted */ }
  }

  await expireIdle(admin, proj.id)

  const result = await startPreview(admin, changeId, proj.id, proj.repo_url, proj.repo_token, branchName, config, envVars, force)
  return NextResponse.json(result)
}
```

- [ ] **Step 2: Write stop route**

```typescript
// app/api/change-requests/[id]/preview/stop/route.ts
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { stopPreview } from '@/lib/preview/preview-manager'

type Params = { params: Promise<{ id: string }> }

export async function POST(req: Request, { params }: Params) {
  const { id: changeId } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: change } = await db
    .from('change_requests')
    .select('id, projects!inner(owner_id)')
    .eq('id', changeId)
    .eq('projects.owner_id', user.id)
    .single()
  if (!change) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const body = await req.json().catch(() => ({}))
  const { previewId } = body
  if (!previewId) return NextResponse.json({ error: 'previewId required' }, { status: 400 })

  const admin = createAdminClient()
  await stopPreview(admin, previewId)
  return NextResponse.json({ ok: true })
}
```

- [ ] **Step 3: Write status route**

```typescript
// app/api/change-requests/[id]/preview/status/route.ts
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getPreviewStatus, expireIdle } from '@/lib/preview/preview-manager'

type Params = { params: Promise<{ id: string }> }

export async function GET(_req: Request, { params }: Params) {
  const { id: changeId } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: change } = await db
    .from('change_requests')
    .select('id, project_id, projects!inner(owner_id)')
    .eq('id', changeId)
    .eq('projects.owner_id', user.id)
    .single()
  if (!change) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const admin = createAdminClient()
  await expireIdle(admin, change.project_id)
  const status = await getPreviewStatus(admin, changeId)
  return NextResponse.json(status)
}
```

- [ ] **Step 4: Write keepalive route**

```typescript
// app/api/change-requests/[id]/preview/keepalive/route.ts
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { touchActivity, expireIdle } from '@/lib/preview/preview-manager'

type Params = { params: Promise<{ id: string }> }

export async function POST(req: Request, { params }: Params) {
  const { id: changeId } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: change } = await db
    .from('change_requests')
    .select('id, project_id, projects!inner(owner_id)')
    .eq('id', changeId)
    .eq('projects.owner_id', user.id)
    .single()
  if (!change) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const body = await req.json().catch(() => ({}))
  const { previewId } = body
  if (!previewId) return NextResponse.json({ error: 'previewId required' }, { status: 400 })

  const admin = createAdminClient()
  await expireIdle(admin, change.project_id)
  await touchActivity(admin, previewId)
  return NextResponse.json({ ok: true })
}
```

- [ ] **Step 5: Run type check**

```bash
npx tsc --noEmit
```

Expected: no new errors

- [ ] **Step 6: Commit**

```bash
git add app/api/change-requests/[id]/preview/
git commit -m "feat: add preview start/stop/status/keepalive API routes"
```

---

### Task 10: Settings UI — Preview sections

**Files:**
- Modify: `app/projects/[id]/settings/project-settings-view.tsx`
- Modify: `app/projects/[id]/settings/page.tsx`

The settings page already has a section-based nav. Add two new sections: `'env-vars'` (list + add + import) and `'preview-config'` (form fields).

- [ ] **Step 1: Update `page.tsx` to fetch env var keys and preview config**

In `app/projects/[id]/settings/page.tsx`, add after the existing queries (before the `return`):

```typescript
  // Preview: env var keys (not values) + config
  const { data: envVarRows } = await db
    .from('project_env_vars' as any)
    .select('id, key, updated_at')
    .eq('project_id', id)
    .order('key') as any

  const { data: previewConfigRow } = await db
    .from('project_preview_config' as any)
    .select('*')
    .eq('project_id', id)
    .maybeSingle() as any

  const envVarKeys: { id: string; key: string; updated_at: string }[] = envVarRows ?? []
  const previewConfig = previewConfigRow ?? {
    install_command: 'auto', start_command: 'auto', work_dir: '.',
    health_path: '/', health_text: '', port_internal: 3000,
    expected_keys: [], max_memory_mb: 1024, max_cpu_shares: 512,
  }
```

And update the `<ProjectSettingsView>` call to pass these props:

```typescript
  return (
    <ProjectSettingsView
      project={{ ...project, project_settings } as any}
      modelHealth={modelHealth}
      dangerStats={dangerStats}
      envVarKeys={envVarKeys}
      previewConfig={previewConfig as any}
    />
  )
```

- [ ] **Step 2: Add the two sections to `project-settings-view.tsx`**

Add `'env-vars'` and `'preview-config'` to the `SectionId` type and `SECTIONS` array:

```typescript
// After 'automation' in the SectionId type:
type SectionId =
  | 'general' | 'repository' | 'execution' | 'risk-policy'
  | 'scan-model' | 'test-strategy' | 'exec-environment'
  | 'notifications' | 'automation' | 'env-vars' | 'preview-config'
  | 'model-health' | 'danger-zone'
```

Add to `SECTIONS` array (after `automation`):
```typescript
  { id: 'env-vars',       label: 'Env Vars' },
  { id: 'preview-config', label: 'Preview' },
```

- [ ] **Step 3: Add props to `ProjectSettingsView`**

Update the component signature:

```typescript
export function ProjectSettingsView({
  project: initial, modelHealth, dangerStats, envVarKeys: initialEnvVarKeys, previewConfig: initialPreviewConfig,
}: {
  project: Project
  modelHealth: ModelHealth
  dangerStats: DangerStats
  envVarKeys: { id: string; key: string; updated_at: string }[]
  previewConfig: {
    install_command: string; start_command: string; work_dir: string
    health_path: string; health_text: string | null; port_internal: number
    expected_keys: string[]; max_memory_mb: number; max_cpu_shares: number
  }
}) {
```

Add state for both:

```typescript
  const [envVarKeys, setEnvVarKeys] = useState(initialEnvVarKeys)
  const [newVarKey, setNewVarKey] = useState('')
  const [newVarValue, setNewVarValue] = useState('')
  const [addingVar, setAddingVar] = useState(false)
  const [varError, setVarError] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)

  const [previewCfg, setPreviewCfg] = useState(initialPreviewConfig)
  const [savingPreview, setSavingPreview] = useState(false)
  const [previewSaveError, setPreviewSaveError] = useState<string | null>(null)
  const [previewSaveSuccess, setPreviewSaveSuccess] = useState(false)
```

- [ ] **Step 4: Add env-vars section JSX**

Add inside the `<form>` (after the `automation` section):

```tsx
{activeSection === 'env-vars' && (
  <>
    <div className={sectionClass}>
      <SectionTitle>Environment Variables</SectionTitle>
      <p className="text-xs text-slate-500">Injected into preview containers. Values are encrypted at rest and never exposed to the browser.</p>

      {/* Key list */}
      {envVarKeys.length > 0 && (
        <div className="divide-y divide-white/5 rounded-lg overflow-hidden border border-white/10">
          {envVarKeys.map(v => (
            <div key={v.id} className="flex items-center justify-between px-3 py-2.5 bg-[#0f1929]">
              <span className="text-xs font-mono text-slate-300">{v.key}</span>
              <button
                type="button"
                onClick={async () => {
                  await fetch(`/api/projects/${project.id}/env-vars`, {
                    method: 'DELETE', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ key: v.key }),
                  })
                  setEnvVarKeys(ks => ks.filter(k => k.id !== v.id))
                }}
                className="text-slate-600 hover:text-red-400 transition-colors"
              >
                <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>delete</span>
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Add var form */}
      <div className="flex gap-2 items-end">
        <div className="flex-1">
          <label className={`${labelClass} block mb-1`}>Key</label>
          <input value={newVarKey} onChange={e => setNewVarKey(e.target.value)} placeholder="DATABASE_URL" className={inputClass} />
        </div>
        <div className="flex-1">
          <label className={`${labelClass} block mb-1`}>Value</label>
          <input type="password" value={newVarValue} onChange={e => setNewVarValue(e.target.value)} placeholder="••••••••" className={inputClass} />
        </div>
        <button
          type="button"
          disabled={!newVarKey.trim() || addingVar}
          onClick={async () => {
            setAddingVar(true)
            setVarError(null)
            try {
              const res = await fetch(`/api/projects/${project.id}/env-vars`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ key: newVarKey.trim(), value: newVarValue }),
              })
              if (!res.ok) { setVarError((await res.json()).error ?? 'Failed'); return }
              setEnvVarKeys(ks => [...ks.filter(k => k.key !== newVarKey.trim()), { id: Date.now().toString(), key: newVarKey.trim(), updated_at: new Date().toISOString() }])
              setNewVarKey(''); setNewVarValue('')
            } finally { setAddingVar(false) }
          }}
          className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold transition-colors disabled:opacity-50 whitespace-nowrap"
        >
          {addingVar ? 'Adding…' : 'Add'}
        </button>
      </div>
      {varError && <p className="text-xs text-red-400">{varError}</p>}

      {/* Import from .env.local */}
      <div className="pt-2 border-t border-white/5">
        <button
          type="button"
          disabled={importing}
          onClick={async () => {
            setImporting(true)
            try {
              const res = await fetch(`/api/projects/${project.id}/env-vars/import`, { method: 'POST' })
              if (!res.ok) { alert((await res.json()).error ?? 'Import failed'); return }
              const { pairs } = await res.json()
              for (const { key, value } of pairs) {
                await fetch(`/api/projects/${project.id}/env-vars`, {
                  method: 'POST', headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ key, value }),
                })
              }
              const listRes = await fetch(`/api/projects/${project.id}/env-vars`)
              setEnvVarKeys(await listRes.json())
            } finally { setImporting(false) }
          }}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-[#0f1929] border border-white/10 hover:border-white/20 text-slate-300 transition-colors disabled:opacity-50"
        >
          <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>upload_file</span>
          {importing ? 'Importing…' : 'Import from .env.local'}
        </button>
        <p className="text-[11px] text-slate-600 mt-1.5">Reads your local .env.local and saves all key/value pairs above. Review before importing.</p>
      </div>

      {/* Expected keys */}
      <div className="pt-2 border-t border-white/5">
        <label className={`${labelClass} block mb-1.5`}>Expected keys <span className="font-normal normal-case tracking-normal text-slate-500">(comma-separated)</span></label>
        <input
          value={previewCfg.expected_keys.join(', ')}
          onChange={e => setPreviewCfg(c => ({ ...c, expected_keys: e.target.value.split(',').map(s => s.trim()).filter(Boolean) }))}
          placeholder="DATABASE_URL, NEXTAUTH_SECRET"
          className={inputClass}
        />
        <p className="text-[11px] text-slate-600 mt-1.5">Keys listed here trigger a warning at launch if not saved above.</p>
      </div>
    </div>
  </>
)}
```

- [ ] **Step 5: Add preview-config section JSX**

Add after the env-vars section (still inside the `<form>`):

```tsx
{activeSection === 'preview-config' && (
  <>
    <div className={sectionClass}>
      <SectionTitle>Preview Configuration</SectionTitle>
      <p className="text-xs text-slate-500">Controls how preview containers are started. Use "auto" to detect from the repo.</p>

      <Row label="Install command" hint="auto detects from lockfile (pnpm/yarn/bun/npm)">
        <input value={previewCfg.install_command} onChange={e => setPreviewCfg(c => ({ ...c, install_command: e.target.value }))}
          placeholder="auto" className={`${inputClass} w-56`} />
      </Row>
      <Row label="Start command" hint="auto detects from package.json scripts">
        <input value={previewCfg.start_command} onChange={e => setPreviewCfg(c => ({ ...c, start_command: e.target.value }))}
          placeholder="auto" className={`${inputClass} w-56`} />
      </Row>
      <Row label="Working directory" hint="Relative path for monorepos">
        <input value={previewCfg.work_dir} onChange={e => setPreviewCfg(c => ({ ...c, work_dir: e.target.value }))}
          placeholder="." className={`${inputClass} w-40`} />
      </Row>
      <Row label="Health check path" hint="URL path polled to detect when app is ready">
        <input value={previewCfg.health_path} onChange={e => setPreviewCfg(c => ({ ...c, health_path: e.target.value }))}
          placeholder="/" className={`${inputClass} w-40`} />
      </Row>
      <Row label="Health check text" hint="Optional: response body must contain this string">
        <input value={previewCfg.health_text ?? ''} onChange={e => setPreviewCfg(c => ({ ...c, health_text: e.target.value || null }))}
          placeholder="(any 200 response)" className={`${inputClass} w-56`} />
      </Row>
      <Row label="App port (inside container)">
        <div className="flex items-center gap-2">
          <input type="number" value={previewCfg.port_internal} onChange={e => setPreviewCfg(c => ({ ...c, port_internal: Number(e.target.value) }))}
            className={numberInputClass} />
        </div>
      </Row>
      <Row label="Max memory" hint="Container memory limit">
        <div className="flex items-center gap-2">
          <input type="number" min={256} max={8192} step={256} value={previewCfg.max_memory_mb}
            onChange={e => setPreviewCfg(c => ({ ...c, max_memory_mb: Number(e.target.value) }))} className={numberInputClass} />
          <span className="text-xs text-slate-500">MB</span>
        </div>
      </Row>
      <Row label="CPU shares" hint="512 ≈ ½ core, 1024 ≈ 1 core">
        <input type="number" min={128} max={4096} step={128} value={previewCfg.max_cpu_shares}
          onChange={e => setPreviewCfg(c => ({ ...c, max_cpu_shares: Number(e.target.value) }))} className={numberInputClass} />
      </Row>
    </div>

    <div className="flex items-center gap-3 pt-2">
      <button
        type="button"
        disabled={savingPreview}
        onClick={async () => {
          setSavingPreview(true); setPreviewSaveError(null); setPreviewSaveSuccess(false)
          try {
            const res = await fetch(`/api/projects/${project.id}/preview-config`, {
              method: 'PUT', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(previewCfg),
            })
            if (!res.ok) { setPreviewSaveError((await res.json()).error ?? 'Save failed'); return }
            setPreviewSaveSuccess(true)
          } finally { setSavingPreview(false) }
        }}
        className="px-5 py-2 rounded-lg text-sm font-semibold bg-indigo-600 hover:bg-indigo-500 text-white transition-all disabled:opacity-50"
      >
        {savingPreview ? 'Saving…' : 'Save preview config'}
      </button>
      {previewSaveSuccess && <span className="text-xs text-emerald-400 font-medium">Saved</span>}
      {previewSaveError && <span className="text-xs text-red-400">{previewSaveError}</span>}
    </div>
  </>
)}
```

- [ ] **Step 6: Run type check**

```bash
npx tsc --noEmit
```

Expected: no new errors in settings files

- [ ] **Step 7: Commit**

```bash
git add app/projects/[id]/settings/
git commit -m "feat: add Env Vars and Preview Config sections to project settings"
```

---

### Task 11: PreviewPanel component

**Files:**
- Create: `components/preview/PreviewPanel.tsx`

This client component manages the full state machine on the review page: idle → starting → running/error, keepalive loop, missing vars modal, startup log.

- [ ] **Step 1: Write the component**

```tsx
// components/preview/PreviewPanel.tsx
'use client'
import { useState, useEffect, useRef, useCallback } from 'react'

type PreviewStatus =
  | 'none' | 'starting' | 'running' | 'stopped' | 'error'

interface StatusPayload {
  status: PreviewStatus
  previewId: string | null
  url: string | null
  startupLog: string
  errorMessage: string | null
  missingKeys: string[]
}

export function PreviewPanel({ changeId }: { changeId: string }) {
  const [status, setStatus] = useState<PreviewStatus>('none')
  const [previewId, setPreviewId] = useState<string | null>(null)
  const [url, setUrl] = useState<string | null>(null)
  const [startupLog, setStartupLog] = useState('')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [missingKeys, setMissingKeys] = useState<string[]>([])
  const [showLog, setShowLog] = useState(false)
  const [loading, setLoading] = useState(false)
  const [showMissingModal, setShowMissingModal] = useState(false)

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const keepaliveRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const stopPolling = () => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
  }
  const stopKeepalive = () => {
    if (keepaliveRef.current) { clearInterval(keepaliveRef.current); keepaliveRef.current = null }
  }

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch(`/api/change-requests/${changeId}/preview/status`)
      if (!res.ok) return
      const data: StatusPayload = await res.json()
      setStatus(data.status)
      setPreviewId(data.previewId)
      setUrl(data.url)
      setStartupLog(data.startupLog)
      setErrorMessage(data.errorMessage)
      if (data.status === 'running' || data.status === 'stopped' || data.status === 'error') {
        stopPolling()
        if (data.status !== 'running') stopKeepalive()
      }
    } catch { /* ignore network errors during polling */ }
  }, [changeId])

  // Load initial status on mount
  useEffect(() => {
    fetchStatus()
  }, [fetchStatus])

  // Start keepalive loop when running
  useEffect(() => {
    if (status === 'running' && previewId) {
      stopKeepalive()
      keepaliveRef.current = setInterval(async () => {
        await fetch(`/api/change-requests/${changeId}/preview/keepalive`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ previewId }),
        })
      }, 60_000)
    } else {
      stopKeepalive()
    }
    return stopKeepalive
  }, [status, previewId, changeId])

  useEffect(() => () => { stopPolling(); stopKeepalive() }, [])

  async function launch(force = false) {
    setLoading(true)
    setErrorMessage(null)
    setStartupLog('')
    setShowMissingModal(false)
    try {
      const res = await fetch(`/api/change-requests/${changeId}/preview/start`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force }),
      })
      const data = await res.json()
      if (data.status === 'needs_config') {
        setMissingKeys(data.missingKeys ?? [])
        setShowMissingModal(true)
        return
      }
      if (data.status === 'max_previews_reached' || data.status === 'port_exhausted') {
        setErrorMessage(data.errorMessage ?? data.status)
        setStatus('error')
        return
      }
      setPreviewId(data.previewId ?? null)
      setUrl(data.url ?? null)
      setStatus('starting')
      // Poll every 2 s until running/error
      stopPolling()
      pollRef.current = setInterval(fetchStatus, 2000)
    } finally {
      setLoading(false)
    }
  }

  async function stop() {
    if (!previewId) return
    setLoading(true)
    try {
      await fetch(`/api/change-requests/${changeId}/preview/stop`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ previewId }),
      })
      setStatus('stopped')
      stopPolling(); stopKeepalive()
    } finally { setLoading(false) }
  }

  const logPanel = (startupLog || status === 'starting' || status === 'error') && (
    <div className="mt-2">
      <button type="button" onClick={() => setShowLog(v => !v)}
        className="text-[11px] text-slate-500 hover:text-slate-300 transition-colors flex items-center gap-1">
        <span className="material-symbols-outlined" style={{ fontSize: '13px' }}>
          {showLog ? 'expand_less' : 'expand_more'}
        </span>
        {showLog ? 'Hide' : 'View'} startup log
      </button>
      {showLog && (
        <div className="mt-1.5 rounded-lg bg-[#0a0f1a] border border-white/10 p-3 max-h-64 overflow-y-auto">
          <pre className="text-[10px] font-mono text-slate-400 whitespace-pre-wrap break-all">
            {startupLog || '(waiting for output…)'}
          </pre>
          <button onClick={() => navigator.clipboard.writeText(startupLog)}
            className="mt-2 text-[10px] text-slate-600 hover:text-slate-400 transition-colors">
            Copy
          </button>
        </div>
      )}
    </div>
  )

  // Missing vars modal
  const missingModal = showMissingModal && (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="rounded-xl bg-[#131b2e] border border-white/10 p-6 max-w-sm w-full mx-4 space-y-4">
        <h3 className="text-sm font-bold text-slate-200">Missing environment variables</h3>
        <p className="text-xs text-slate-400">
          The following expected keys are not saved in project settings:
        </p>
        <ul className="space-y-1">
          {missingKeys.map(k => (
            <li key={k} className="text-xs font-mono text-amber-400 flex items-center gap-1.5">
              <span className="material-symbols-outlined text-amber-500" style={{ fontSize: '13px' }}>warning</span>
              {k}
            </li>
          ))}
        </ul>
        <div className="flex gap-2 flex-wrap pt-2">
          <button onClick={() => launch(true)}
            className="px-4 py-2 rounded-lg text-xs font-semibold bg-slate-700 hover:bg-slate-600 text-slate-200 transition-colors">
            Continue anyway
          </button>
          <button onClick={() => setShowMissingModal(false)}
            className="px-4 py-2 rounded-lg text-xs font-semibold bg-[#0f1929] border border-white/10 text-slate-400 hover:text-slate-200 transition-colors">
            Cancel
          </button>
        </div>
      </div>
    </div>
  )

  if (status === 'none' || status === 'stopped') {
    return (
      <>
        {missingModal}
        <button onClick={() => launch()} disabled={loading}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-sm font-bold font-headline transition-colors">
          <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>play_arrow</span>
          {loading ? 'Launching…' : 'Launch Preview'}
        </button>
        {errorMessage && <p className="text-xs text-red-400 mt-1">{errorMessage}</p>}
      </>
    )
  }

  if (status === 'starting') {
    return (
      <div className="space-y-1">
        <div className="flex items-center gap-2 text-sm text-slate-400">
          <span className="animate-spin material-symbols-outlined text-indigo-400" style={{ fontSize: '16px' }}>progress_activity</span>
          Starting preview…
        </div>
        {logPanel}
      </div>
    )
  }

  if (status === 'running' && url) {
    return (
      <div className="space-y-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="h-2 w-2 rounded-full bg-emerald-400 flex-shrink-0" />
          <a href={url} target="_blank" rel="noreferrer"
            className="text-sm font-mono text-emerald-400 hover:text-emerald-300 underline underline-offset-2 truncate max-w-[200px]">
            {url}
          </a>
          <a href={url} target="_blank" rel="noreferrer"
            className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold transition-colors">
            <span className="material-symbols-outlined" style={{ fontSize: '13px' }}>open_in_new</span>
            Open
          </a>
          <button onClick={() => { stop().then(() => launch()) }} disabled={loading}
            className="px-3 py-1.5 rounded-lg bg-[#0f1929] border border-white/10 hover:border-white/20 text-slate-300 text-xs font-semibold transition-colors disabled:opacity-50">
            Restart
          </button>
          <button onClick={stop} disabled={loading}
            className="px-3 py-1.5 rounded-lg bg-[#0f1929] border border-white/10 hover:border-white/20 text-slate-300 text-xs font-semibold transition-colors disabled:opacity-50">
            Stop
          </button>
        </div>
        {logPanel}
      </div>
    )
  }

  if (status === 'error') {
    return (
      <>
        {missingModal}
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-red-400 flex-shrink-0" />
            <span className="text-sm text-red-400">{errorMessage ?? 'Preview failed to start'}</span>
            <button onClick={() => launch()} disabled={loading}
              className="px-3 py-1.5 rounded-lg bg-[#0f1929] border border-white/10 text-slate-300 text-xs font-semibold hover:border-white/20 transition-colors disabled:opacity-50">
              {loading ? 'Retrying…' : 'Retry'}
            </button>
          </div>
          {logPanel}
        </div>
      </>
    )
  }

  return null
}
```

- [ ] **Step 2: Run type check**

```bash
npx tsc --noEmit
```

Expected: no new errors in `components/preview/`

- [ ] **Step 3: Commit**

```bash
git add components/preview/PreviewPanel.tsx
git commit -m "feat: add PreviewPanel component with state machine and keepalive"
```

---

### Task 12: Wire PreviewPanel into review page

**Files:**
- Modify: `app/projects/[id]/changes/[changeId]/review/review-view.tsx`

- [ ] **Step 1: Import and add PreviewPanel to the action bar**

In `review-view.tsx`, add the import at the top:

```typescript
import { PreviewPanel } from '@/components/preview/PreviewPanel'
```

Find the action bar `<div className="rounded-xl bg-[#131b2e] border border-white/5 p-5 ...">` and add `PreviewPanel` above the existing button row:

```tsx
{/* Action bar */}
<div className="rounded-xl bg-[#131b2e] border border-white/5 p-5 space-y-4">
  {/* Preview */}
  <div>
    <p className="text-[10px] uppercase tracking-widest text-slate-500 font-headline mb-2">Preview</p>
    <PreviewPanel changeId={change.id} />
  </div>

  <div className="border-t border-white/5 pt-4 flex items-center justify-between gap-4">
    <div>
      <p className="text-sm font-semibold text-slate-200">Ready to approve?</p>
      <p className="text-xs text-slate-500 mt-0.5">Approving marks this change as done. The branch stays open for manual merge.</p>
    </div>
    <div className="flex items-center gap-2 flex-shrink-0">
      {/* existing delete confirm + Re-run + Approve buttons unchanged */}
      ...
    </div>
  </div>
</div>
```

The existing delete/approve buttons stay exactly as they are — just wrapped in the new layout.

- [ ] **Step 2: Run full test suite and type check**

```bash
npm run test && npx tsc --noEmit
```

Expected: existing tests pass, no type errors

- [ ] **Step 3: Start dev server and verify the review page**

```bash
npm run dev
```

Open a change in `review` status. Verify:
- "Launch Preview" button appears in the action bar
- Clicking it calls `POST /api/change-requests/[id]/preview/start`
- If Docker is running and repo is configured, the container starts and the spinner appears
- Once ready, a green URL chip + Open/Stop/Restart buttons appear
- Startup log is collapsible

- [ ] **Step 4: Commit**

```bash
git add app/projects/[id]/changes/[changeId]/review/review-view.tsx
git commit -m "feat: integrate PreviewPanel into change review page"
```

---

## Summary

After all tasks are complete, the feature provides:

1. **Settings → Env Vars** — add/delete env vars (encrypted), import from `.env.local`, set expected key list
2. **Settings → Preview** — configure install/start commands, health check, resource limits
3. **Review page** — Launch Preview button → Docker container starts → browser tab opens → keepalive pings every 60s → auto-stop after 20 min idle → startup log visible at any time
