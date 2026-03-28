'use client'
import { useState, useMemo } from 'react'
import type { RequirementItem, RequirementStatus } from '@/lib/supabase/types'

const TYPE_ORDER: RequirementItem['type'][] = ['functional', 'non-functional', 'constraint', 'assumption']

const TYPE_CONFIG: Record<RequirementItem['type'], { label: string; icon: string; color: string }> = {
  functional:       { label: 'Functional',       icon: 'check_box',        color: '#818cf8' },
  'non-functional': { label: 'Non-Functional',   icon: 'speed',            color: '#34d399' },
  constraint:       { label: 'Constraints',      icon: 'block',            color: '#f59e0b' },
  assumption:       { label: 'Assumptions',      icon: 'help_outline',     color: '#94a3b8' },
}

const PRIORITY_STYLES: Record<string, string> = {
  high:   'text-error',
  medium: 'text-amber-400',
  low:    'text-slate-500',
}

interface Props {
  items: RequirementItem[]
  gaps: Array<{ id: string; item_id: string | null; severity: string; resolved_at: string | null; merged_into: string | null }>
  status: RequirementStatus
  blockedGapDescriptions: string[]
  onMarkReady: () => Promise<void>
  onViewGap?: () => void
}

export function ViewStructured({ items, gaps, status, blockedGapDescriptions, onMarkReady, onViewGap }: Props) {
  const [marking, setMarking] = useState(false)
  const [markError, setMarkError] = useState<string | null>(null)

  const activeGapsByItemId = useMemo(() => {
    const map = new Map<string, typeof gaps[number][]>()
    for (const gap of gaps) {
      if (!gap.resolved_at && !gap.merged_into && gap.item_id) {
        const list = map.get(gap.item_id) ?? []
        list.push(gap)
        map.set(gap.item_id, list)
      }
    }
    return map
  }, [gaps])

  const grouped = useMemo(() =>
    TYPE_ORDER.map(type => ({
      type,
      items: items.filter(i => i.type === type),
    })).filter(g => g.items.length > 0),
  [items])

  const canMarkReady = status === 'review_required' || status === 'ready_for_dev'
  const isReady = status === 'ready_for_dev'

  async function handleMarkReady() {
    setMarking(true)
    setMarkError(null)
    try {
      await onMarkReady()
    } catch (err) {
      setMarkError(String(err))
    } finally {
      setMarking(false)
    }
  }

  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <span className="material-symbols-outlined text-slate-600 mb-4" style={{ fontSize: '40px' }}>edit_note</span>
        <p className="text-slate-400 text-sm">No requirements yet.</p>
        <p className="text-slate-600 text-xs mt-1">Generate them from the Vision step.</p>
      </div>
    )
  }

  return (
    <div className="space-y-8">
      {/* Header row */}
      <div className="flex items-start justify-between">
        <p className="text-sm text-slate-500 font-mono">{items.length} item{items.length !== 1 ? 's' : ''}</p>
        <div className="text-right">
          {!canMarkReady && blockedGapDescriptions.length > 0 && (
            <p className="mb-2 text-xs text-error max-w-xs">
              Blocked by {blockedGapDescriptions.length} critical gap{blockedGapDescriptions.length > 1 ? 's' : ''}.{' '}
              {onViewGap && <button onClick={onViewGap} className="underline opacity-70 hover:opacity-100">View gaps</button>}
            </p>
          )}
          <button
            disabled={!canMarkReady || marking}
            onClick={handleMarkReady}
            className={[
              'px-5 py-2 rounded-lg text-sm font-headline font-bold flex items-center gap-2 transition-all',
              isReady
                ? 'bg-[#22c55e]/10 text-[#22c55e] border border-[#22c55e]/30'
                : canMarkReady
                  ? 'bg-gradient-to-br from-primary to-primary-container text-on-primary-container shadow-[0_4px_20px_rgba(189,194,255,0.15)] hover:scale-[1.02] active:scale-95'
                  : 'bg-surface-container text-slate-500 border border-white/5 cursor-not-allowed',
            ].join(' ')}
          >
            {marking ? (
              <>
                <span className="material-symbols-outlined animate-spin" style={{ fontSize: '16px' }}>progress_activity</span>
                Saving...
              </>
            ) : isReady ? (
              <>
                <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>check_circle</span>
                Ready for Development
              </>
            ) : (
              'Mark Ready for Dev'
            )}
          </button>
          {markError && <p className="text-error text-xs mt-1 font-mono">{markError}</p>}
        </div>
      </div>

      {/* Grouped sections */}
      {grouped.map(({ type, items: typeItems }) => {
        const cfg = TYPE_CONFIG[type]
        return (
          <section key={type}>
            <div className="flex items-center gap-2 mb-3">
              <span className="material-symbols-outlined" style={{ fontSize: '16px', color: cfg.color }}>{cfg.icon}</span>
              <h3 className="text-[10px] font-bold uppercase tracking-widest font-headline" style={{ color: cfg.color }}>
                {cfg.label}
              </h3>
              <span className="text-[10px] font-mono text-slate-600 ml-1">({typeItems.length})</span>
            </div>

            <ul className="space-y-2">
              {typeItems.map(item => {
                const itemGaps = activeGapsByItemId.get(item.id) ?? []
                const hasCritical = itemGaps.some(g => g.severity === 'critical')

                return (
                  <li
                    key={item.id}
                    className={[
                      'rounded-xl p-4 border transition-all',
                      hasCritical
                        ? 'bg-error/5 border-error/20'
                        : 'bg-surface-container border-white/5',
                    ].join(' ')}
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1 flex-wrap">
                          <span className="font-semibold text-sm text-on-surface">{item.title}</span>
                          <span className={`text-[10px] font-bold uppercase font-headline ${PRIORITY_STYLES[item.priority] ?? 'text-slate-500'}`}>
                            {item.priority}
                          </span>
                          {item.nfr_category && (
                            <span className="text-[10px] font-mono text-slate-500 bg-surface-container-high rounded px-1.5 py-0.5">
                              {item.nfr_category}
                            </span>
                          )}
                        </div>
                        <p className="text-sm text-slate-400 leading-relaxed">{item.description}</p>
                      </div>

                      {itemGaps.length > 0 && (
                        <div className="flex flex-col gap-1 flex-shrink-0 items-end">
                          {itemGaps.map(gap => (
                            <span
                              key={gap.id}
                              className={[
                                'text-[10px] font-bold uppercase font-headline px-2 py-0.5 rounded',
                                gap.severity === 'critical' ? 'bg-error/10 text-error' :
                                gap.severity === 'major' ? 'bg-amber-400/10 text-amber-400' :
                                'bg-slate-500/10 text-slate-400',
                              ].join(' ')}
                            >
                              {gap.severity}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </li>
                )
              })}
            </ul>
          </section>
        )
      })}
    </div>
  )
}
