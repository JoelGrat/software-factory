'use client'
import { useState, useCallback } from 'react'
import type { RequirementItem, RequirementStatus } from '@/lib/supabase/types'
import type { GapWithDetails } from '@/lib/requirements/gaps-with-details'
import type { RequirementSummary } from '@/lib/supabase/types'
import { RiskSummaryPanel } from '@/components/requirements/risk-summary-panel'
import { ViewInput } from '@/components/requirements/view-input'
import { ViewStructured } from '@/components/requirements/view-structured'
import { ViewGaps } from '@/components/requirements/view-gaps'

type Tab = 'input' | 'structured' | 'gaps'

interface Props {
  requirementId: string
  initialRawInput: string
  initialItems: RequirementItem[]
  initialGaps: GapWithDetails[]
  initialSummary: RequirementSummary
}

export function Workspace({ requirementId, initialRawInput, initialItems, initialGaps, initialSummary }: Props) {
  const [activeTab, setActiveTab] = useState<Tab>('input')
  const [items, setItems] = useState<RequirementItem[]>(initialItems)
  const [gaps, setGaps] = useState<GapWithDetails[]>(initialGaps)
  // status is kept in state so it updates when refreshData runs after partial re-evaluation
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

  async function handleAnalysisComplete() {
    await refreshData()
    setActiveTab('structured')
  }

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

  const activeGaps = gaps.filter(g => !g.resolved_at && !g.merged_into)
  const criticalGapDescriptions = activeGaps
    .filter(g => g.severity === 'critical')
    .map(g => g.description)

  const tabs: { id: Tab; label: string }[] = [
    { id: 'input', label: 'Input' },
    { id: 'structured', label: `Structured (${items.length})` },
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

      {/* Tab nav */}
      <div className="flex border-b mb-6">
        {tabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              activeTab === tab.id
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-gray-500 hover:text-gray-800'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === 'input' && (
        <ViewInput
          requirementId={requirementId}
          initialRawInput={initialRawInput}
          onAnalysisComplete={handleAnalysisComplete}
        />
      )}

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
