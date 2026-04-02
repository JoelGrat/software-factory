'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { LeftNav } from '@/components/app/left-nav'
import { ProfileAvatar } from '@/components/app/profile-avatar'
import type { ScanProgress, ScanMilestone } from '@/lib/scanner/scanner'

interface Project {
  id: string
  name: string
  scan_status: string
  scan_error: string | null
  scan_progress: ScanProgress | null
  repo_url: string | null
  created_at: string
}

interface Stats {
  fileCount: number
  componentCount: number
  edgeCount: number
  lowConfidenceCount: number
}

interface TopComponent {
  id: string
  name: string
  type: string
  status: string
  is_anchored: boolean
}

interface Change {
  id: string
  title: string
  type: string
  priority: string
  status: string
  risk_level: string | null
  created_at: string
  updated_at: string
}

const TYPE_COLORS: Record<string, string> = {
  bug: 'text-red-400 bg-red-400/10',
  feature: 'text-indigo-400 bg-indigo-400/10',
  refactor: 'text-amber-400 bg-amber-400/10',
  hotfix: 'text-orange-400 bg-orange-400/10',
}
const RISK_COLORS: Record<string, string> = {
  low: 'text-green-400 bg-green-400/10',
  medium: 'text-amber-400 bg-amber-400/10',
  high: 'text-red-400 bg-red-400/10',
}
const STATUS_COLORS: Record<string, string> = {
  open: 'text-slate-400 bg-slate-400/10',
  analyzing: 'text-indigo-400 bg-indigo-400/10',
  analyzing_mapping: 'text-indigo-400 bg-indigo-400/10',
  analyzing_propagation: 'text-indigo-400 bg-indigo-400/10',
  analyzing_scoring: 'text-indigo-400 bg-indigo-400/10',
  analyzed: 'text-blue-400 bg-blue-400/10',
  planned: 'text-purple-400 bg-purple-400/10',
  executing: 'text-amber-400 bg-amber-400/10',
  review: 'text-orange-400 bg-orange-400/10',
  done: 'text-green-400 bg-green-400/10',
  failed: 'text-red-400 bg-red-400/10',
}
const COMPONENT_TYPE_COLORS: Record<string, string> = {
  api: 'text-indigo-400 bg-indigo-400/10',
  service: 'text-blue-400 bg-blue-400/10',
  db: 'text-emerald-400 bg-emerald-400/10',
  ui: 'text-purple-400 bg-purple-400/10',
  module: 'text-slate-400 bg-slate-400/10',
}

function Badge({ label, colorClass }: { label: string; colorClass: string }) {
  return (
    <span className={`text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded font-mono ${colorClass}`}>
      {label}
    </span>
  )
}

function MilestoneRow({ milestone }: { milestone: ScanMilestone }) {
  return (
    <div className="flex items-start gap-3">
      <div className="flex-shrink-0 w-4 mt-0.5">
        {milestone.status === 'done' && (
          <span className="material-symbols-outlined text-green-400" style={{ fontSize: '14px' }}>check_circle</span>
        )}
        {milestone.status === 'active' && (
          <span className="relative flex h-3.5 w-3.5 items-center justify-center">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-50" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-indigo-400" />
          </span>
        )}
        {milestone.status === 'pending' && (
          <span className="inline-flex rounded-full h-2 w-2 bg-slate-700 mt-1" />
        )}
      </div>
      <div>
        <span className={`text-xs ${
          milestone.status === 'done' ? 'text-slate-300' :
          milestone.status === 'active' ? 'text-indigo-300 font-medium' :
          'text-slate-600'
        }`}>
          {milestone.label}
        </span>
        {milestone.detail && milestone.status === 'done' && (
          <span className="ml-2 text-xs text-slate-500 font-mono">{milestone.detail}</span>
        )}
        {milestone.detail && milestone.status === 'active' && (
          <span className="ml-2 text-xs text-indigo-400/70 font-mono">{milestone.detail}</span>
        )}
      </div>
    </div>
  )
}

function modelQuality(stats: Stats, progress: ScanProgress | null): { label: string; color: string } | null {
  if (!stats || stats.componentCount === 0) return null
  // parserType may be absent in old scan_progress blobs — fall back to milestone detail text
  const parserType = progress?.parserType
    ?? (progress?.milestones?.some(m => m.detail?.includes('Heuristic')) ? 'heuristic' : 'typescript')
  if (parserType === 'heuristic') return { label: 'LOW', color: 'text-red-400 bg-red-400/10' }
  // confidence < 40 = genuinely unresolvable; 50 = no type signals but valid TS component
  const unknownRatio = stats.componentCount > 0 ? stats.lowConfidenceCount / stats.componentCount : 0
  if (unknownRatio > 0.3) return { label: 'MEDIUM', color: 'text-amber-400 bg-amber-400/10' }
  return { label: 'HIGH', color: 'text-green-400 bg-green-400/10' }
}

export function ProjectDashboard({
  project: initial,
  initialChanges,
  initialStats,
  initialTopComponents,
}: {
  project: Project
  initialChanges: Change[]
  initialStats: Stats
  initialTopComponents: TopComponent[]
}) {
  const router = useRouter()
  const [project, setProject] = useState(initial)
  const [changes] = useState(initialChanges)
  const [stats, setStats] = useState(initialStats)
  const [topComponents, setTopComponents] = useState(initialTopComponents)

  const isScanning = project.scan_status === 'scanning'
  const isReady = project.scan_status === 'ready'
  const isFailed = project.scan_status === 'failed'

  useEffect(() => {
    if (!isScanning) return
    const id = setInterval(async () => {
      const res = await fetch(`/api/projects/${project.id}`)
      if (!res.ok) return
      const data = await res.json()
      setProject(data)
      if (data.stats) setStats(data.stats)
      if (data.topComponents) setTopComponents(data.topComponents)
      if (data.scan_status !== 'scanning') {
        clearInterval(id)
        router.refresh()
      }
    }, 2000)
    return () => clearInterval(id)
  }, [project.id, isScanning, router])

  async function handleRescan() {
    const res = await fetch(`/api/projects/${project.id}/scan`, { method: 'POST' })
    if (!res.ok) return
    setProject(p => ({ ...p, scan_status: 'scanning', scan_error: null, scan_progress: null }))
    setStats({ fileCount: 0, componentCount: 0, edgeCount: 0, lowConfidenceCount: 0 })
    setTopComponents([])
  }

  const progress = project.scan_progress
  const milestones = progress?.milestones ?? []
  const warnings = progress?.warnings ?? []
  const quality = isReady ? modelQuality(stats, progress) : null
  const hasData = stats.componentCount > 0

  return (
    <div className="flex flex-col h-screen bg-[#0b1326] text-on-surface overflow-hidden">
      <header className="w-full h-16 flex-shrink-0 flex items-center justify-between px-6 bg-[#0b1326] border-b border-white/5 z-50">
        <div className="flex items-center gap-2 text-sm">
          <Link href="/projects" className="font-black text-indigo-400 tracking-tighter hover:text-indigo-300 transition-colors">
            FactoryOS
          </Link>
          <span className="text-slate-600">/</span>
          <span className="text-slate-200 font-medium truncate max-w-[240px]">{project.name}</span>
        </div>
        <div className="flex items-center gap-3">
          {isReady ? (
            <Link
              href={`/projects/${project.id}/changes/new`}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold bg-indigo-600 hover:bg-indigo-500 text-white transition-all active:scale-95"
            >
              <span className="material-symbols-outlined text-[15px]">add</span>
              New Change Request
            </Link>
          ) : (
            <button
              disabled
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold bg-slate-800 text-slate-500 cursor-not-allowed"
              title="Wait for scan to complete"
            >
              <span className="material-symbols-outlined text-[15px]">add</span>
              New Change Request
            </button>
          )}
          <ProfileAvatar />
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        <LeftNav projectId={project.id} projectName={project.name} />
        <main className="flex-1 overflow-y-auto bg-[#0b1326] p-8">
          <div className="max-w-4xl mx-auto space-y-6">

            {/* Scan status card */}
            <div className={`rounded-xl border p-5 ${
              isFailed ? 'bg-red-950/20 border-red-500/20' :
              isScanning ? 'bg-[#131b2e] border-indigo-500/20' :
              'bg-[#131b2e] border-white/5'
            }`}>
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  {isScanning && (
                    <span className="relative flex h-2.5 w-2.5">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-75" />
                      <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-indigo-400" />
                    </span>
                  )}
                  <span className="text-sm font-semibold text-slate-200">Repository Scan</span>
                  {isScanning && <Badge label="Scanning" colorClass="text-indigo-400 bg-indigo-400/10" />}
                  {isReady && <Badge label="Complete" colorClass="text-green-400 bg-green-400/10" />}
                  {isFailed && <Badge label="Failed" colorClass="text-red-400 bg-red-400/10" />}
                  {quality && (
                    <span className="flex items-center gap-1">
                      <span className="text-xs text-slate-500">Model quality:</span>
                      <Badge label={quality.label} colorClass={quality.color} />
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  {isReady && (
                    <Link href={`/projects/${project.id}/system-model`} className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors">
                      View full model →
                    </Link>
                  )}
                  {!isScanning && project.repo_url && (
                    <button onClick={handleRescan} className="text-xs text-slate-500 hover:text-slate-300 transition-colors">
                      Rescan
                    </button>
                  )}
                </div>
              </div>

              {/* Failed state */}
              {isFailed && (
                <p className="text-sm text-red-400">{project.scan_error ?? 'Unknown error'}</p>
              )}

              {/* No repo */}
              {!project.repo_url && !isScanning && !isReady && (
                <p className="text-sm text-slate-500">No repository connected.</p>
              )}

              {/* Milestones */}
              {milestones.length > 0 && (
                <div className="space-y-2.5">
                  {milestones.map(m => <MilestoneRow key={m.id} milestone={m} />)}
                </div>
              )}

              {/* Warnings */}
              {warnings.length > 0 && (
                <div className="mt-4 space-y-1.5">
                  {warnings.map((w, i) => (
                    <div key={i} className="flex items-start gap-2 text-xs text-amber-400/80">
                      <span className="material-symbols-outlined flex-shrink-0" style={{ fontSize: '13px', marginTop: '1px' }}>warning</span>
                      {w}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Live metrics + component preview (shown as soon as data appears) */}
            {(hasData || isScanning) && (
              <div className="grid grid-cols-2 gap-4">

                {/* Metrics */}
                <div className="rounded-xl bg-[#131b2e] border border-white/5 p-5">
                  <h2 className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-4">Metrics</h2>
                  <div className="space-y-3">
                    {[
                      { label: 'Files discovered', value: stats.fileCount },
                      { label: 'Components detected', value: stats.componentCount },
                      { label: 'Dependencies mapped', value: stats.edgeCount },
                      { label: 'Low confidence', value: stats.lowConfidenceCount },
                    ].map(({ label, value }) => (
                      <div key={label} className="flex items-center justify-between">
                        <span className="text-xs text-slate-500">{label}</span>
                        <span className={`text-sm font-mono font-bold ${
                          isScanning && value > 0 ? 'text-indigo-300' : 'text-slate-200'
                        }`}>
                          {value.toLocaleString()}
                          {isScanning && value > 0 && (
                            <span className="ml-1 text-indigo-400 text-[10px] animate-pulse">↑</span>
                          )}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Component preview */}
                <div className="rounded-xl bg-[#131b2e] border border-white/5 p-5">
                  <div className="flex items-center justify-between mb-4">
                    <h2 className="text-xs font-bold text-slate-400 uppercase tracking-widest">
                      {isScanning ? 'Detected so far' : 'Components'}
                    </h2>
                    {isScanning && <span className="text-[10px] text-indigo-400/70 animate-pulse">Live</span>}
                  </div>
                  {topComponents.length === 0 ? (
                    <div className="flex items-center gap-2 text-xs text-slate-600">
                      <span className="relative flex h-2 w-2">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-slate-500 opacity-50" />
                        <span className="relative inline-flex rounded-full h-2 w-2 bg-slate-600" />
                      </span>
                      Waiting for parser…
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {topComponents.slice(0, 8).map(c => (
                        <div key={c.id} className="flex items-center gap-2">
                          <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded font-bold ${COMPONENT_TYPE_COLORS[c.type] ?? 'text-slate-400 bg-slate-400/10'}`}>
                            {c.type}
                          </span>
                          <span className="text-xs text-slate-300 truncate flex-1">{c.name}</span>
                          {c.is_anchored && (
                            <span className="material-symbols-outlined text-slate-600 flex-shrink-0" style={{ fontSize: '12px' }} title="Anchored">anchor</span>
                          )}
                          {c.status === 'unstable' && (
                            <span className="text-[10px] text-amber-400/80">unstable</span>
                          )}
                        </div>
                      ))}
                      {topComponents.length > 8 && (
                        <p className="text-xs text-slate-600 pt-1">+{topComponents.length - 8} more</p>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Changes — only show when ready */}
            {isReady && (
              <div>
                <div className="flex items-center justify-between mb-3">
                  <h2 className="text-sm font-bold text-slate-300">Changes</h2>
                  <span className="text-xs text-slate-500 font-mono">{changes.length} total</span>
                </div>

                {changes.length === 0 ? (
                  <div className="rounded-xl p-12 text-center bg-[#131b2e] border border-white/5">
                    <span className="material-symbols-outlined text-slate-600 mb-3 block" style={{ fontSize: '32px' }}>change_history</span>
                    <p className="text-sm text-slate-500">No changes yet.</p>
                    <Link
                      href={`/projects/${project.id}/changes/new`}
                      className="inline-block mt-4 text-xs text-indigo-400 hover:text-indigo-300 transition-colors"
                    >
                      Submit your first change →
                    </Link>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {changes.map(c => (
                      <Link
                        key={c.id}
                        href={`/projects/${project.id}/changes/${c.id}`}
                        className="flex items-center gap-4 px-5 py-4 rounded-xl bg-[#131b2e] border border-white/5 hover:border-white/10 hover:bg-[#171f33] transition-all"
                      >
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-semibold text-on-surface truncate">{c.title}</p>
                          <p className="text-xs text-slate-500 mt-0.5">{new Date(c.updated_at).toLocaleDateString('en-GB')}</p>
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0">
                          <Badge label={c.type} colorClass={TYPE_COLORS[c.type] ?? 'text-slate-400 bg-slate-400/10'} />
                          {c.risk_level && <Badge label={c.risk_level} colorClass={RISK_COLORS[c.risk_level] ?? 'text-slate-400 bg-slate-400/10'} />}
                          <Badge label={c.status.replace(/_/g, ' ')} colorClass={STATUS_COLORS[c.status] ?? 'text-slate-400 bg-slate-400/10'} />
                          <span className="material-symbols-outlined text-slate-600" style={{ fontSize: '16px' }}>chevron_right</span>
                        </div>
                      </Link>
                    ))}
                  </div>
                )}
              </div>
            )}

          </div>
        </main>
      </div>
    </div>
  )
}
