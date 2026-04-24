// app/api/change-requests/[id]/preview/start/route.ts
import { NextResponse } from 'next/server'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
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
    expectedKeys: [],
    maxMemoryMb: cfg.max_memory_mb ?? 1024,
    maxCpuShares: cfg.max_cpu_shares ?? 512,
  }

  // Load env vars from .env.local on the host
  const envVars: Record<string, string> = {}
  try {
    const content = await readFile(join(process.cwd(), '.env.local'), 'utf8')
    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eqIdx = trimmed.indexOf('=')
      if (eqIdx < 1) continue
      const key = trimmed.slice(0, eqIdx).trim()
      const value = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '')
      envVars[key] = value
    }
  } catch { /* .env.local missing — start without env vars */ }

  await expireIdle(admin, proj.id)

  const result = await startPreview(admin, changeId, proj.id, proj.repo_url, proj.repo_token, branchName, config, envVars, force)

  if (result.status === 'needs_config') return NextResponse.json(result, { status: 422 })
  if (result.status === 'max_previews_reached') return NextResponse.json(result, { status: 503 })
  if (result.status === 'port_exhausted') return NextResponse.json(result, { status: 503 })
  if (result.status === 'error') return NextResponse.json(result, { status: 500 })
  return NextResponse.json(result)
}
