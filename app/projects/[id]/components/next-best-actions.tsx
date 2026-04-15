'use client'
import Link from 'next/link'

interface ActionItem {
  id: string
  tier: number
  source: string
  priorityScore: number
  payload: {
    label: string
    componentId?: string
    componentName?: string
    errorType?: string
    affectedComponents?: string[]
    count?: number
    total?: number
    confidence?: number
    centrality?: number
    riskScore?: number
    lastOccurredAt?: string
    // baseline_blocked fields
    suggestedTitle?: string
    suggestedIntent?: string
    category?: string
    blockedChangeId?: string
  }
}

interface NextBestActionsProps {
  actionItems: ActionItem[]
  projectId: string
}

function formatTimeAgo(iso?: string): string {
  if (!iso) return ''
  const diff = Date.now() - new Date(iso).getTime()
  const hours = Math.floor(diff / (1000 * 60 * 60))
  if (hours < 1) return 'just now'
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

function ActionCard({ item, index, projectId }: { item: ActionItem; index: number; projectId: string }) {
  const isHigh = item.tier === 1
  const isMedium = item.tier === 2
  const isOpportunity = item.tier === 3

  const badgeClass = isHigh
    ? 'bg-red-900 text-red-300'
    : isMedium
    ? 'bg-amber-900 text-amber-300'
    : 'bg-zinc-800 text-zinc-400'
  const badgeLabel = isHigh ? 'HIGH' : isMedium ? 'MEDIUM' : 'LOW'

  const isBaselineBlocked = item.source === 'baseline_blocked'

  const sourceLabel: Record<string, string> = {
    pattern: 'Pattern',
    risk_radar: 'Risk Radar',
    model_quality: 'Model Quality',
    opportunity: 'Opportunity',
    baseline_blocked: 'Infrastructure',
  }

  const timeHook = item.payload.lastOccurredAt
    ? `(last occurrence ${formatTimeAgo(item.payload.lastOccurredAt)})`
    : ''

  function openQuickStart(intent: string, componentId?: string, title?: string) {
    window.dispatchEvent(new CustomEvent('open-quick-start', {
      detail: { intent, componentId, title },
    }))
  }

  return (
    <div className={`rounded-lg border p-3 text-sm ${
      isHigh ? 'border-red-500/30 bg-red-950/10'
      : isMedium ? 'border-amber-500/20 bg-amber-950/10'
      : 'border-zinc-700 bg-zinc-900/50'
    }`}>
      <div className="flex items-start gap-2">
        <span className="text-zinc-500 text-xs font-mono mt-0.5">{index + 1}</span>
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-1">
            <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${badgeClass}`}>
              {badgeLabel}
            </span>
            <span className="text-xs text-zinc-500">
              · {sourceLabel[item.source] ?? item.source}
            </span>
          </div>

          <p className="text-zinc-200 font-medium text-xs mb-1">{item.payload.label}</p>

          {item.payload.affectedComponents && item.payload.affectedComponents.length > 0 && (
            <p className="text-xs text-zinc-500 mb-1">
              Affects {item.payload.affectedComponents.slice(0, 3).join(', ')}
              {timeHook && ` ${timeHook}`}
            </p>
          )}

          {item.payload.count != null && item.payload.total != null && (
            <p className="text-xs text-zinc-500 mb-2">
              {item.payload.count} of {item.payload.total} recent runs {timeHook}
            </p>
          )}

          <div className="flex gap-2">
            {isOpportunity ? (
              <Link
                href={`/projects/${projectId}/system-model`}
                className="text-xs text-zinc-400 hover:text-zinc-200 underline"
              >
                View in System Model →
              </Link>
            ) : isBaselineBlocked ? (
              <button
                onClick={() => openQuickStart(
                  item.payload.suggestedIntent ?? item.payload.label,
                  undefined,
                  item.payload.suggestedTitle,
                )}
                className="text-xs bg-red-900 hover:bg-red-800 text-red-200 px-2 py-1 rounded font-medium"
              >
                Create Fix Change →
              </button>
            ) : (
              <button
                onClick={() => openQuickStart(item.payload.label, item.payload.componentId)}
                className="text-xs bg-zinc-800 hover:bg-zinc-700 text-zinc-200 px-2 py-1 rounded"
              >
                {item.source === 'risk_radar' ? 'Stabilize Component' : 'Create Fix Change →'}
              </button>
            )}
            {item.payload.componentId && !isBaselineBlocked && !isOpportunity && (
              <Link
                href={`/projects/${projectId}/system-model`}
                className="text-xs text-zinc-400 hover:text-zinc-200 underline"
              >
                View in System Model →
              </Link>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

export function NextBestActions({ actionItems, projectId }: NextBestActionsProps) {
  const onlyOpportunities = actionItems.every(i => i.tier === 3)

  if (actionItems.length === 0) {
    return (
      <section>
        <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wide mb-3">Next Best Actions</h2>
        <p className="text-sm text-zinc-500">No urgent actions — system looks healthy.</p>
      </section>
    )
  }

  return (
    <section>
      <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wide mb-3">
        {onlyOpportunities ? 'System looks healthy — optimize next:' : 'Next Best Actions'}
      </h2>
      <div className="space-y-2">
        {actionItems.map((item, i) => (
          <ActionCard key={item.id} item={item} index={i} projectId={projectId} />
        ))}
      </div>
    </section>
  )
}
