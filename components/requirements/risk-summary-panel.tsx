'use client'
import { useEffect, useState, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import type { RequirementSummary } from '@/lib/supabase/types'
import { Spinner } from '@/components/ui/spinner'

const STATUS_CONFIG = {
  draft:            { icon: '📝', label: 'DRAFT',                     cls: 'border-gray-200 bg-gray-50' },
  analyzing:        { icon: '⏳', label: 'ANALYZING…',                cls: 'border-blue-200 bg-blue-50' },
  incomplete:       { icon: '⛔', label: 'NOT READY FOR DEVELOPMENT', cls: 'border-red-300 bg-red-50' },
  review_required:  { icon: '⚠️',  label: 'REVIEW REQUIRED',           cls: 'border-yellow-300 bg-yellow-50' },
  ready_for_dev:    { icon: '✅', label: 'READY FOR DEVELOPMENT',     cls: 'border-green-300 bg-green-50' },
  blocked:          { icon: '🔒', label: 'BLOCKED',                   cls: 'border-red-400 bg-red-100' },
}

interface Props {
  requirementId: string
  initialSummary: RequirementSummary
  onCriticalClick?: () => void
  onMajorClick?: () => void
  onScoreClick?: () => void
}

export function RiskSummaryPanel({ requirementId, initialSummary, onCriticalClick, onMajorClick, onScoreClick }: Props) {
  const [summary, setSummary] = useState<RequirementSummary>(initialSummary)

  const refresh = useCallback(async () => {
    const res = await fetch(`/api/requirements/${requirementId}/summary`)
    if (res.ok) setSummary(await res.json())
  }, [requirementId])

  useEffect(() => {
    const supabase = createClient()
    const channel = supabase
      .channel(`req-summary-${requirementId}`)
      .on('postgres_changes', {
        event: 'INSERT', schema: 'public', table: 'completeness_scores',
        filter: `requirement_id=eq.${requirementId}`,
      }, () => void refresh())
      .on('postgres_changes', {
        event: 'UPDATE', schema: 'public', table: 'requirements',
        filter: `id=eq.${requirementId}`,
      }, () => void refresh())
      .subscribe()
    return () => { void supabase.removeChannel(channel) }
  }, [requirementId, refresh])

  const cfg = STATUS_CONFIG[summary.status] ?? STATUS_CONFIG.draft
  const isAnalyzing = summary.status === 'analyzing'

  return (
    <div className={`border rounded-lg px-4 py-3 mb-6 flex flex-wrap items-center gap-x-6 gap-y-2 ${cfg.cls}`}>
      {isAnalyzing && <Spinner size="sm" />}
      <span className="font-semibold text-sm">{cfg.icon} {summary.status === 'blocked' ? `${cfg.label} — ${summary.blocked_reason ?? ''}` : cfg.label}</span>

      {!isAnalyzing && summary.status !== 'draft' && (
        <>
          <button
            onClick={onCriticalClick}
            className="text-sm text-red-700 hover:underline font-medium"
          >
            🔴 {summary.critical_count} critical
          </button>
          <button
            onClick={onMajorClick}
            className="text-sm text-orange-700 hover:underline font-medium"
          >
            ⚠️ {summary.major_count} major
          </button>
          <button
            onClick={onScoreClick}
            className="text-sm text-gray-700 hover:underline"
          >
            📉 {summary.overall_score}% overall
          </button>
          <span className="text-sm text-gray-500">
            Confidence: {summary.confidence}%
          </span>
        </>
      )}
    </div>
  )
}
