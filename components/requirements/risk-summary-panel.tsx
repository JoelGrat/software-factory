'use client'
import { useEffect, useState, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import type { RequirementSummary } from '@/lib/supabase/types'
import { Spinner } from '@/components/ui/spinner'

const STATUS_CONFIG = {
  draft:            { label: 'DRAFT',                     dotColor: 'var(--text-muted)',    barColor: 'var(--border-default)' },
  analyzing:        { label: 'ANALYZING',                 dotColor: 'var(--accent)',        barColor: 'var(--accent)' },
  incomplete:       { label: 'NOT READY FOR DEV',         dotColor: 'var(--danger)',        barColor: 'var(--danger)' },
  review_required:  { label: 'REVIEW REQUIRED',           dotColor: 'var(--warning)',       barColor: 'var(--warning)' },
  ready_for_dev:    { label: 'READY FOR DEVELOPMENT',     dotColor: 'var(--success)',       barColor: 'var(--success)' },
  blocked:          { label: 'BLOCKED',                   dotColor: 'var(--danger)',        barColor: 'var(--danger)' },
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
    <div
      className="rounded-xl mb-6 overflow-hidden"
      style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-default)' }}
    >
      <div
        className="h-0.5 w-full"
        style={{ background: cfg.barColor, opacity: 0.7 }}
      />
      <div className="px-5 py-3.5 flex flex-wrap items-center gap-x-6 gap-y-2">
        <div className="flex items-center gap-2.5">
          {isAnalyzing ? (
            <Spinner size="sm" />
          ) : (
            <div
              className="w-2 h-2 rounded-full"
              style={{
                background: cfg.dotColor,
                boxShadow: `0 0 6px ${cfg.dotColor}`,
              }}
            />
          )}
          <span
            className="text-xs font-semibold tracking-widest uppercase"
            style={{ color: cfg.dotColor, fontFamily: 'var(--font-syne)' }}
          >
            {summary.status === 'blocked' ? `${cfg.label} — ${summary.blocked_reason ?? ''}` : cfg.label}
          </span>
        </div>

        {!isAnalyzing && summary.status !== 'draft' && (
          <>
            <div className="h-3 w-px" style={{ background: 'var(--border-strong)' }} />
            <button
              onClick={onCriticalClick}
              className="text-xs font-medium transition-opacity hover:opacity-70"
              style={{ color: 'var(--danger)', fontFamily: 'var(--font-syne)' }}
            >
              {summary.critical_count} critical
            </button>
            <button
              onClick={onMajorClick}
              className="text-xs font-medium transition-opacity hover:opacity-70"
              style={{ color: 'var(--warning)', fontFamily: 'var(--font-syne)' }}
            >
              {summary.major_count} major
            </button>
            <div className="h-3 w-px" style={{ background: 'var(--border-strong)' }} />
            <button
              onClick={onScoreClick}
              className="text-xs transition-opacity hover:opacity-70"
              style={{ color: 'var(--text-secondary)', fontFamily: 'var(--font-jetbrains)' }}
            >
              {summary.overall_score}% complete
            </button>
            <span
              className="text-xs"
              style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-jetbrains)' }}
            >
              {summary.confidence}% confidence
            </span>
          </>
        )}
      </div>
    </div>
  )
}
