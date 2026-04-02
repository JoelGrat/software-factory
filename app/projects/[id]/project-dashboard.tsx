'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { LeftNav } from '@/components/app/left-nav'
import { ProfileAvatar } from '@/components/app/profile-avatar'
import type { ScanProgress, ScanMilestone } from '@/lib/scanner/scanner'

interface Project {
  id: string; name: string; scan_status: string; scan_error: string | null
  scan_progress: ScanProgress | null; repo_url: string | null; created_at: string
}
interface Stats {
  fileCount: number; componentCount: number; edgeCount: number
  lowConfidenceCount: number; unstableCount: number; avgConfidence: number
}
interface ComponentItem {
  id: string; name: string; type: string; status: string; is_anchored: boolean
  fileCount: number; confidence: number; incomingDeps: number; outgoingDeps: number
}
interface DepLink { from_id: string; to_id: string }
interface Change {
  id: string; title: string; type: string; priority: string
  status: string; risk_level: string | null; created_at: string; updated_at: string
}

const TYPE_COLORS: Record<string, string> = {
  api: 'text-indigo-400 bg-indigo-400/10', service: 'text-blue-400 bg-blue-400/10',
  db: 'text-emerald-400 bg-emerald-400/10', ui: 'text-purple-400 bg-purple-400/10',
  module: 'text-slate-400 bg-slate-400/10',
}
const RISK_COLORS: Record<string, string> = {
  low: 'text-green-400 bg-green-400/10', medium: 'text-amber-400 bg-amber-400/10', high: 'text-red-400 bg-red-400/10',
}
const STATUS_COLORS: Record<string, string> = {
  open: 'text-slate-400 bg-slate-400/10', analyzing: 'text-indigo-400 bg-indigo-400/10',
  analyzing_mapping: 'text-indigo-400 bg-indigo-400/10', analyzing_propagation: 'text-indigo-400 bg-indigo-400/10',
  analyzing_scoring: 'text-indigo-400 bg-indigo-400/10', analyzed: 'text-blue-400 bg-blue-400/10',
  planned: 'text-purple-400 bg-purple-400/10', executing: 'text-amber-400 bg-amber-400/10',
  review: 'text-orange-400 bg-orange-400/10', done: 'text-green-400 bg-green-400/10',
  failed: 'text-red-400 bg-red-400/10',
}
const CHANGE_TYPE_COLORS: Record<string, string> = {
  bug: 'text-red-400 bg-red-400/10', feature: 'text-indigo-400 bg-indigo-400/10',
  refactor: 'text-amber-400 bg-amber-400/10', hotfix: 'text-orange-400 bg-orange-400/10',
}

function Badge({ label, colorClass }: { label: string; colorClass: string }) {
  return (
    <span className={`text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded font-mono ${colorClass}`}>
      {label}
    </span>
  )
}

function ConfBar({ value }: { value: number }) {
  const color = value >= 70 ? 'bg-green-500' : value >= 50 ? 'bg-amber-500' : 'bg-red-500'
  return (
    <div className="flex items-center gap-1.5">
      <div className="w-16 h-1 bg-slate-700 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${value}%` }} />
      </div>
      <span className="text-[10px] font-mono text-slate-400">{value}%</span>
    </div>
  )
}

function MilestoneRow({ milestone }: { milestone: ScanMilestone }) {
  return (
    <div className="flex items-start gap-3">
      <div className="flex-shrink-0 w-4 mt-0.5">
        {milestone.status === 'done' && <span className="material-symbols-outlined text-green-400" style={{ fontSize: '14px' }}>check_circle</span>}
        {milestone.status === 'active' && (
          <span className="relative flex h-3.5 w-3.5 items-center justify-center">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-50" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-indigo-400" />
          </span>
        )}
        {milestone.status === 'pending' && <span className="inline-flex rounded-full h-2 w-2 bg-slate-700 mt-1" />}
      </div>
      <div>
        <span className={`text-xs ${milestone.status === 'done' ? 'text-slate-300' : milestone.status === 'active' ? 'text-indigo-300 font-medium' : 'text-slate-600'}`}>
          {milestone.label}
        </span>
        {milestone.detail && (
          <span className={`ml-2 text-xs font-mono ${milestone.status === 'active' ? 'text-indigo-400/70' : 'text-slate-500'}`}>{milestone.detail}</span>
        )}
      </div>
    </div>
  )
}

function modelQuality(stats: Stats, progress: ScanProgress | null) {
  if (!stats || stats.componentCount === 0) return null
  const parserType = progress?.parserType
    ?? (progress?.milestones?.some(m => m.detail?.includes('Heuristic')) ? 'heuristic' : 'typescript')
  if (parserType === 'heuristic') return { label: 'LOW', color: 'text-red-400 bg-red-400/10' }
  const unknownRatio = stats.componentCount > 0 ? stats.lowConfidenceCount / stats.componentCount : 0
  if (unknownRatio > 0.3) return { label: 'MEDIUM', color: 'text-amber-400 bg-amber-400/10' }
  return { label: 'HIGH', color: 'text-green-400 bg-green-400/10' }
}

function getDomains(components: ComponentItem[]) {
  const map: Record<string, { count: number; confTotal: number }> = {}
  for (const c of components) {
    const parts = c.name.split('/')
    const domain = parts.length >= 2 ? parts[parts.length - 1] : parts[0]
    if (!domain || ['api', 'ui', 'app', 'components', 'lib', 'pages', 'index'].includes(domain)) continue
    if (!map[domain]) map[domain] = { count: 0, confTotal: 0 }
    map[domain].count++
    map[domain].confTotal += c.confidence
  }
  return Object.entries(map)
    .map(([name, d]) => ({ name, count: d.count, confidence: Math.round(d.confTotal / d.count) }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 6)
}

function getTechStack(components: ComponentItem[], progress: ScanProgress | null): string[] {
  const stack: string[] = []
  const pt = progress?.parserType ?? (progress?.milestones?.some(m => m.detail?.includes('TypeScript')) ? 'typescript' : null)
  if (pt === 'typescript') { stack.push('TypeScript'); stack.push('Next.js') }
  if (components.some(c => c.name.includes('supabase'))) stack.push('Supabase')
  if (components.some(c => c.name.includes('prisma'))) stack.push('Prisma')
  if (components.some(c => c.name.toLowerCase().includes('stripe'))) stack.push('Stripe')
  if (components.some(c => c.name.toLowerCase().includes('redis'))) stack.push('Redis')
  return stack
}

function getHotspots(components: ComponentItem[]) {
  return [...components]
    .filter(c => c.incomingDeps > 0 || c.outgoingDeps > 0)
    .sort((a, b) => (b.incomingDeps * 2 + b.outgoingDeps) - (a.incomingDeps * 2 + a.outgoingDeps))
    .slice(0, 5)
}

export function ProjectDashboard({
  project: initial, initialChanges, initialStats, initialComponents, allDeps,
}: {
  project: Project; initialChanges: Change[]; initialStats: Stats
  initialComponents: ComponentItem[]; allDeps: DepLink[]
}) {
  const router = useRouter()
  const [project, setProject] = useState(initial)
  const [changes] = useState(initialChanges)
  const [stats, setStats] = useState(initialStats)
  const [components, setComponents] = useState(initialComponents)
  const [expanded, setExpanded] = useState<string | null>(null)

  const isScanning = project.scan_status === 'scanning'
  const isReady = project.scan_status === 'ready'
  const isFailed = project.scan_status === 'failed'

  // Build lookup maps for dep expansion
  const compById = Object.fromEntries(components.map(c => [c.id, c]))
  const outgoing: Record<string, string[]> = {}
  const incoming: Record<string, string[]> = {}
  for (const d of allDeps) {
    if (!outgoing[d.from_id]) outgoing[d.from_id] = []
    outgoing[d.from_id].push(d.to_id)
    if (!incoming[d.to_id]) incoming[d.to_id] = []
    incoming[d.to_id].push(d.from_id)
  }

  useEffect(() => {
    if (!isScanning) return
    const id = setInterval(async () => {
      const res = await fetch(`/api/projects/${project.id}`)
      if (!res.ok) return
      const data = await res.json()
      setProject(data)
      if (data.stats) setStats(data.stats)
      if (data.topComponents) {
        setComponents(data.topComponents.map((c: any) => ({
          ...c, fileCount: 0, confidence: 50, incomingDeps: 0, outgoingDeps: 0,
        })))
      }
      if (data.scan_status !== 'scanning') { clearInterval(id); router.refresh() }
    }, 2000)
    return () => clearInterval(id)
  }, [project.id, isScanning, router])

  async function handleRescan() {
    const res = await fetch(`/api/projects/${project.id}/scan`, { method: 'POST' })
    if (!res.ok) return
    setProject(p => ({ ...p, scan_status: 'scanning', scan_error: null, scan_progress: null }))
    setStats({ fileCount: 0, componentCount: 0, edgeCount: 0, lowConfidenceCount: 0, unstableCount: 0, avgConfidence: 0 })
    setComponents([])
  }

  const progress = project.scan_progress
  const milestones = progress?.milestones ?? []
  const warnings = progress?.warnings ?? []
  const quality = isReady ? modelQuality(stats, progress) : null
  const domains = getDomains(components)
  const techStack = getTechStack(components, progress)
  const hotspots = getHotspots(components)
  const entryPoints = components.filter(c => c.is_anchored).slice(0, 4)
  const archCounts = components.reduce((acc, c) => { acc[c.type] = (acc[c.type] ?? 0) + 1; return acc }, {} as Record<string, number>)
  const doneChanges = changes.filter(c => c.status === 'done').length
  const hasData = components.length > 0

  return (
    <div className="flex flex-col h-screen bg-[#0b1326] text-on-surface overflow-hidden">
      <header className="w-full h-16 flex-shrink-0 flex items-center justify-between px-6 bg-[#0b1326] border-b border-white/5 z-50">
        <div className="flex items-center gap-2 text-sm">
          <Link href="/projects" className="font-black text-indigo-400 tracking-tighter hover:text-indigo-300 transition-colors">FactoryOS</Link>
          <span className="text-slate-600">/</span>
          <span className="text-slate-200 font-medium truncate max-w-[240px]">{project.name}</span>
        </div>
        <div className="flex items-center gap-3">
          {isReady ? (
            <Link href={`/projects/${project.id}/changes/new`} className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold bg-indigo-600 hover:bg-indigo-500 text-white transition-all active:scale-95">
              <span className="material-symbols-outlined text-[15px]">add</span>New Change Request
            </Link>
          ) : (
            <button disabled className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold bg-slate-800 text-slate-500 cursor-not-allowed">
              <span className="material-symbols-outlined text-[15px]">add</span>New Change Request
            </button>
          )}
          <ProfileAvatar />
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        <LeftNav projectId={project.id} projectName={project.name} />
        <main className="flex-1 overflow-y-auto p-8">
          <div className="max-w-5xl mx-auto space-y-5">

            {/* Scan status */}
            <div className={`rounded-xl border p-5 ${isFailed ? 'bg-red-950/20 border-red-500/20' : isScanning ? 'bg-[#131b2e] border-indigo-500/20' : 'bg-[#131b2e] border-white/5'}`}>
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2 flex-wrap">
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
                  {quality && <><span className="text-xs text-slate-500">Model quality:</span><Badge label={quality.label} colorClass={quality.color} /></>}
                </div>
                <div className="flex items-center gap-3">
                  {isReady && <Link href={`/projects/${project.id}/system-model`} className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors">Full model →</Link>}
                  {!isScanning && project.repo_url && <button onClick={handleRescan} className="text-xs text-slate-500 hover:text-slate-300 transition-colors">Rescan</button>}
                </div>
              </div>
              {isFailed && <p className="text-sm text-red-400 mb-3">{project.scan_error ?? 'Unknown error'}</p>}
              {!project.repo_url && !isScanning && !isReady && <p className="text-sm text-slate-500">No repository connected.</p>}
              {milestones.length > 0 && (
                <div className="space-y-2">
                  {milestones.map(m => <MilestoneRow key={m.id} milestone={m} />)}
                </div>
              )}
              {warnings.length > 0 && (
                <div className="mt-3 space-y-1">
                  {warnings.map((w, i) => (
                    <div key={i} className="flex items-start gap-2 text-xs text-amber-400/80">
                      <span className="material-symbols-outlined flex-shrink-0" style={{ fontSize: '13px', marginTop: '1px' }}>warning</span>{w}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* System Overview + Model Quality */}
            {isReady && hasData && (
              <div className="grid grid-cols-5 gap-4">

                {/* System Overview — 3/5 */}
                <div className="col-span-3 rounded-xl bg-[#131b2e] border border-white/5 p-5 space-y-4">
                  <h2 className="text-xs font-bold text-slate-400 uppercase tracking-widest">System Overview</h2>

                  {/* Detected domains */}
                  {domains.length > 0 && (
                    <div>
                      <p className="text-[10px] text-slate-500 uppercase tracking-widest mb-2">Detected domains</p>
                      <div className="flex flex-wrap gap-1.5">
                        {domains.map(d => (
                          <span key={d.name} className="flex items-center gap-1 px-2 py-1 rounded-lg bg-indigo-400/5 border border-indigo-400/15">
                            <span className="text-xs text-indigo-300 font-medium capitalize">{d.name}</span>
                            <span className="text-[10px] text-indigo-400/60 font-mono">{d.confidence}%</span>
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Architecture */}
                  <div>
                    <p className="text-[10px] text-slate-500 uppercase tracking-widest mb-2">Architecture</p>
                    <div className="flex gap-2 flex-wrap">
                      {Object.entries(archCounts).filter(([, n]) => n > 0).map(([type, n]) => (
                        <span key={type} className={`flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-mono font-bold ${TYPE_COLORS[type] ?? 'text-slate-400 bg-slate-400/10'}`}>
                          {type.toUpperCase()} <span className="opacity-60">×{n}</span>
                        </span>
                      ))}
                    </div>
                  </div>

                  {/* Entry points */}
                  {entryPoints.length > 0 && (
                    <div>
                      <p className="text-[10px] text-slate-500 uppercase tracking-widest mb-2">Entry points</p>
                      <div className="flex flex-wrap gap-1.5">
                        {entryPoints.map(c => (
                          <span key={c.id} className="text-[10px] font-mono text-slate-400 bg-slate-400/5 border border-white/5 px-2 py-1 rounded">
                            {c.name}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Tech stack */}
                  {techStack.length > 0 && (
                    <div>
                      <p className="text-[10px] text-slate-500 uppercase tracking-widest mb-2">Tech stack</p>
                      <div className="flex flex-wrap gap-1.5">
                        {techStack.map(t => (
                          <span key={t} className="text-xs text-slate-300 bg-slate-400/10 px-2 py-0.5 rounded">{t}</span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                {/* Model Quality — 2/5 */}
                <div className="col-span-2 rounded-xl bg-[#131b2e] border border-white/5 p-5 space-y-4">
                  <div className="flex items-center justify-between">
                    <h2 className="text-xs font-bold text-slate-400 uppercase tracking-widest">Model Quality</h2>
                    {quality && <Badge label={quality.label} colorClass={quality.color} />}
                  </div>

                  <div className="space-y-3">
                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-[10px] text-slate-500">Avg confidence</span>
                      </div>
                      <ConfBar value={stats.avgConfidence} />
                    </div>
                    <div className="space-y-1.5 text-xs">
                      <div className="flex justify-between">
                        <span className="text-slate-500">Components</span>
                        <span className="font-mono text-slate-300">{stats.componentCount}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-500">Dependencies</span>
                        <span className="font-mono text-slate-300">{stats.edgeCount}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-500">Unstable</span>
                        <span className={`font-mono ${stats.unstableCount > 0 ? 'text-amber-400' : 'text-slate-300'}`}>{stats.unstableCount}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-500">Low confidence</span>
                        <span className={`font-mono ${stats.lowConfidenceCount > 0 ? 'text-red-400' : 'text-slate-300'}`}>{stats.lowConfidenceCount}</span>
                      </div>
                    </div>
                  </div>

                  {warnings.length > 0 && (
                    <div className="space-y-1 pt-1 border-t border-white/5">
                      {warnings.map((w, i) => (
                        <div key={i} className="flex items-start gap-1.5 text-[10px] text-amber-400/70">
                          <span className="material-symbols-outlined flex-shrink-0" style={{ fontSize: '11px', marginTop: '1px' }}>warning</span>
                          <span>{w}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Live metrics during scan */}
            {isScanning && (
              <div className="grid grid-cols-4 gap-3">
                {[
                  { label: 'Files', value: stats.fileCount },
                  { label: 'Components', value: stats.componentCount },
                  { label: 'Dependencies', value: stats.edgeCount },
                  { label: 'Low confidence', value: stats.lowConfidenceCount },
                ].map(({ label, value }) => (
                  <div key={label} className="rounded-xl bg-[#131b2e] border border-white/5 p-4 flex flex-col gap-1">
                    <span className="text-[10px] text-slate-500 uppercase tracking-wider">{label}</span>
                    <span className="text-xl font-mono font-bold text-indigo-300">
                      {value.toLocaleString()}
                      {value > 0 && <span className="ml-1 text-xs animate-pulse">↑</span>}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {/* Components panel */}
            {hasData && (
              <div className="rounded-xl bg-[#131b2e] border border-white/5 p-5">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-xs font-bold text-slate-400 uppercase tracking-widest">
                    {isScanning ? 'Detected so far' : `Components (${components.length})`}
                  </h2>
                  {isScanning && <span className="text-[10px] text-indigo-400/70 animate-pulse">Live</span>}
                  {isReady && <Link href={`/projects/${project.id}/system-model`} className="text-xs text-slate-500 hover:text-slate-300 transition-colors">View all →</Link>}
                </div>
                <div className="space-y-1">
                  {components.slice(0, expanded ? components.length : 8).map(c => {
                    const isOpen = expanded === c.id
                    const deps = outgoing[c.id]?.map(id => compById[id]?.name).filter(Boolean) ?? []
                    const usedBy = incoming[c.id]?.map(id => compById[id]?.name).filter(Boolean) ?? []
                    const riskLabel = c.incomingDeps >= 3 ? 'high' : c.incomingDeps >= 1 ? 'medium' : 'low'
                    return (
                      <div key={c.id}>
                        <button
                          onClick={() => setExpanded(isOpen ? null : c.id)}
                          className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-white/3 transition-colors text-left"
                        >
                          <span className={`text-[10px] font-mono font-bold px-1.5 py-0.5 rounded flex-shrink-0 ${TYPE_COLORS[c.type] ?? 'text-slate-400 bg-slate-400/10'}`}>{c.type}</span>
                          <span className="text-xs text-slate-200 truncate flex-1">{c.name}</span>
                          <div className="flex items-center gap-3 flex-shrink-0">
                            {isReady && (
                              <>
                                <span className="text-[10px] text-slate-500 font-mono">{c.fileCount}f</span>
                                <ConfBar value={c.confidence} />
                                {c.incomingDeps > 0 && <span className="text-[10px] text-slate-500 font-mono">↙{c.incomingDeps}</span>}
                                <Badge label={riskLabel} colorClass={RISK_COLORS[riskLabel]} />
                              </>
                            )}
                            {c.is_anchored && <span className="material-symbols-outlined text-slate-600" style={{ fontSize: '12px' }} title="Entry point">anchor</span>}
                            {c.status === 'unstable' && <span className="text-[10px] text-amber-400/80">unstable</span>}
                            <span className={`material-symbols-outlined text-slate-600 transition-transform ${isOpen ? 'rotate-180' : ''}`} style={{ fontSize: '14px' }}>expand_more</span>
                          </div>
                        </button>

                        {isOpen && (
                          <div className="mx-3 mb-2 px-3 py-3 rounded-lg bg-[#0f1929] border border-white/5 space-y-3">
                            <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-xs">
                              <div>
                                <p className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">Files</p>
                                <p className="font-mono text-slate-300">{c.fileCount}</p>
                              </div>
                              <div>
                                <p className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">Confidence</p>
                                <ConfBar value={c.confidence} />
                              </div>
                            </div>
                            {deps.length > 0 && (
                              <div>
                                <p className="text-[10px] text-slate-500 uppercase tracking-wider mb-1.5">Depends on</p>
                                <div className="flex flex-wrap gap-1">
                                  {deps.map(name => (
                                    <span key={name} className="text-[10px] font-mono text-indigo-300 bg-indigo-400/10 px-1.5 py-0.5 rounded">{name}</span>
                                  ))}
                                </div>
                              </div>
                            )}
                            {usedBy.length > 0 && (
                              <div>
                                <p className="text-[10px] text-slate-500 uppercase tracking-wider mb-1.5">Used by</p>
                                <div className="flex flex-wrap gap-1">
                                  {usedBy.map(name => (
                                    <span key={name} className="text-[10px] font-mono text-slate-400 bg-slate-400/10 px-1.5 py-0.5 rounded">{name}</span>
                                  ))}
                                </div>
                              </div>
                            )}
                            {deps.length === 0 && usedBy.length === 0 && (
                              <p className="text-xs text-slate-600">No resolved dependencies</p>
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })}
                  {!expanded && components.length > 8 && (
                    <button onClick={() => setExpanded('__all')} className="w-full text-xs text-slate-500 hover:text-slate-300 transition-colors pt-2 text-center">
                      Show all {components.length} components
                    </button>
                  )}
                  {expanded === '__all' && (
                    <button onClick={() => setExpanded(null)} className="w-full text-xs text-slate-500 hover:text-slate-300 transition-colors pt-2 text-center">
                      Show less
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* Hotspots + Next Steps */}
            {isReady && hasData && (
              <div className="grid grid-cols-2 gap-4">

                {/* Hotspots */}
                <div className="rounded-xl bg-[#131b2e] border border-white/5 p-5">
                  <h2 className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-4">
                    <span className="mr-1">🔥</span>Hotspots
                  </h2>
                  {hotspots.length === 0 ? (
                    <p className="text-xs text-slate-600">No cross-component dependencies yet.</p>
                  ) : (
                    <div className="space-y-2">
                      {hotspots.map(c => (
                        <div key={c.id} className="flex items-center gap-2">
                          <span className={`text-[10px] font-mono font-bold px-1 py-0.5 rounded flex-shrink-0 ${TYPE_COLORS[c.type] ?? 'text-slate-400 bg-slate-400/10'}`}>{c.type}</span>
                          <span className="text-xs text-slate-300 truncate flex-1">{c.name}</span>
                          <div className="flex items-center gap-1.5 flex-shrink-0 text-[10px] font-mono text-slate-500">
                            {c.incomingDeps > 0 && <span className="text-amber-400/80">↙{c.incomingDeps}</span>}
                            {c.outgoingDeps > 0 && <span>↗{c.outgoingDeps}</span>}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Next Steps + Learning Status */}
                <div className="rounded-xl bg-[#131b2e] border border-white/5 p-5 flex flex-col gap-4">
                  <div>
                    <h2 className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-3">
                      <span className="mr-1">🚀</span>Next Steps
                    </h2>
                    <div className="space-y-2">
                      <Link href={`/projects/${project.id}/changes/new`} className="flex items-center gap-2 text-xs text-indigo-300 hover:text-indigo-200 transition-colors">
                        <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>add_circle</span>
                        Create a change request
                      </Link>
                      <Link href={`/projects/${project.id}/system-model`} className="flex items-center gap-2 text-xs text-slate-400 hover:text-slate-300 transition-colors">
                        <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>account_tree</span>
                        Explore system model
                      </Link>
                      {stats.unstableCount > 0 && (
                        <Link href={`/projects/${project.id}/system-model`} className="flex items-center gap-2 text-xs text-amber-400/80 hover:text-amber-400 transition-colors">
                          <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>warning</span>
                          Review {stats.unstableCount} unstable component{stats.unstableCount > 1 ? 's' : ''}
                        </Link>
                      )}
                    </div>
                  </div>

                  <div className="border-t border-white/5 pt-3">
                    <p className="text-[10px] text-slate-500 uppercase tracking-widest mb-1">Learning status</p>
                    {doneChanges === 0 ? (
                      <p className="text-xs text-slate-600">No changes analyzed yet</p>
                    ) : (
                      <p className="text-xs text-slate-400">Learning from <span className="text-indigo-300 font-mono">{doneChanges}</span> past change{doneChanges > 1 ? 's' : ''}</p>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Changes */}
            {isReady && (
              <div>
                <div className="flex items-center justify-between mb-3">
                  <h2 className="text-sm font-bold text-slate-300">Changes</h2>
                  <span className="text-xs text-slate-500 font-mono">{changes.length} total</span>
                </div>

                {changes.length === 0 ? (
                  <div className="rounded-xl p-8 bg-[#131b2e] border border-white/5">
                    <p className="text-sm text-slate-400 font-medium mb-1">No changes yet</p>
                    <p className="text-xs text-slate-600 mb-4">Start by describing a change to your system.</p>
                    <div className="space-y-2 mb-4">
                      {['Fix login session expiry bug', 'Add user roles and permissions', 'Refactor API authentication layer'].map(ex => (
                        <Link
                          key={ex}
                          href={`/projects/${project.id}/changes/new`}
                          className="flex items-center gap-2 text-xs text-slate-400 hover:text-indigo-300 transition-colors"
                        >
                          <span className="material-symbols-outlined text-slate-600" style={{ fontSize: '14px' }}>arrow_forward</span>
                          {ex}
                        </Link>
                      ))}
                    </div>
                    <Link href={`/projects/${project.id}/changes/new`} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-indigo-600/20 text-indigo-300 hover:bg-indigo-600/30 transition-colors border border-indigo-500/20">
                      <span className="material-symbols-outlined" style={{ fontSize: '13px' }}>add</span>
                      New Change Request
                    </Link>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {changes.map(c => (
                      <Link key={c.id} href={`/projects/${project.id}/changes/${c.id}`} className="flex items-center gap-4 px-5 py-4 rounded-xl bg-[#131b2e] border border-white/5 hover:border-white/10 hover:bg-[#171f33] transition-all">
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-semibold text-on-surface truncate">{c.title}</p>
                          <p className="text-xs text-slate-500 mt-0.5">{new Date(c.updated_at).toLocaleDateString('en-GB')}</p>
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0">
                          <Badge label={c.type} colorClass={CHANGE_TYPE_COLORS[c.type] ?? 'text-slate-400 bg-slate-400/10'} />
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
