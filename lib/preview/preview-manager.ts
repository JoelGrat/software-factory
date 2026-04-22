import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import type { SupabaseClient } from '@supabase/supabase-js'
import { allocatePort, cleanupOrphans } from './port-manager'
import { detectInstallCommand, detectStartCommand } from './package-detector'
import { defaultStrategy } from './preview-url'

const execFile = promisify(execFileCb)

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
  const { stdout, stderr } = await execFile('docker', ['exec', containerId, 'sh', '-c', command])
  return stdout + stderr
}

async function appendLog(db: SupabaseClient, previewId: string, line: string): Promise<void> {
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
  const { stdout } = await execFile('docker', [
    'run', '-d', '--rm',
    `-p`, `${port}:${config.portInternal}`,
    `--memory=${config.maxMemoryMb}m`,
    `--cpu-shares=${config.maxCpuShares}`,
    'node:20-slim', 'tail', '-f', '/dev/null',
  ])
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
  const fileList = await dockerExec(containerId, 'ls /app')
  const files = fileList.split('\n').map(f => f.trim()).filter(Boolean)
  const installCmd = config.installCommand === 'auto' ? detectInstallCommand(files) : config.installCommand

  // Detect start command from package.json scripts
  let startCmd = config.startCommand
  if (startCmd === 'auto') {
    try {
      const pkgRaw = await dockerExec(containerId, `cat ${workDir}/package.json`)
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
    try { await execFile('docker', ['stop', containerId]) } catch { /* already stopped */ }
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
      try { await execFile('docker', ['stop', r.container_id]) } catch { /* ignore */ }
    }
    await (db.from('preview_containers') as any)
      .update({ status: 'stopped', stopped_at: new Date().toISOString() })
      .eq('id', r.id)
  }
}
