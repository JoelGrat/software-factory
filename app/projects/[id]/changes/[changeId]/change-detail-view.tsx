'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { LeftNav } from '@/components/app/left-nav'
import { ProfileAvatar } from '@/components/app/profile-avatar'

interface Project { id: string; name: string }
interface Change {
  id: string
  project_id: string
  title: string
  intent: string
  type: string
  priority: string
  status: string
  risk_level: string | null
  confidence_score: number | null
  analysis_quality: string | null
  tags: string[]
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

const ANALYZING_STATUSES = ['analyzing', 'analyzing_mapping', 'analyzing_propagation', 'analyzing_scoring']

const ANALYSIS_STEPS = [
  { label: 'Mapping intent → components', statuses: ['analyzing', 'analyzing_mapping'] },
  { label: 'Propagating dependency graph', statuses: ['analyzing_propagation'] },
  { label: 'Computing risk score', statuses: ['analyzing_scoring'] },
]

function Badge({ label, colorClass }: { label: string; colorClass: string }) {
  return (
    <span className={`text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded font-mono ${colorClass}`}>
      {label}
    </span>
  )
}

export function ChangeDetailView({ project, change: initial }: { project: Project; change: Change }) {
  const router = useRouter()
  const [change, setChange] = useState(initial)
  const isAnalyzing = ANALYZING_STATUSES.includes(change.status)

  useEffect(() => {
    if (!isAnalyzing) return
    const id = setInterval(async () => {
      const res = await fetch(`/api/change-requests/${change.id}`)
      if (!res.ok) return
      const updated = await res.json()
      setChange(updated)
      if (!ANALYZING_STATUSES.includes(updated.status)) {
        clearInterval(id)
        router.refresh()
      }
    }, 2000)
    return () => clearInterval(id)
  }, [change.id, isAnalyzing, router])

  return (
    <div className="flex flex-col h-screen bg-[#0b1326] text-on-surface overflow-hidden">
      <header className="w-full h-16 flex-shrink-0 flex items-center justify-between px-6 bg-[#0b1326] border-b border-white/5 z-50 font-headline antialiased tracking-tight">
        <div className="flex items-center gap-2 text-sm">
          <Link href="/projects" className="font-black text-indigo-400 tracking-tighter hover:text-indigo-300 transition-colors">FactoryOS</Link>
          <span className="text-slate-600">/</span>
          <Link href={`/projects/${project.id}`} className="text-slate-400 hover:text-slate-200 transition-colors font-medium truncate max-w-[160px]">{project.name}</Link>
          <span className="text-slate-600">/</span>
          <span className="text-slate-200 font-medium truncate max-w-[200px]">{change.title}</span>
        </div>
        <div className="flex items-center gap-1">
          <div className="w-px h-5 bg-white/10 mx-1" />
          <ProfileAvatar />
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        <LeftNav />
        <main className="flex-1 overflow-y-auto bg-[#0b1326] p-10">
          <div className="max-w-3xl mx-auto space-y-8">

            {/* Header */}
            <div className="flex items-start gap-4 flex-wrap">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap mb-2">
                  <Badge label={change.type} colorClass={TYPE_COLORS[change.type] ?? 'text-slate-400 bg-slate-400/10'} />
                  <Badge label={change.priority} colorClass="text-slate-400 bg-slate-400/10" />
                  {change.risk_level && <Badge label={`${change.risk_level} risk`} colorClass={RISK_COLORS[change.risk_level] ?? 'text-slate-400 bg-slate-400/10'} />}
                  {change.tags.map(tag => (
                    <span key={tag} className="text-[10px] px-1.5 py-0.5 rounded-full bg-indigo-400/10 text-indigo-300 font-mono">{tag}</span>
                  ))}
                </div>
                <h1 className="text-2xl font-extrabold font-headline tracking-tight text-on-surface">{change.title}</h1>
                <p className="text-xs text-slate-500 mt-1 font-mono">
                  Created {new Date(change.created_at).toLocaleDateString('en-GB')}
                </p>
              </div>
            </div>

            {/* Intent */}
            <div className="rounded-xl p-5 bg-[#131b2e] border border-white/5">
              <p className="text-xs font-bold uppercase tracking-widest text-slate-400 font-headline mb-2">Intent</p>
              <p className="text-sm text-slate-300 leading-relaxed whitespace-pre-wrap">{change.intent}</p>
            </div>

            {/* Analysis state */}
            {isAnalyzing ? (
              <div className="rounded-xl p-6 bg-[#131b2e] border border-white/5">
                <p className="text-xs font-bold uppercase tracking-widest text-slate-400 font-headline mb-4">Impact Analysis</p>
                <div className="space-y-3">
                  {ANALYSIS_STEPS.map((step, i) => {
                    const isActive = step.statuses.includes(change.status)
                    const isDone = ANALYSIS_STEPS.slice(0, i).some(s => !s.statuses.includes(change.status)) && !isActive
                    return (
                      <div key={step.label} className="flex items-center gap-3">
                        {isActive ? (
                          <span className="relative flex h-2 w-2 flex-shrink-0">
                            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-75" />
                            <span className="relative inline-flex rounded-full h-2 w-2 bg-indigo-400" />
                          </span>
                        ) : isDone ? (
                          <span className="h-2 w-2 rounded-full bg-green-400 flex-shrink-0" />
                        ) : (
                          <span className="h-2 w-2 rounded-full bg-slate-700 flex-shrink-0" />
                        )}
                        <span className={`text-sm ${isActive ? 'text-slate-200' : isDone ? 'text-slate-500' : 'text-slate-600'}`}>
                          {step.label}
                        </span>
                      </div>
                    )
                  })}
                </div>
              </div>
            ) : change.status === 'open' ? (
              <div className="rounded-xl p-6 bg-[#131b2e] border border-white/5 text-center">
                <span className="material-symbols-outlined text-slate-600 mb-2 block" style={{ fontSize: '28px' }}>analytics</span>
                <p className="text-sm text-slate-500">Impact analysis will run when triggered.</p>
                <p className="text-xs text-slate-600 mt-1">Analysis engine coming in a future update.</p>
              </div>
            ) : change.status === 'analyzed' ? (
              <div className="rounded-xl p-6 bg-[#131b2e] border border-white/5">
                <p className="text-xs font-bold uppercase tracking-widest text-slate-400 font-headline mb-2">Impact Analysis</p>
                <p className="text-sm text-slate-400">Analysis complete. Full impact panel coming in Plan 4.</p>
                {change.confidence_score !== null && (
                  <p className="text-xs text-slate-500 mt-1 font-mono">Confidence: {change.confidence_score}%</p>
                )}
              </div>
            ) : null}

          </div>
        </main>
      </div>
    </div>
  )
}
