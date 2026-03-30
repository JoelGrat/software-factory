'use client'
import { useState, useMemo } from 'react'
import Link from 'next/link'
import { LeftNav } from '@/components/app/left-nav'
import { ProfileAvatar } from '@/components/app/profile-avatar'

interface Project { id: string; name: string; scan_status: string }
interface Component {
  id: string; name: string; type: string; status: string;
  is_anchored: boolean; scan_count: number; last_updated: string; fileCount: number;
}
interface Dependency { from_id: string; to_id: string }

const TYPE_COLORS: Record<string, string> = {
  api: 'text-indigo-400 bg-indigo-400/10',
  ui: 'text-blue-400 bg-blue-400/10',
  db: 'text-purple-400 bg-purple-400/10',
  service: 'text-amber-400 bg-amber-400/10',
  module: 'text-slate-400 bg-slate-400/10',
}

function Badge({ label, colorClass }: { label: string; colorClass: string }) {
  return (
    <span className={`text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded font-mono ${colorClass}`}>
      {label}
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
  const [expanded, setExpanded] = useState<string | null>(null)

  const depMap = useMemo(() => {
    const m: Record<string, string[]> = {}
    for (const d of dependencies) {
      if (!m[d.from_id]) m[d.from_id] = []
      m[d.from_id].push(d.to_id)
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
      if (search) {
        const q = search.toLowerCase()
        return c.name.toLowerCase().includes(q)
      }
      return true
    })
  }, [components, search, filterUnstable])

  // Group by type for rendering
  const grouped = useMemo(() => {
    const m = new Map<string, Component[]>()
    for (const c of filtered) {
      if (!m.has(c.type)) m.set(c.type, [])
      m.get(c.type)!.push(c)
    }
    return m
  }, [filtered])

  const typeOrder = ['api', 'ui', 'service', 'db', 'module']

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
                <p className="text-sm text-slate-400 mt-1">{components.length} components detected</p>
              </div>
            </div>

            {/* Search + filters */}
            <div className="flex items-center gap-3 flex-wrap">
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search components…"
                className="rounded-lg px-3 py-2 text-sm outline-none w-64 transition-all"
                style={{
                  background: 'var(--bg-elevated)',
                  border: '1px solid var(--border-default)',
                  color: 'var(--text-primary)',
                }}
                onFocus={e => { e.currentTarget.style.borderColor = 'var(--border-accent)' }}
                onBlur={e => { e.currentTarget.style.borderColor = 'var(--border-default)' }}
              />
              <button
                onClick={() => setFilterUnstable(v => !v)}
                className={`text-xs px-3 py-1.5 rounded-full font-bold font-mono transition-all ${
                  filterUnstable ? 'bg-red-400/20 text-red-300' : 'bg-white/5 text-slate-400 hover:bg-white/10'
                }`}
              >
                Unstable only
              </button>
            </div>

            {/* Components grouped by type */}
            {typeOrder.map(type => {
              const group = grouped.get(type)
              if (!group?.length) return null
              return (
                <div key={type}>
                  <h2 className="text-xs font-bold uppercase tracking-widest text-slate-500 font-headline mb-3">{type}</h2>
                  <div className="space-y-1">
                    {group.map(c => (
                      <div key={c.id}>
                        <button
                          onClick={() => setExpanded(expanded === c.id ? null : c.id)}
                          className="w-full flex items-center gap-4 px-5 py-3 rounded-xl bg-[#131b2e] border border-white/5 hover:border-white/10 hover:bg-[#171f33] transition-all text-left"
                        >
                          <div className="flex-1 min-w-0">
                            <span className="text-sm font-semibold text-on-surface font-mono truncate">{c.name}</span>
                          </div>
                          <div className="flex items-center gap-2 flex-shrink-0">
                            <Badge label={c.type} colorClass={TYPE_COLORS[c.type] ?? 'text-slate-400 bg-slate-400/10'} />
                            {c.status === 'unstable' && <Badge label="unstable" colorClass="text-red-400 bg-red-400/10" />}
                            {c.is_anchored && <Badge label="anchored" colorClass="text-green-400 bg-green-400/10" />}
                            <span className="text-xs text-slate-500 font-mono">{c.fileCount} files</span>
                            <span
                              className="material-symbols-outlined text-slate-600 transition-transform"
                              style={{ fontSize: '16px', transform: expanded === c.id ? 'rotate(90deg)' : undefined }}
                            >
                              chevron_right
                            </span>
                          </div>
                        </button>

                        {expanded === c.id && (
                          <div className="mt-1 ml-4 rounded-xl p-4 bg-[#0f1929] border border-white/5 space-y-3">
                            {depMap[c.id]?.length ? (
                              <div>
                                <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500 font-headline mb-1.5">
                                  Depends on
                                </p>
                                <div className="flex flex-wrap gap-1.5">
                                  {depMap[c.id].map(toId => (
                                    <span
                                      key={toId}
                                      className="text-xs font-mono text-indigo-300 bg-indigo-400/10 px-2 py-0.5 rounded"
                                    >
                                      {componentById[toId]?.name ?? toId}
                                    </span>
                                  ))}
                                </div>
                              </div>
                            ) : (
                              <p className="text-xs text-slate-600">No outgoing dependencies detected.</p>
                            )}
                            <div>
                              <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500 font-headline mb-1">
                                Last scanned
                              </p>
                              <p className="text-xs text-slate-500 font-mono">{new Date(c.last_updated).toLocaleString()}</p>
                            </div>
                            <div>
                              <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500 font-headline mb-1">
                                Scan count
                              </p>
                              <p className="text-xs text-slate-500 font-mono">{c.scan_count}</p>
                            </div>
                          </div>
                        )}
                      </div>
                    ))}
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
