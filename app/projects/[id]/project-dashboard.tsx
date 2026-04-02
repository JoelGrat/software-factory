'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { LeftNav } from '@/components/app/left-nav'
import { ProfileAvatar } from '@/components/app/profile-avatar'

interface Project {
  id: string
  name: string
  scan_status: string
  scan_error: string | null
  repo_url: string | null
  created_at: string
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

function Badge({ label, colorClass }: { label: string; colorClass: string }) {
  return (
    <span className={`text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded font-mono ${colorClass}`}>
      {label}
    </span>
  )
}

function ScanStatusStrip({ project, onRescan }: { project: Project; onRescan: () => void }) {
  const isScanning = project.scan_status === 'scanning'
  return (
    <div className="flex items-center gap-3 px-5 py-3 rounded-xl bg-[#131b2e] border border-white/5">
      {isScanning ? (
        <span className="relative flex h-2.5 w-2.5 flex-shrink-0">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-75" />
          <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-indigo-400" />
        </span>
      ) : (
        <span className={`h-2.5 w-2.5 rounded-full flex-shrink-0 ${
          project.scan_status === 'ready' ? 'bg-green-400' :
          project.scan_status === 'failed' ? 'bg-red-400' : 'bg-slate-500'
        }`} />
      )}
      <div className="flex-1 min-w-0">
        <span className="text-xs text-slate-400">
          {isScanning ? 'Scanning repository…' :
           project.scan_status === 'ready' ? 'System model ready' :
           project.scan_status === 'failed' ? `Scan failed: ${project.scan_error ?? 'unknown error'}` :
           project.repo_url ? 'Repository connected — scan pending' : 'No repository connected'}
        </span>
      </div>
      <div className="flex items-center gap-3 flex-shrink-0">
        {!isScanning && project.repo_url && (
          <button
            onClick={onRescan}
            className="text-xs text-slate-400 hover:text-slate-200 transition-colors"
          >
            Rescan
          </button>
        )}
        {project.scan_status === 'ready' && (
          <Link
            href={`/projects/${project.id}/system-model`}
            className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors"
          >
            View model →
          </Link>
        )}
      </div>
    </div>
  )
}

export function ProjectDashboard({ project: initial, initialChanges }: { project: Project; initialChanges: Change[] }) {
  const router = useRouter()
  const [project, setProject] = useState(initial)
  const [changes] = useState(initialChanges)

  useEffect(() => {
    if (project.scan_status !== 'scanning') return
    const id = setInterval(async () => {
      const res = await fetch(`/api/projects/${project.id}`)
      if (!res.ok) return
      const updated = await res.json()
      setProject(updated)
      if (updated.scan_status !== 'scanning') {
        clearInterval(id)
        router.refresh()
      }
    }, 3000)
    return () => clearInterval(id)
  }, [project.id, project.scan_status, router])

  async function handleRescan() {
    const res = await fetch(`/api/projects/${project.id}/scan`, { method: 'POST' })
    if (!res.ok) return
    setProject(p => ({ ...p, scan_status: 'scanning', scan_error: null }))
  }

  return (
    <div className="flex flex-col h-screen bg-[#0b1326] text-on-surface overflow-hidden">
      <header className="w-full h-16 flex-shrink-0 flex items-center justify-between px-6 bg-[#0b1326] border-b border-white/5 z-50 font-headline antialiased tracking-tight">
        <div className="flex items-center gap-2 text-sm">
          <Link href="/projects" className="font-black text-indigo-400 tracking-tighter hover:text-indigo-300 transition-colors">
            FactoryOS
          </Link>
          <span className="text-slate-600">/</span>
          <span className="text-slate-200 font-medium truncate max-w-[240px]">{project.name}</span>
        </div>
        <div className="flex items-center gap-1">
          <button className="p-2 text-slate-400 hover:bg-[#171f33] rounded-lg transition-all" title="Settings">
            <span className="material-symbols-outlined text-[20px]">settings</span>
          </button>
          <div className="w-px h-5 bg-white/10 mx-1" />
          <ProfileAvatar />
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        <LeftNav />
        <main className="flex-1 overflow-y-auto bg-[#0b1326] p-10">
          <div className="max-w-3xl mx-auto space-y-8">

            {/* Header */}
            <div className="flex items-start justify-between">
              <div>
                <p className="text-xs uppercase tracking-widest font-bold text-indigo-400 font-headline mb-1">Project</p>
                <h1 className="text-3xl font-extrabold font-headline tracking-tight text-on-surface">{project.name}</h1>
              </div>
              <Link
                href={`/projects/${project.id}/changes/new`}
                className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold bg-indigo-600 hover:bg-indigo-500 text-white transition-all active:scale-95 font-headline"
              >
                <span className="material-symbols-outlined text-[16px]">add</span>
                New Change
              </Link>
            </div>

            {/* Scan status */}
            <ScanStatusStrip project={project} onRescan={handleRescan} />

            {/* Change list */}
            <div>
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-bold text-slate-300 font-headline">Changes</h2>
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
                        <p className="text-sm font-semibold text-on-surface font-headline truncate">{c.title}</p>
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
          </div>
        </main>
      </div>
    </div>
  )
}
