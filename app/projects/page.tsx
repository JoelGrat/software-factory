import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import Link from 'next/link'
import { CreateProjectForm } from '@/components/projects/create-project-form'
import { ProjectList } from '@/components/projects/project-list'
import { LeftNav } from '@/components/app/left-nav'
import { ProfileAvatar } from '@/components/app/profile-avatar'

export default async function ProjectsPage() {
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) redirect('/login')

  const { data: rawProjects } = await db
    .from('projects')
    .select('id, name, scan_status, created_at')
    .eq('owner_id', user.id)
    .order('created_at', { ascending: false })

  const projects = rawProjects ?? []
  const projectIds = projects.map(p => p.id)

  if (projectIds.length === 0) {
    return renderPage([])
  }

  // Parallel: components + changes for all projects
  const [{ data: compRows }, { data: changeRows }] = await Promise.all([
    db.from('system_components')
      .select('id, project_id, status')
      .in('project_id', projectIds)
      .is('deleted_at', null),
    db.from('change_requests')
      .select('project_id, status, risk_level, updated_at, created_at')
      .in('project_id', projectIds),
  ])

  // Confidence via component IDs
  const compIdList = (compRows ?? []).map(c => c.id)
  const { data: confRows } = compIdList.length > 0
    ? await db.from('component_assignment')
        .select('component_id, confidence')
        .in('component_id', compIdList)
        .eq('is_primary', true)
    : { data: [] }

  // Component ID → project ID lookup
  const compToProject: Record<string, string> = {}
  for (const c of compRows ?? []) compToProject[c.id] = c.project_id

  // Aggregate component stats per project
  type CompStats = { componentCount: number; unstableCount: number; confTotal: number; confN: number; lowConfCount: number }
  const compStats: Record<string, CompStats> = {}
  for (const pid of projectIds) compStats[pid] = { componentCount: 0, unstableCount: 0, confTotal: 0, confN: 0, lowConfCount: 0 }
  for (const c of compRows ?? []) {
    compStats[c.project_id].componentCount++
    if (c.status === 'unstable') compStats[c.project_id].unstableCount++
  }
  for (const r of confRows ?? []) {
    const pid = compToProject[r.component_id]
    if (pid && compStats[pid]) {
      const conf = (r as any).confidence as number
      compStats[pid].confTotal += conf
      compStats[pid].confN++
      if (conf < 40) compStats[pid].lowConfCount++
    }
  }

  // Aggregate change stats per project
  type ChangeStats = { open: number; failed: number; highRisk: number; lastActivity: string | null }
  const changeStats: Record<string, ChangeStats> = {}
  for (const pid of projectIds) changeStats[pid] = { open: 0, failed: 0, highRisk: 0, lastActivity: null }
  const TERMINAL = new Set(['done', 'failed'])
  for (const c of changeRows ?? []) {
    const cs = changeStats[c.project_id]
    if (!cs) continue
    if (!TERMINAL.has(c.status)) cs.open++
    if (c.status === 'failed') cs.failed++
    if (c.risk_level === 'high') cs.highRisk++
    const ts = c.updated_at ?? c.created_at
    if (!cs.lastActivity || ts > cs.lastActivity) cs.lastActivity = ts
  }

  function deriveHealth(
    scanStatus: string,
    cs: CompStats,
    chg: ChangeStats,
  ): 'critical' | 'warning' | 'healthy' | 'empty' {
    if (scanStatus === 'failed' || chg.failed > 0) return 'critical'
    if (cs.unstableCount > 0 || chg.highRisk > 0) return 'warning'
    if (cs.componentCount === 0 && chg.open === 0) return 'empty'
    return 'healthy'
  }

  function deriveModelQuality(cs: CompStats): 'HIGH' | 'MEDIUM' | 'LOW' | null {
    if (cs.componentCount === 0 || cs.confN === 0) return null
    // Match dashboard logic: ratio of low-confidence components (< 40%) determines quality
    const lowRatio = cs.lowConfCount / cs.componentCount
    if (lowRatio > 0.3) return 'MEDIUM'
    return 'HIGH'
  }

  const HEALTH_ORDER = { critical: 0, warning: 1, healthy: 2, empty: 3 }

  const enriched = projects
    .map(p => {
      const cs = compStats[p.id]
      const chg = changeStats[p.id]
      return {
        id: p.id,
        name: p.name,
        scan_status: p.scan_status,
        created_at: p.created_at,
        componentCount: cs.componentCount,
        unstableCount: cs.unstableCount,
        openChanges: chg.open,
        failedChanges: chg.failed,
        highRiskChanges: chg.highRisk,
        lastActivity: chg.lastActivity,
        avgConfidence: cs.confN > 0 ? Math.round(cs.confTotal / cs.confN) : 0,
        health: deriveHealth(p.scan_status, cs, chg),
        modelQuality: deriveModelQuality(cs),
      } as const
    })
    .sort((a, b) => {
      const diff = HEALTH_ORDER[a.health] - HEALTH_ORDER[b.health]
      if (diff !== 0) return diff
      const aTime = a.lastActivity ?? a.created_at
      const bTime = b.lastActivity ?? b.created_at
      return bTime.localeCompare(aTime)
    })

  return renderPage(enriched)
}

type EnrichedProject = {
  id: string; name: string; scan_status: string; created_at: string
  componentCount: number; unstableCount: number; openChanges: number
  failedChanges: number; highRiskChanges: number; lastActivity: string | null
  avgConfidence: number; health: 'critical' | 'warning' | 'healthy' | 'empty'
  modelQuality: 'HIGH' | 'MEDIUM' | 'LOW' | null
}

function renderPage(projects: EnrichedProject[]) {
  return (
    <div className="flex flex-col h-screen bg-[#0b1326] text-on-surface overflow-hidden">
      <header className="w-full h-16 flex-shrink-0 flex items-center justify-between px-6 bg-[#0b1326] border-b border-white/5 z-50 font-headline antialiased tracking-tight">
        <span className="text-xl font-bold text-indigo-400 tracking-tighter">FactoryOS</span>
        <div className="flex items-center gap-1">
          <Link href="/settings" className="p-2 text-slate-400 hover:text-slate-200 hover:bg-[#171f33] rounded-lg transition-all" title="Settings">
            <span className="material-symbols-outlined" style={{ fontSize: '20px' }}>settings</span>
          </Link>
          <div className="w-px h-5 bg-white/10 mx-1" />
          <ProfileAvatar />
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        <LeftNav />
        <main className="flex-1 overflow-y-auto bg-[#0b1326] p-10">
          <div className="max-w-3xl mx-auto">
            <div className="flex items-center justify-between mb-10">
              <div>
                <p className="text-xs uppercase tracking-widest font-bold text-indigo-400 font-headline mb-1">Software Factory</p>
                <h1 className="text-3xl font-extrabold font-headline tracking-tight text-on-surface">Projects</h1>
              </div>
              <CreateProjectForm />
            </div>
            <ProjectList projects={projects} />
          </div>
        </main>
      </div>
    </div>
  )
}
