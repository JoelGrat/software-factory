'use client'
import { useState, useCallback, useEffect } from 'react'
import type { RequirementItem, RequirementStatus } from '@/lib/supabase/types'
import type { GapWithDetails } from '@/lib/requirements/gaps-with-details'
import type { RequirementSummary } from '@/lib/supabase/types'
import { JobShell } from '@/components/agent/job-shell'
import { StepIndicator } from '@/components/agent/step-indicator'
import { ViewStructured } from '@/components/requirements/view-structured'
import { ViewGaps } from '@/components/requirements/view-gaps'

type Tab = 'structured' | 'gaps'

const STATUS_CONFIG: Record<RequirementStatus, { label: string; color: string }> = {
  draft:            { label: 'Draft',                 color: '#94a3b8' },
  analyzing:        { label: 'Analyzing',             color: '#818cf8' },
  incomplete:       { label: 'Incomplete',            color: '#f59e0b' },
  review_required:  { label: 'Review Required',       color: '#f59e0b' },
  ready_for_dev:    { label: 'Ready for Planning',     color: '#22c55e' },
  blocked:          { label: 'Blocked',               color: '#ffb4ab' },
}

const TYPE_CONFIG: Record<string, { label: string; color: string }> = {
  functional:       { label: 'Functional',     color: '#818cf8' },
  'non-functional': { label: 'Non-Functional', color: '#34d399' },
  constraint:       { label: 'Constraints',    color: '#f59e0b' },
  assumption:       { label: 'Assumptions',    color: '#94a3b8' },
}

interface Props {
  requirementId: string
  projectId: string
  projectName: string
  targetPath: string | null
  isGenerating: boolean
  initialItems: RequirementItem[]
  initialGaps: GapWithDetails[]
  initialSummary: RequirementSummary
}

export function Workspace({
  requirementId, projectId, projectName, targetPath,
  isGenerating: initialIsGenerating,
  initialItems, initialGaps, initialSummary,
}: Props) {
  const [activeTab, setActiveTab] = useState<Tab>('structured')
  const [items, setItems] = useState<RequirementItem[]>(initialItems)
  const [gaps, setGaps] = useState<GapWithDetails[]>(initialGaps)
  const [status, setStatus] = useState<RequirementStatus>(initialSummary.status as RequirementStatus)
  const [generating, setGenerating] = useState(initialIsGenerating)
  const [showPlanConfirm, setShowPlanConfirm] = useState(false)
  const [startingPlan, setStartingPlan] = useState(false)
  const [planError, setPlanError] = useState<string | null>(null)

  // Poll for live updates while generating
  useEffect(() => {
    if (!generating) return

    const poll = async () => {
      const [itemsRes, visionRes] = await Promise.all([
        fetch(`/api/requirements/${requirementId}/items`),
        fetch(`/api/projects/${projectId}/vision`),
      ])
      if (itemsRes.ok) setItems(await itemsRes.json())
      if (visionRes.ok) {
        const v = await visionRes.json()
        if (v.status === 'done' || v.status === 'failed') setGenerating(false)
      }
    }

    const id = setInterval(poll, 800)
    return () => clearInterval(id)
  }, [generating, requirementId, projectId])

  const refreshData = useCallback(async () => {
    const [itemsRes, gapsRes, reqRes] = await Promise.all([
      fetch(`/api/requirements/${requirementId}/items`),
      fetch(`/api/requirements/${requirementId}/gaps`),
      fetch(`/api/requirements/${requirementId}`),
    ])
    if (itemsRes.ok) setItems(await itemsRes.json())
    if (gapsRes.ok) setGaps(await gapsRes.json())
    if (reqRes.ok) {
      const reqData = await reqRes.json()
      setStatus(reqData.status)
    }
  }, [requirementId])

  async function handleMarkReady() {
    const res = await fetch(`/api/requirements/${requirementId}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'ready_for_dev' }),
    })
    if (!res.ok) {
      const data = await res.json()
      throw new Error(data.error ?? 'Failed to update status')
    }
    setStatus('ready_for_dev')
    void refreshData()
  }

  async function handleStartPlanning() {
    if (!targetPath) {
      setPlanError('Set the project target path in project settings before planning.')
      return
    }
    setStartingPlan(true)
    setPlanError(null)
    const res = await fetch('/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requirement_id: requirementId }),
    })
    setStartingPlan(false)
    if (!res.ok) {
      const err = await res.json()
      setPlanError(err.error ?? 'Failed to start planning')
      return
    }
    const job = await res.json()
    window.location.href = `/projects/${projectId}/jobs/${job.id}/plan`
  }

  const activeGaps = gaps.filter(g => !g.resolved_at && !g.merged_into)
  const criticalGapDescriptions = activeGaps
    .filter(g => g.severity === 'critical')
    .map(g => g.description)

  // ── Sidebar ──────────────────────────────────────────────────────────────────
  const statusCfg = STATUS_CONFIG[status] ?? STATUS_CONFIG.draft
  const byType = Object.entries(TYPE_CONFIG).map(([key, cfg]) => ({
    ...cfg,
    count: items.filter(i => i.type === key).length,
  })).filter(t => t.count > 0)
  const highCount   = items.filter(i => i.priority === 'high').length
  const medCount    = items.filter(i => i.priority === 'medium').length
  const lowCount    = items.filter(i => i.priority === 'low').length

  const sidebar = (
    <div className="p-4 space-y-5">
      {/* Status */}
      <div>
        <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500 font-headline mb-2">Status</p>
        <div className="flex items-center gap-2">
          <span
            className="w-2 h-2 rounded-full flex-shrink-0"
            style={{ background: statusCfg.color, boxShadow: `0 0 6px ${statusCfg.color}` }}
          />
          <span className="text-sm font-semibold" style={{ color: statusCfg.color }}>{statusCfg.label}</span>
        </div>
        {generating && (
          <div className="flex items-center gap-1.5 mt-1.5">
            <span className="relative flex h-1.5 w-1.5 flex-shrink-0">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-indigo-400" />
            </span>
            <span className="text-xs text-indigo-400">{items.length} generated so far</span>
          </div>
        )}
      </div>

      {/* Breakdown by type */}
      {byType.length > 0 && (
        <div>
          <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500 font-headline mb-2">By Type</p>
          <div className="space-y-1.5">
            {byType.map(t => (
              <div key={t.label} className="flex items-center justify-between">
                <span className="text-xs text-slate-400">{t.label}</span>
                <span className="text-xs font-mono font-bold" style={{ color: t.color }}>{t.count}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Priority breakdown */}
      {items.length > 0 && (
        <div>
          <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500 font-headline mb-2">Priority</p>
          <div className="space-y-1.5">
            {highCount > 0 && (
              <div className="flex items-center justify-between">
                <span className="text-xs text-slate-400">High</span>
                <span className="text-xs font-mono font-bold text-error">{highCount}</span>
              </div>
            )}
            {medCount > 0 && (
              <div className="flex items-center justify-between">
                <span className="text-xs text-slate-400">Medium</span>
                <span className="text-xs font-mono font-bold text-amber-400">{medCount}</span>
              </div>
            )}
            {lowCount > 0 && (
              <div className="flex items-center justify-between">
                <span className="text-xs text-slate-400">Low</span>
                <span className="text-xs font-mono font-bold text-slate-500">{lowCount}</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Start Planning shortcut */}
      {status === 'ready_for_dev' && (
        <div className="pt-2 border-t border-white/5">
          <button
            onClick={() => setShowPlanConfirm(true)}
            className="w-full px-4 py-2.5 rounded-lg text-sm font-headline font-bold bg-gradient-to-br from-primary to-primary-container text-on-primary-container flex items-center justify-center gap-2 hover:scale-[1.02] transition-transform active:scale-95"
          >
            <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>architecture</span>
            Start Planning
          </button>
        </div>
      )}
    </div>
  )

  const tabs: { id: Tab; label: string }[] = [
    { id: 'structured', label: `Requirements (${items.length})` },
    { id: 'gaps', label: `Gaps (${activeGaps.length})` },
  ]

  return (
    <JobShell
      projectName={projectName}
      projectId={projectId}
      sidebar={sidebar}
      sidebarTitle="Overview"
    >
      <StepIndicator current={2} />

      {/* Generating banner */}
      {generating && (
        <div className="flex items-center gap-3 mb-6 px-4 py-3 rounded-xl bg-indigo-500/10 border border-indigo-500/20">
          <span className="relative flex h-2.5 w-2.5 flex-shrink-0">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-indigo-400" />
          </span>
          <span className="text-sm text-indigo-300 font-headline font-semibold">Generating requirements...</span>
          <span className="text-xs text-indigo-400/60 font-mono ml-auto">{items.length} added so far</span>
        </div>
      )}

      {/* Tab bar */}
      <div className="flex items-center gap-4 mb-6">
        <div className="flex gap-1 p-1 rounded-lg" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', display: 'inline-flex' }}>
          {tabs.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className="px-4 py-2 rounded-md text-sm transition-all"
              style={{
                background: activeTab === tab.id ? 'var(--bg-elevated)' : 'transparent',
                color: activeTab === tab.id ? 'var(--text-primary)' : 'var(--text-muted)',
                fontFamily: 'var(--font-syne)',
                fontWeight: activeTab === tab.id ? '600' : '400',
                border: activeTab === tab.id ? '1px solid var(--border-default)' : '1px solid transparent',
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Ready for Planning banner */}
      {status === 'ready_for_dev' && (
        <div className="flex items-center justify-between mb-6 px-5 py-4 rounded-xl bg-[#22c55e]/8 border border-[#22c55e]/20">
          <div className="flex items-center gap-3">
            <span className="material-symbols-outlined text-[#22c55e]" style={{ fontSize: '20px' }}>check_circle</span>
            <div>
              <p className="text-sm font-headline font-bold text-[#22c55e]">Ready for Planning</p>
              <p className="text-xs text-slate-500 mt-0.5">All requirements are finalized. Start the planning phase to generate tasks and a spec.</p>
            </div>
          </div>
          <button
            onClick={() => setShowPlanConfirm(true)}
            className="flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-headline font-bold bg-gradient-to-br from-primary to-primary-container text-on-primary-container shadow-[0_4px_20px_rgba(189,194,255,0.15)] hover:scale-[1.02] active:scale-95 transition-all flex-shrink-0 ml-4"
          >
            <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>architecture</span>
            Start Planning
          </button>
        </div>
      )}

      {activeTab === 'structured' && (
        <ViewStructured
          requirementId={requirementId}
          items={items}
          gaps={gaps}
          status={status}
          isGenerating={generating}
          blockedGapDescriptions={criticalGapDescriptions}
          onMarkReady={handleMarkReady}
          onAdd={item => setItems(prev => [...prev, item])}
          onViewGap={() => setActiveTab('gaps')}
        />
      )}

      {activeTab === 'gaps' && (
        <ViewGaps
          requirementId={requirementId}
          gaps={gaps}
          onUpdate={() => void refreshData()}
          onReanalyze={async () => {
            const res = await fetch(`/api/requirements/${requirementId}/analyze`, { method: 'POST' })
            if (!res.ok) {
              const d = await res.json()
              throw new Error(d.error ?? 'Analysis failed')
            }
            await refreshData()
          }}
        />
      )}

      {/* Confirmation modal */}
      {showPlanConfirm && (
        <ConfirmPlanModal
          items={items}
          activeGaps={activeGaps}
          starting={startingPlan}
          error={planError}
          onConfirm={() => void handleStartPlanning()}
          onCancel={() => { setShowPlanConfirm(false); setPlanError(null) }}
        />
      )}
    </JobShell>
  )
}

// ── Confirmation modal ────────────────────────────────────────────────────────

interface ConfirmPlanModalProps {
  items: RequirementItem[]
  activeGaps: GapWithDetails[]
  starting: boolean
  error: string | null
  onConfirm: () => void
  onCancel: () => void
}

function ConfirmPlanModal({ items, activeGaps, starting, error, onConfirm, onCancel }: ConfirmPlanModalProps) {
  const byType = [
    { label: 'Functional',     key: 'functional',       color: '#818cf8' },
    { label: 'Non-Functional', key: 'non-functional',   color: '#34d399' },
    { label: 'Constraints',    key: 'constraint',       color: '#f59e0b' },
    { label: 'Assumptions',    key: 'assumption',       color: '#94a3b8' },
  ].map(t => ({ ...t, count: items.filter(i => i.type === t.key).length })).filter(t => t.count > 0)

  const criticalGaps = activeGaps.filter(g => g.severity === 'critical')
  const majorGaps    = activeGaps.filter(g => g.severity === 'major')

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)' }}>
      <div className="w-full max-w-md rounded-2xl border border-white/10 shadow-2xl" style={{ background: 'var(--bg-elevated)' }}>
        {/* Header */}
        <div className="px-6 pt-6 pb-4 border-b border-white/5">
          <div className="flex items-center gap-3 mb-1">
            <span className="material-symbols-outlined text-indigo-400" style={{ fontSize: '22px' }}>architecture</span>
            <h2 className="text-lg font-extrabold font-headline text-white">Start Planning?</h2>
          </div>
          <p className="text-sm text-slate-400">Confirm that all requirements are set before generating the plan and spec.</p>
        </div>

        {/* Body */}
        <div className="px-6 py-5 space-y-4">
          {/* Requirements summary */}
          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500 font-headline mb-2">
              {items.length} Requirement{items.length !== 1 ? 's' : ''}
            </p>
            <div className="grid grid-cols-2 gap-2">
              {byType.map(t => (
                <div key={t.key} className="flex items-center justify-between px-3 py-2 rounded-lg bg-surface-container border border-white/5">
                  <span className="text-xs text-slate-400">{t.label}</span>
                  <span className="text-xs font-mono font-bold" style={{ color: t.color }}>{t.count}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Gap warnings */}
          {(criticalGaps.length > 0 || majorGaps.length > 0) && (
            <div className="rounded-lg border border-amber-400/20 bg-amber-400/5 px-4 py-3 space-y-1">
              <div className="flex items-center gap-2 mb-2">
                <span className="material-symbols-outlined text-amber-400" style={{ fontSize: '16px' }}>warning</span>
                <p className="text-xs font-bold text-amber-400 font-headline uppercase tracking-wide">Unresolved Gaps</p>
              </div>
              {criticalGaps.length > 0 && (
                <p className="text-xs text-slate-300">
                  <span className="text-error font-bold">{criticalGaps.length} critical</span> gap{criticalGaps.length !== 1 ? 's' : ''} — planning may produce an incomplete spec.
                </p>
              )}
              {majorGaps.length > 0 && (
                <p className="text-xs text-slate-400">
                  <span className="text-amber-400 font-bold">{majorGaps.length} major</span> gap{majorGaps.length !== 1 ? 's' : ''} may affect implementation quality.
                </p>
              )}
            </div>
          )}

          {activeGaps.length === 0 && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[#22c55e]/8 border border-[#22c55e]/20">
              <span className="material-symbols-outlined text-[#22c55e]" style={{ fontSize: '16px' }}>check_circle</span>
              <p className="text-xs text-[#22c55e] font-semibold">No active gaps — requirements look complete.</p>
            </div>
          )}

          {error && <p className="text-xs text-error font-mono">{error}</p>}
        </div>

        {/* Footer */}
        <div className="px-6 pb-6 flex gap-3 justify-end">
          <button
            onClick={onCancel}
            disabled={starting}
            className="px-4 py-2 rounded-lg text-sm text-slate-400 hover:text-slate-200 hover:bg-surface-container transition-all"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={starting}
            className="flex items-center gap-2 px-5 py-2 rounded-lg text-sm font-headline font-bold bg-gradient-to-br from-primary to-primary-container text-on-primary-container disabled:opacity-50 hover:scale-[1.02] active:scale-95 transition-all"
          >
            {starting
              ? <><span className="material-symbols-outlined animate-spin" style={{ fontSize: '16px' }}>progress_activity</span> Starting...</>
              : <><span className="material-symbols-outlined" style={{ fontSize: '16px' }}>architecture</span> Generate Plan & Spec</>
            }
          </button>
        </div>
      </div>
    </div>
  )
}
