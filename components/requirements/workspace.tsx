'use client'
import { useState, useCallback } from 'react'
import type { RequirementItem, RequirementStatus } from '@/lib/supabase/types'
import type { GapWithDetails } from '@/lib/requirements/gaps-with-details'
import type { RequirementSummary } from '@/lib/supabase/types'
import { RiskSummaryPanel } from '@/components/requirements/risk-summary-panel'
import { ViewStructured } from '@/components/requirements/view-structured'
import { ViewGaps } from '@/components/requirements/view-gaps'

type Tab = 'structured' | 'gaps'

interface Props {
  requirementId: string
  projectId: string
  targetPath: string | null
  initialItems: RequirementItem[]
  initialGaps: GapWithDetails[]
  initialSummary: RequirementSummary
}

export function Workspace({ requirementId, projectId, targetPath, initialItems, initialGaps, initialSummary }: Props) {
  const [activeTab, setActiveTab] = useState<Tab>('structured')
  const [items, setItems] = useState<RequirementItem[]>(initialItems)
  const [gaps, setGaps] = useState<GapWithDetails[]>(initialGaps)
  const [status, setStatus] = useState<RequirementStatus>(initialSummary.status as RequirementStatus)

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

  const tabs: { id: Tab; label: string }[] = [
    { id: 'structured', label: `Requirements (${items.length})` },
    { id: 'gaps', label: `Gaps (${activeGaps.length})` },
  ]

  return (
    <div>
      <RiskSummaryPanel
        requirementId={requirementId}
        initialSummary={{ ...initialSummary, status }}
        onCriticalClick={() => setActiveTab('gaps')}
        onMajorClick={() => setActiveTab('gaps')}
        onScoreClick={() => setActiveTab('gaps')}
      />

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
                letterSpacing: '0.01em',
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {status === 'ready_for_dev' && (
          <button
            onClick={handleRunAgent}
            className="px-4 py-2 rounded-lg text-sm font-medium transition-all"
            style={{
              background: 'var(--accent)',
              color: '#000',
              fontFamily: 'var(--font-jetbrains)',
            }}
          >
            Run Agent
          </button>
        )}
      </div>

      {activeTab === 'structured' && (
        <ViewStructured
          items={items}
          gaps={gaps}
          status={status}
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
    </div>
  )
}
