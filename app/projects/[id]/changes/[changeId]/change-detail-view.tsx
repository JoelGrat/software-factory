'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { LeftNav } from '@/components/app/left-nav'
import { ProfileAvatar } from '@/components/app/profile-avatar'

interface Project { id: string; name: string }

interface ImpactData {
  id: string
  risk_score: number | null
  blast_radius: number | null
  primary_risk_factor: string | null
  analysis_quality: string | null
  requires_migration: boolean | null
  requires_data_change: boolean | null
}

interface RiskFactor {
  factor: string
  weight: number
}

interface ImpactComponent {
  component_id: string
  impact_weight: number
  source: string
  system_components: { name: string; type: string } | null
}

interface PlanData {
  id: string
  status: string
  spec_markdown: string | null
  estimated_tasks: number | null
  estimated_files: number | null
  approved_at: string | null
}

interface PlanTask {
  id: string
  component_id: string | null
  description: string
  order_index: number
  status: string
  system_components: { name: string; type: string } | null
}

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

const ANALYZING_STATUSES = ['analyzing', 'analyzing_mapping', 'analyzing_propagation', 'analyzing_scoring', 'planning']

const ANALYSIS_STEPS = [
  { label: 'Mapping intent → components', statuses: ['analyzing', 'analyzing_mapping'] },
  { label: 'Propagating dependency graph', statuses: ['analyzing_propagation'] },
  { label: 'Computing risk score', statuses: ['analyzing_scoring'] },
  { label: 'Generating implementation plan', statuses: ['planning'] },
]

function Badge({ label, colorClass }: { label: string; colorClass: string }) {
  return (
    <span className={`text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded font-mono ${colorClass}`}>
      {label}
    </span>
  )
}

export function ChangeDetailView({
  project,
  change: initial,
  impact: initialImpact,
  riskFactors: initialRiskFactors,
  impactComponents: initialImpactComponents,
  plan: initialPlan,
  planTasks: initialPlanTasks,
}: {
  project: Project
  change: Change
  impact: ImpactData | null
  riskFactors: RiskFactor[]
  impactComponents: ImpactComponent[]
  plan: PlanData | null
  planTasks: PlanTask[]
}) {
  const router = useRouter()
  const [change, setChange] = useState(initial)
  const [impact, setImpact] = useState(initialImpact)
  const [riskFactors, setRiskFactors] = useState(initialRiskFactors)
  const [impactComponents, setImpactComponents] = useState(initialImpactComponents)
  const [plan, setPlan] = useState(initialPlan)
  const [planTasks, setPlanTasks] = useState(initialPlanTasks)
  const [planTab, setPlanTab] = useState<'tasks' | 'spec'>('tasks')
  const [approving, setApproving] = useState(false)
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
        setImpact(updated.impact ?? null)
        setRiskFactors(updated.risk_factors ?? [])
        setImpactComponents(updated.impact_components ?? [])
        setPlan(updated.plan ?? null)
        setPlanTasks(updated.plan_tasks ?? [])
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
                  {(() => {
                    const currentStepIndex = ANALYSIS_STEPS.findIndex(s => s.statuses.includes(change.status))
                    return ANALYSIS_STEPS.map((step, i) => {
                      const isActive = step.statuses.includes(change.status)
                      const isDone = i < currentStepIndex
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
                    })
                  })()}
                </div>
              </div>
            ) : change.status === 'open' ? (
              <div className="rounded-xl p-6 bg-[#131b2e] border border-white/5 text-center">
                <span className="material-symbols-outlined text-slate-600 mb-3 block" style={{ fontSize: '28px' }}>analytics</span>
                <p className="text-sm text-slate-400 mb-4">Run impact analysis to see which components this change affects.</p>
                <button
                  onClick={async () => {
                    const res = await fetch(`/api/change-requests/${change.id}/analyze`, { method: 'POST' })
                    if (res.ok) {
                      setChange(c => ({ ...c, status: 'analyzing_mapping' }))
                    }
                  }}
                  className="px-4 py-2 rounded-lg bg-indigo-500 hover:bg-indigo-400 text-white text-sm font-bold font-headline transition-colors"
                >
                  Run Analysis
                </button>
              </div>
            ) : change.status === 'analyzed' && impact ? (
              <div className="rounded-xl bg-[#131b2e] border border-white/5 overflow-hidden">
                {/* Header row */}
                <div className="flex items-center justify-between px-5 py-4 border-b border-white/5">
                  <p className="text-xs font-bold uppercase tracking-widest text-slate-400 font-headline">Impact Analysis</p>
                  <div className="flex items-center gap-2">
                    {change.confidence_score !== null && (
                      <span className="text-[10px] font-mono text-slate-500">{change.confidence_score}% confidence</span>
                    )}
                    {impact.analysis_quality && (
                      <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-700 text-slate-400 uppercase tracking-wider">
                        {impact.analysis_quality.replace('_', ' ')}
                      </span>
                    )}
                  </div>
                </div>

                {/* Risk score + blast radius */}
                <div className="grid grid-cols-3 divide-x divide-white/5 border-b border-white/5">
                  <div className="px-5 py-4">
                    <p className="text-[10px] uppercase tracking-widest text-slate-500 font-headline mb-1">Risk Level</p>
                    <p className={`text-lg font-extrabold font-headline capitalize ${
                      change.risk_level === 'high' ? 'text-red-400' :
                      change.risk_level === 'medium' ? 'text-amber-400' : 'text-green-400'
                    }`}>{change.risk_level ?? '—'}</p>
                  </div>
                  <div className="px-5 py-4">
                    <p className="text-[10px] uppercase tracking-widest text-slate-500 font-headline mb-1">Risk Score</p>
                    <p className="text-lg font-extrabold font-headline text-on-surface font-mono">{impact.risk_score ?? '—'}</p>
                  </div>
                  <div className="px-5 py-4">
                    <p className="text-[10px] uppercase tracking-widest text-slate-500 font-headline mb-1">Blast Radius</p>
                    <p className="text-lg font-extrabold font-headline text-on-surface font-mono">
                      {impact.blast_radius ?? '—'}
                      <span className="text-xs font-normal text-slate-500 ml-1">components</span>
                    </p>
                  </div>
                </div>

                {/* Migration flags */}
                {(impact.requires_migration || impact.requires_data_change) && (
                  <div className="px-5 py-3 border-b border-white/5 flex items-center gap-3 flex-wrap">
                    {impact.requires_migration && (
                      <span className="flex items-center gap-1.5 text-xs text-amber-300 font-mono">
                        <span className="material-symbols-outlined text-amber-400" style={{ fontSize: '14px' }}>warning</span>
                        Schema migration required
                      </span>
                    )}
                    {impact.requires_data_change && (
                      <span className="flex items-center gap-1.5 text-xs text-orange-300 font-mono">
                        <span className="material-symbols-outlined text-orange-400" style={{ fontSize: '14px' }}>database</span>
                        Data migration required
                      </span>
                    )}
                  </div>
                )}

                {/* Affected components */}
                {impactComponents.length > 0 && (
                  <div className="px-5 py-4 border-b border-white/5">
                    <p className="text-[10px] uppercase tracking-widest text-slate-500 font-headline mb-3">Affected Components</p>
                    <div className="space-y-2">
                      {impactComponents.map((ic) => (
                        <div key={ic.component_id} className="flex items-center justify-between">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="text-[10px] font-mono px-1 py-0.5 rounded bg-indigo-400/10 text-indigo-300 uppercase flex-shrink-0">
                              {ic.system_components?.type ?? '?'}
                            </span>
                            <span className="text-sm text-slate-300 font-mono truncate">
                              {ic.system_components?.name ?? ic.component_id}
                            </span>
                          </div>
                          <div className="flex items-center gap-2 flex-shrink-0">
                            <div
                              className="h-1.5 rounded-full bg-indigo-500/40"
                              style={{ width: `${Math.round(ic.impact_weight * 60 + 12)}px` }}
                            />
                            <span className="text-[10px] font-mono text-slate-500 w-8 text-right">
                              {Math.round(ic.impact_weight * 100)}%
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Risk factors */}
                {riskFactors.length > 0 && (
                  <div className="px-5 py-4">
                    <p className="text-[10px] uppercase tracking-widest text-slate-500 font-headline mb-3">Risk Factors</p>
                    <div className="space-y-1.5">
                      {riskFactors.map((rf) => (
                        <div key={rf.factor} className="flex items-center justify-between">
                          <span className="text-xs text-slate-400 font-mono capitalize">{rf.factor.replace(/_/g, ' ')}</span>
                          <span className="text-xs font-mono text-slate-500">+{rf.weight}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Generate Plan CTA */}
                <div className="px-5 py-4 border-t border-white/5 flex items-center justify-between">
                  <div className="text-xs text-slate-500 font-mono">
                    {change.risk_level === 'high' && (
                      <span className="text-red-400">High risk — confirmation required</span>
                    )}
                  </div>
                  <button
                    onClick={async () => {
                      const confirmed = change.risk_level !== 'high' ||
                        window.confirm('This change carries high risk. Generate a plan anyway?')
                      if (!confirmed) return
                      const res = await fetch(`/api/change-requests/${change.id}/plan`, { method: 'POST' })
                      if (res.ok) setChange(c => ({ ...c, status: 'planning' }))
                    }}
                    className="px-4 py-2 rounded-lg bg-indigo-500 hover:bg-indigo-400 text-white text-sm font-bold font-headline transition-colors"
                  >
                    Generate Plan
                  </button>
                </div>
              </div>
            ) : change.status === 'analyzed' && !impact ? (
              <div className="rounded-xl p-6 bg-[#131b2e] border border-white/5 text-center">
                <p className="text-sm text-slate-500">Analysis complete but impact data unavailable.</p>
              </div>
            ) : (change.status === 'planned' || change.status === 'approved') && plan ? (
              <div className="rounded-xl bg-[#131b2e] border border-white/5 overflow-hidden">
                {/* Plan header */}
                <div className="flex items-center justify-between px-5 py-4 border-b border-white/5">
                  <p className="text-xs font-bold uppercase tracking-widest text-slate-400 font-headline">Implementation Plan</p>
                  <div className="flex items-center gap-3">
                    {plan.estimated_tasks !== null && (
                      <span className="text-[10px] font-mono text-slate-500">{plan.estimated_tasks} tasks</span>
                    )}
                    <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded uppercase tracking-wider ${
                      plan.status === 'approved'
                        ? 'bg-green-400/10 text-green-400'
                        : 'bg-slate-700 text-slate-400'
                    }`}>
                      {plan.status}
                    </span>
                  </div>
                </div>

                {/* Tab bar */}
                <div className="flex border-b border-white/5">
                  {(['tasks', 'spec'] as const).map(tab => (
                    <button
                      key={tab}
                      onClick={() => setPlanTab(tab)}
                      className={`px-5 py-2.5 text-xs font-bold uppercase tracking-widest font-headline transition-colors ${
                        planTab === tab
                          ? 'text-indigo-400 border-b-2 border-indigo-400'
                          : 'text-slate-500 hover:text-slate-300'
                      }`}
                    >
                      {tab}
                    </button>
                  ))}
                </div>

                {/* Tasks tab */}
                {planTab === 'tasks' && (
                  <div className="divide-y divide-white/5">
                    {planTasks.length === 0 ? (
                      <p className="px-5 py-6 text-sm text-slate-500 text-center">No tasks generated.</p>
                    ) : (
                      planTasks.map((task) => (
                        <div key={task.id} className="px-5 py-3 flex items-start gap-3">
                          <span className={`mt-0.5 h-2 w-2 rounded-full flex-shrink-0 ${
                            task.status === 'done' ? 'bg-green-400' : 'bg-slate-600'
                          }`} />
                          <div className="flex-1 min-w-0">
                            <p className="text-sm text-slate-300">{task.description}</p>
                            {task.system_components && (
                              <span className="text-[10px] font-mono text-slate-600 mt-0.5 block">
                                {task.system_components.name}
                              </span>
                            )}
                          </div>
                          <span className="text-[10px] font-mono text-slate-600 flex-shrink-0">
                            #{task.order_index + 1}
                          </span>
                        </div>
                      ))
                    )}
                  </div>
                )}

                {/* Spec tab */}
                {planTab === 'spec' && (
                  <div className="px-5 py-4">
                    {plan.spec_markdown ? (
                      <pre className="text-xs text-slate-400 font-mono whitespace-pre-wrap leading-relaxed">
                        {plan.spec_markdown}
                      </pre>
                    ) : (
                      <p className="text-sm text-slate-500 text-center py-4">Spec not available.</p>
                    )}
                  </div>
                )}

                {/* Approve footer */}
                {plan.status !== 'approved' && (
                  <div className="px-5 py-4 border-t border-white/5 flex items-center justify-end gap-3">
                    <button
                      onClick={async () => {
                        const res = await fetch(`/api/change-requests/${change.id}/plan`, { method: 'POST' })
                        if (res.ok) setChange(c => ({ ...c, status: 'planning' }))
                      }}
                      className="px-3 py-1.5 rounded-lg border border-white/10 text-slate-400 hover:text-slate-200 text-xs font-bold font-headline transition-colors"
                    >
                      Regenerate
                    </button>
                    <button
                      disabled={approving}
                      onClick={async () => {
                        setApproving(true)
                        const res = await fetch(`/api/change-requests/${change.id}/plan`, {
                          method: 'PATCH',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ action: 'approve' }),
                        })
                        if (res.ok) {
                          setPlan(p => p ? { ...p, status: 'approved' } : p)
                        }
                        setApproving(false)
                      }}
                      className="px-4 py-2 rounded-lg bg-green-500 hover:bg-green-400 disabled:opacity-50 text-white text-sm font-bold font-headline transition-colors"
                    >
                      {approving ? 'Approving…' : 'Approve Plan'}
                    </button>
                  </div>
                )}
              </div>
            ) : null}

          </div>
        </main>
      </div>
    </div>
  )
}
