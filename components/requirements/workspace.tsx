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
  ready_for_dev:    { label: 'Ready for Dev',         color: '#22c55e' },
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

  async function handleRunAgent() {
    if (!targetPath) {
      alert('Set the project target path in project settings before running the agent.')
      return
    }
    const res = await fetch('/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requirement_id: requirementId }),
    })
    if (!res.ok) {
      const err = await res.json()
      alert(err.error ?? 'Failed to start agent')
      return
    }
    const job = await res.json()
    window.location.href = `/projects/${projectId}/jobs/${job.id}/execution`
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

      {/* Run Agent shortcut */}
      {status === 'ready_for_dev' && (
        <div className="pt-2 border-t border-white/5">
          <button
            onClick={handleRunAgent}
            className="w-full px-4 py-2.5 rounded-lg text-sm font-headline font-bold bg-gradient-to-br from-primary to-primary-container text-on-primary-container flex items-center justify-center gap-2 hover:scale-[1.02] transition-transform active:scale-95"
          >
            <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>rocket_launch</span>
            Run Agent
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

      {activeTab === 'structured' && (
        <ViewStructured
          items={items}
          gaps={gaps}
          status={status}
          isGenerating={generating}
          blockedGapDescriptions={criticalGapDescriptions}
          onMarkReady={handleMarkReady}
          onViewGap={() => setActiveTab('gaps')}
        />
      )}

      {activeTab === 'gaps' && (
        <ViewGaps
          requirementId={requirementId}
          gaps={gaps}
          onUpdate={() => void refreshData()}
        />
      )}
    </JobShell>
  )
}
