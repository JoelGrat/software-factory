'use client'
import { useState } from 'react'
import type { RequirementItem, RequirementStatus } from '@/lib/supabase/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

const TYPE_ORDER: RequirementItem['type'][] = ['functional', 'non-functional', 'constraint', 'assumption']
const TYPE_LABELS: Record<RequirementItem['type'], string> = {
  functional: 'Functional Requirements',
  'non-functional': 'Non-Functional Requirements',
  constraint: 'Constraints',
  assumption: 'Assumptions',
}

interface Props {
  items: RequirementItem[]
  gaps: Array<{ id: string; item_id: string | null; severity: string; resolved_at: string | null; merged_into: string | null }>
  status: RequirementStatus
  blockedGapDescriptions: string[]
  requirementId: string
  onMarkReady: () => Promise<void>
  onViewGap?: () => void
}

export function ViewStructured({ items, gaps, status, blockedGapDescriptions, requirementId, onMarkReady, onViewGap }: Props) {
  const [marking, setMarking] = useState(false)
  const [markError, setMarkError] = useState<string | null>(null)

  const activeGapsByItemId = new Map<string, typeof gaps[number][]>()
  for (const gap of gaps) {
    if (!gap.resolved_at && !gap.merged_into && gap.item_id) {
      const list = activeGapsByItemId.get(gap.item_id) ?? []
      list.push(gap)
      activeGapsByItemId.set(gap.item_id, list)
    }
  }

  const grouped = TYPE_ORDER.map(type => ({
    type,
    items: items.filter(i => i.type === type),
  })).filter(g => g.items.length > 0)

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

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <p className="text-sm text-gray-500">{items.length} requirement item{items.length !== 1 ? 's' : ''} extracted</p>
        <div className="text-right">
          {!canMarkReady && blockedGapDescriptions.length > 0 && (
            <div className="mb-2 text-xs text-red-600 max-w-xs">
              Blocked by {blockedGapDescriptions.length} critical gap{blockedGapDescriptions.length > 1 ? 's' : ''}.{' '}
              <button onClick={onViewGap} className="underline">View gaps</button>
            </div>
          )}
          <Button
            variant={isReady ? 'secondary' : 'primary'}
            disabled={!canMarkReady || marking}
            loading={marking}
            onClick={handleMarkReady}
          >
            {isReady ? '✓ Ready for Development' : 'Mark Ready for Dev'}
          </Button>
          {markError && <p className="text-red-600 text-xs mt-1">{markError}</p>}
        </div>
      </div>

      {grouped.map(({ type, items: typeItems }) => (
        <section key={type}>
          <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">
            {TYPE_LABELS[type]} ({typeItems.length})
          </h3>
          <ul className="space-y-2">
            {typeItems.map(item => {
              const itemGaps = activeGapsByItemId.get(item.id) ?? []
              return (
                <li key={item.id} className="border rounded-lg p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1 flex-wrap">
                        <span className="font-medium text-sm">{item.title}</span>
                        <Badge variant={item.priority} label={item.priority} />
                        {item.nfr_category && <Badge variant={item.nfr_category} />}
                      </div>
                      <p className="text-sm text-gray-600">{item.description}</p>
                      {item.source_text && (
                        <p className="text-xs text-gray-400 mt-1 italic">"{item.source_text}"</p>
                      )}
                    </div>
                    {itemGaps.length > 0 && (
                      <div className="flex flex-wrap gap-1 shrink-0">
                        {itemGaps.map(gap => (
                          <Badge key={gap.id} variant={gap.severity as 'critical' | 'major' | 'minor'} />
                        ))}
                      </div>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        </section>
      ))}

      {items.length === 0 && (
        <p className="text-gray-400 text-center py-8">No structured items yet. Run analysis first.</p>
      )}
    </div>
  )
}
