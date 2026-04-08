'use client'
import { useState, useMemo } from 'react'
import Link from 'next/link'
import { LeftNav } from '@/components/app/left-nav'
import { ProfileAvatar } from '@/components/app/profile-avatar'

interface Project { id: string; name: string; scan_status: string }
interface Component {
  id: string; name: string; type: string; status: string
  is_anchored: boolean; scan_count: number; last_updated: string
  fileCount: number; confidence: number; topFiles: string[]
}
interface Dependency { from_id: string; to_id: string }

const TYPE_COLORS: Record<string, string> = {
  api: 'text-indigo-400 bg-indigo-400/10 border-indigo-400/20',
  ui: 'text-blue-400 bg-blue-400/10 border-blue-400/20',
  db: 'text-purple-400 bg-purple-400/10 border-purple-400/20',
  service: 'text-amber-400 bg-amber-400/10 border-amber-400/20',
  module: 'text-slate-400 bg-slate-400/10 border-slate-400/20',
}

const TYPE_LABELS: Record<string, string> = {
  api: 'API',
  ui: 'UI',
  db: 'Data',
  service: 'Service',
  module: 'Module',
}

const TYPE_GROUP_REASONS: Record<string, (name: string, fileCount: number) => string> = {
  api: (name) => `Groups route handlers and API logic under \`${name}/\`. Detected by presence of route files or handler patterns.`,
  ui: (name) => `Groups UI components and views under \`${name}/\`. Detected by component file naming conventions.`,
  db: (name) => `Groups database access, migrations, or schema definitions under \`${name}/\`. Detected by schema or query file patterns.`,
  service: (name) => `Groups business logic or service layer files under \`${name}/\`. Detected by service/handler/provider naming.`,
  module: (name, fileCount) => `Groups ${fileCount} co-located files under \`${name}/\` that share a common path prefix. No strong type signal detected.`,
}

function impactLevel(incomingDeps: number): 'HIGH' | 'MEDIUM' | 'LOW' {
  if (incomingDeps >= 3) return 'HIGH'
  if (incomingDeps >= 1) return 'MEDIUM'
  return 'LOW'
}

// Matches dashboard scoring: incomingDeps*2 + outgoingDeps
function hotspotScore(incoming: number, outgoing: number): number {
  return incoming * 2 + outgoing
}

function ImpactBadge({ level }: { level: 'HIGH' | 'MEDIUM' | 'LOW' }) {
  const styles = {
    HIGH: 'text-orange-300 bg-orange-400/15 border border-orange-400/30',
    MEDIUM: 'text-yellow-300 bg-yellow-400/10 border border-yellow-400/20',
    LOW: 'text-slate-500 bg-slate-400/5 border border-slate-400/10',
  }
  return (
    <span className={`text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded font-mono ${styles[level]}`}>
      {level === 'HIGH' ? '⬆ HIGH' : level === 'MEDIUM' ? '· MED' : '· LOW'}
    </span>
  )
}

function ConfidenceBar({ value }: { value: number }) {
  const color = value >= 70 ? 'bg-emerald-400' : value >= 40 ? 'bg-amber-400' : 'bg-red-400'
  return (
    <div className="flex items-center gap-1.5">
      <div className="w-16 h-1 rounded-full bg-white/5 overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${value}%` }} />
      </div>
      <span className="text-[10px] font-mono text-slate-500">{value}%</span>
    </div>
  )
}

function Tooltip({ text, children }: { text: string; children: React.ReactNode }) {
  const [visible, setVisible] = useState(false)
  return (
    <span
      className="relative inline-flex"
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => setVisible(false)}
    >
      {children}
      {visible && (
        <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 z-50 w-64 rounded-lg px-3 py-2 text-xs text-slate-300 bg-[#1a2640] border border-white/10 shadow-xl pointer-events-none whitespace-normal">
          {text}
        </span>
      )}
    </span>
  )
}

export function SystemModelBrowser({
  project, components, dependencies,
}: {
  project: Project; components: Component[]; dependencies: Dependency[]
}) {
  const [search, setSearch] = useState('')
  const [filterUnstable, setFilterUnstable] = useState(false)
  const [filterHotspot, setFilterHotspot] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)

  // outgoing: from_id → [to_id]
  const outgoingMap = useMemo(() => {
    const m: Record<string, string[]> = {}
    for (const d of dependencies) {
      if (!m[d.from_id]) m[d.from_id] = []
      m[d.from_id].push(d.to_id)
    }
    return m
  }, [dependencies])

  // incoming: to_id → [from_id]
  const incomingMap = useMemo(() => {
    const m: Record<string, string[]> = {}
    for (const d of dependencies) {
      if (!m[d.to_id]) m[d.to_id] = []
      m[d.to_id].push(d.from_id)
    }
    return m
  }, [dependencies])

  const componentById = useMemo(() => {
    const m: Record<string, Component> = {}
    for (const c of components) m[c.id] = c
    return m
  }, [components])

  const filtered = useMemo(() => {
    return components.filter(c => {
      if (filterUnstable && c.status !== 'unstable') return false
      const outgoing = outgoingMap[c.id]?.length ?? 0
      const incoming = incomingMap[c.id]?.length ?? 0
      if (filterHotspot && hotspotScore(incoming, outgoing) < 3) return false
      if (search) {
        const q = search.toLowerCase()
        return c.name.toLowerCase().includes(q)
      }
      return true
    })
  }, [components, search, filterUnstable, filterHotspot, outgoingMap, incomingMap])

  const grouped = useMemo(() => {
    const m = new Map<string, Component[]>()
    for (const c of filtered) {
      if (!m.has(c.type)) m.set(c.type, [])
      m.get(c.type)!.push(c)
    }
    return m
  }, [filtered])

  const typeOrder = ['api', 'ui', 'service', 'db', 'module']

  const hotspotCount = useMemo(() => components.filter(c => {
    const incoming = incomingMap[c.id]?.length ?? 0
    const outgoing = outgoingMap[c.id]?.length ?? 0
    return hotspotScore(incoming, outgoing) >= 3
  }).length, [components, incomingMap, outgoingMap])

  return (
    <div className="flex flex-col h-screen bg-[#0b1326] text-on-surface overflow-hidden">
      <header className="w-full h-16 flex-shrink-0 flex items-center justify-between px-6 bg-[#0b1326] border-b border-white/5 z-50 font-headline antialiased tracking-tight">
        <div className="flex items-center gap-2 text-sm">
          <Link href="/projects" className="font-black text-indigo-400 tracking-tighter hover:text-indigo-300 transition-colors">
            FactoryOS
          </Link>
          <span className="text-slate-600">/</span>
          <Link href={`/projects/${project.id}`} className="text-slate-400 hover:text-slate-200 transition-colors font-medium truncate max-w-[180px]">
            {project.name}
          </Link>
          <span className="text-slate-600">/</span>
          <span className="text-slate-200 font-medium">System Model</span>
        </div>
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
          <div className="max-w-4xl mx-auto space-y-8">

            <div className="flex items-start justify-between">
              <div>
                <p className="text-xs uppercase tracking-widest font-bold text-indigo-400 font-headline mb-1">System Model</p>
                <h1 className="text-3xl font-extrabold font-headline tracking-tight text-on-surface">{project.name}</h1>
                <p className="text-sm text-slate-400 mt-1">{components.length} components · {dependencies.length} dependency edges</p>
              </div>
            </div>

            {/* Filters */}
            <div className="flex items-center gap-3 flex-wrap">
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search components…"
                className="rounded-lg px-3 py-2 text-sm outline-none w-64 transition-all bg-[#131b2e] border border-white/10 text-slate-200 placeholder:text-slate-600 focus:border-indigo-500"
              />
              <button
                onClick={() => setFilterUnstable(v => !v)}
                className={`text-xs px-3 py-1.5 rounded-full font-bold font-mono transition-all ${
                  filterUnstable ? 'bg-red-400/20 text-red-300 border border-red-400/30' : 'bg-white/5 text-slate-400 hover:bg-white/10 border border-white/5'
                }`}
              >
                Unstable only
              </button>
              <button
                onClick={() => setFilterHotspot(v => !v)}
                className={`text-xs px-3 py-1.5 rounded-full font-bold font-mono transition-all flex items-center gap-1.5 ${
                  filterHotspot ? 'bg-orange-400/20 text-orange-300 border border-orange-400/30' : 'bg-white/5 text-slate-400 hover:bg-white/10 border border-white/5'
                }`}
              >
                <span>Hotspots</span>
                {hotspotCount > 0 && (
                  <span className="text-[10px] rounded-full bg-orange-400/20 text-orange-300 px-1.5 py-0.5">{hotspotCount}</span>
                )}
              </button>
            </div>

            {/* Component groups */}
            {typeOrder.map(type => {
              const group = grouped.get(type)
              if (!group?.length) return null
              return (
                <div key={type}>
                  <h2 className="text-xs font-bold uppercase tracking-widest text-slate-500 font-headline mb-3">
                    {TYPE_LABELS[type] ?? type}
                    <span className="ml-2 text-slate-600 font-mono normal-case tracking-normal">{group.length}</span>
                  </h2>
                  <div className="space-y-1">
                    {group.map(c => {
                      const outgoing = outgoingMap[c.id] ?? []
                      const incoming = incomingMap[c.id] ?? []
                      const impact = impactLevel(incoming.length)
                      const isHotspot = hotspotScore(incoming.length, outgoing.length) >= 3
                      const suggestSplit = c.fileCount > 8

                      return (
                        <div key={c.id}>
                          <button
                            onClick={() => setExpanded(expanded === c.id ? null : c.id)}
                            className={`w-full flex items-center gap-4 px-5 py-3 rounded-xl border transition-all text-left ${
                              c.status === 'unstable'
                                ? 'bg-red-950/30 border-red-500/30 hover:border-red-500/50'
                                : isHotspot
                                  ? 'bg-orange-950/20 border-orange-500/20 hover:border-orange-500/30'
                                  : 'bg-[#131b2e] border-white/5 hover:border-white/10 hover:bg-[#171f33]'
                            }`}
                          >
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="text-sm font-semibold text-on-surface font-mono">{c.name}</span>
                                {c.status === 'unstable' && (
                                  <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded font-mono bg-red-500/20 text-red-300 border border-red-500/40">
                                    ⚠ UNSTABLE
                                  </span>
                                )}
                              </div>
                              <div className="flex items-center gap-2 mt-1">
                                <ConfidenceBar value={c.confidence} />
                                <span className="text-[10px] text-slate-600 font-mono">{c.fileCount} files</span>
                                {incoming.length > 0 && (
                                  <span className="text-[10px] text-slate-600 font-mono">{incoming.length} used by</span>
                                )}
                                {outgoing.length > 0 && (
                                  <span className="text-[10px] text-slate-600 font-mono">{outgoing.length} deps</span>
                                )}
                              </div>
                            </div>
                            <div className="flex items-center gap-2 flex-shrink-0">
                              <span className={`text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded font-mono border ${TYPE_COLORS[c.type] ?? 'text-slate-400 bg-slate-400/10 border-slate-400/20'}`}>
                                {TYPE_LABELS[c.type] ?? c.type}
                              </span>
                              <ImpactBadge level={impact} />
                              {c.is_anchored && (
                                <Tooltip text="Anchored: this component was manually confirmed. It will not be merged or renamed by future scans.">
                                  <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded font-mono text-emerald-400 bg-emerald-400/10 border border-emerald-400/20 cursor-default">
                                    ⚓ anchored
                                  </span>
                                </Tooltip>
                              )}
                              <span
                                className="material-symbols-outlined text-slate-600 transition-transform flex-shrink-0"
                                style={{ fontSize: '16px', transform: expanded === c.id ? 'rotate(90deg)' : undefined }}
                              >
                                chevron_right
                              </span>
                            </div>
                          </button>

                          {expanded === c.id && (
                            <div className="mt-1 ml-4 rounded-xl bg-[#0f1929] border border-white/5 overflow-hidden">

                              {/* Composition */}
                              {c.topFiles.length > 0 && (
                                <div className="px-4 py-3 border-b border-white/5">
                                  <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500 font-headline mb-2">Composition</p>
                                  <div className="space-y-1">
                                    {c.topFiles.map(f => (
                                      <p key={f} className="text-xs font-mono text-slate-400 truncate">
                                        <span className="text-slate-600 mr-1">›</span>{f}
                                      </p>
                                    ))}
                                    {c.fileCount > c.topFiles.length && (
                                      <p className="text-[10px] text-slate-600 font-mono">+ {c.fileCount - c.topFiles.length} more files</p>
                                    )}
                                  </div>
                                </div>
                              )}

                              {/* Dependencies — both directions */}
                              <div className="px-4 py-3 border-b border-white/5">
                                <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500 font-headline mb-2">Dependencies</p>
                                <div className="space-y-3">
                                  {outgoing.length > 0 ? (
                                    <div>
                                      <p className="text-[10px] text-slate-600 font-headline mb-1.5 uppercase tracking-widest">Depends on</p>
                                      <div className="flex flex-wrap gap-1.5">
                                        {outgoing.map(toId => (
                                          <span key={toId} className="text-xs font-mono text-indigo-300 bg-indigo-400/10 border border-indigo-400/20 px-2 py-0.5 rounded">
                                            → {componentById[toId]?.name ?? toId}
                                          </span>
                                        ))}
                                      </div>
                                    </div>
                                  ) : (
                                    <p className="text-xs text-slate-600 italic">No outgoing dependencies</p>
                                  )}

                                  {incoming.length > 0 ? (
                                    <div>
                                      <p className="text-[10px] text-slate-600 font-headline mb-1.5 uppercase tracking-widest">Used by</p>
                                      <div className="flex flex-wrap gap-1.5">
                                        {incoming.map(fromId => (
                                          <span key={fromId} className="text-xs font-mono text-teal-300 bg-teal-400/10 border border-teal-400/20 px-2 py-0.5 rounded">
                                            ← {componentById[fromId]?.name ?? fromId}
                                          </span>
                                        ))}
                                      </div>
                                    </div>
                                  ) : (
                                    <p className="text-xs text-slate-600 italic">Not used by any other component</p>
                                  )}
                                </div>
                              </div>

                              {/* Mini graph — neighborhood overview */}
                              {(incoming.length > 0 || outgoing.length > 0) && (
                                <div className="px-4 py-3 border-b border-white/5">
                                  <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500 font-headline mb-2">Neighborhood</p>
                                  <div className="font-mono text-xs space-y-0.5">
                                    {incoming.slice(0, 4).map(fromId => (
                                      <p key={fromId} className="text-slate-500">
                                        <span className="text-teal-600">←</span> {componentById[fromId]?.name ?? fromId}
                                      </p>
                                    ))}
                                    <p className="text-slate-300 font-semibold pl-3">[ {c.name} ]</p>
                                    {outgoing.slice(0, 4).map(toId => (
                                      <p key={toId} className="text-slate-500 pl-6">
                                        <span className="text-indigo-600">→</span> {componentById[toId]?.name ?? toId}
                                      </p>
                                    ))}
                                    {(incoming.length > 4 || outgoing.length > 4) && (
                                      <p className="text-slate-600 pl-3">… and more</p>
                                    )}
                                  </div>
                                </div>
                              )}

                              {/* Why grouping */}
                              <div className="px-4 py-3 border-b border-white/5">
                                <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500 font-headline mb-1.5">Why is this a component?</p>
                                <p className="text-xs text-slate-400 leading-relaxed">
                                  {(TYPE_GROUP_REASONS[c.type] ?? TYPE_GROUP_REASONS.module)(c.name, c.fileCount)}
                                </p>
                              </div>

                              {/* Evolution signal */}
                              {suggestSplit && (
                                <div className="px-4 py-3 border-b border-white/5 bg-yellow-950/20">
                                  <p className="text-[10px] font-bold uppercase tracking-widest text-yellow-500 font-headline mb-1">Evolution Signal</p>
                                  <p className="text-xs text-yellow-300/80 leading-relaxed mb-2.5">
                                    This component contains {c.fileCount} files — above the recommended threshold of 8. Consider splitting into smaller, focused sub-components with clearer responsibilities.
                                  </p>
                                  <Link
                                    href={`/projects/${project.id}/changes/new?title=${encodeURIComponent(`Split ${c.name} into focused sub-components`)}`}
                                    className="inline-flex items-center gap-1.5 text-xs font-semibold text-yellow-300 hover:text-yellow-200 transition-colors"
                                  >
                                    <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>add_circle</span>
                                    Create refactor change
                                  </Link>
                                </div>
                              )}

                              {/* Actions */}
                              <div className="px-4 py-3 flex items-center gap-3">
                                <Link
                                  href={`/projects/${project.id}/changes/new?title=${encodeURIComponent(`Change in ${c.name}`)}`}
                                  className="text-xs font-semibold text-indigo-400 hover:text-indigo-300 transition-colors flex items-center gap-1"
                                >
                                  <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>add_circle</span>
                                  Create Change Request
                                </Link>
                                <span className="text-slate-700">·</span>
                                <span className="text-[10px] text-slate-600 font-mono">Scanned {c.scan_count}× · {new Date(c.last_updated).toLocaleDateString()}</span>
                              </div>
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>
              )
            })}

            {/* Remainder types not in typeOrder */}
            {[...grouped.keys()].filter(t => !typeOrder.includes(t)).map(type => {
              const group = grouped.get(type)!
              return (
                <div key={type}>
                  <h2 className="text-xs font-bold uppercase tracking-widest text-slate-500 font-headline mb-3">{type}</h2>
                  <div className="space-y-1">
                    {group.map(c => {
                      const outgoing = outgoingMap[c.id] ?? []
                      const incoming = incomingMap[c.id] ?? []
                      const impact = impactLevel(incoming.length)
                      return (
                        <div key={c.id}>
                          <button
                            onClick={() => setExpanded(expanded === c.id ? null : c.id)}
                            className="w-full flex items-center gap-4 px-5 py-3 rounded-xl bg-[#131b2e] border border-white/5 hover:border-white/10 hover:bg-[#171f33] transition-all text-left"
                          >
                            <div className="flex-1 min-w-0">
                              <span className="text-sm font-semibold text-on-surface font-mono">{c.name}</span>
                            </div>
                            <div className="flex items-center gap-2 flex-shrink-0">
                              <ImpactBadge level={impact} />
                              <span className="material-symbols-outlined text-slate-600 transition-transform" style={{ fontSize: '16px', transform: expanded === c.id ? 'rotate(90deg)' : undefined }}>
                                chevron_right
                              </span>
                            </div>
                          </button>
                          {expanded === c.id && (
                            <div className="mt-1 ml-4 rounded-xl bg-[#0f1929] border border-white/5 px-4 py-3">
                              <p className="text-xs text-slate-600">{outgoing.length} outgoing · {incoming.length} incoming · {c.fileCount} files</p>
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>
              )
            })}

            {filtered.length === 0 && (
              <div className="rounded-xl p-12 text-center bg-[#131b2e] border border-white/5">
                <span className="material-symbols-outlined text-slate-600 mb-3 block" style={{ fontSize: '32px' }}>schema</span>
                <p className="text-sm text-slate-500">
                  {components.length === 0
                    ? 'No system model yet. Trigger a scan from the project dashboard.'
                    : 'No components match your filters.'}
                </p>
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  )
}
