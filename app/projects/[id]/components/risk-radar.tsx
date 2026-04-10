'use client'

interface RiskScore {
  componentId: string
  componentName: string
  riskScore: number
  tier: 'HIGH' | 'MEDIUM'
  previousScore?: number
  incomingDeps: number
  missRate?: number
  confidence?: number
}

interface RiskRadarProps {
  riskScores: RiskScore[]
  projectId: string
}

function getTrend(current: number, previous?: number): '↑ worsening' | '→ stable' | '↓ improving' {
  if (previous == null) return '→ stable'
  const delta = (current - previous) * 100
  if (delta >= 10) return '↑ worsening'
  if (delta <= -10) return '↓ improving'
  return '→ stable'
}

function RiskCard({ score, projectId }: { score: RiskScore; projectId: string }) {
  const trend = getTrend(score.riskScore, score.previousScore)
  const trendColor = trend.startsWith('↑') ? 'text-red-400' : trend.startsWith('↓') ? 'text-green-400' : 'text-zinc-400'
  const tierColor = score.tier === 'HIGH' ? 'bg-red-900 text-red-300' : 'bg-amber-900 text-amber-300'

  const reasons: string[] = []
  if (score.missRate != null && score.missRate > 0) {
    reasons.push(`Missed in ~${Math.round(score.missRate * 100)}% of recent runs`)
  }
  if (score.confidence != null && score.confidence < 60) {
    reasons.push(`Low model confidence: ${Math.round(score.confidence)}%`)
  }
  if (score.incomingDeps > 2) {
    reasons.push(`Shared by ${score.incomingDeps} components (high centrality)`)
  }

  function openQuickStart(intent: string) {
    window.dispatchEvent(new CustomEvent('open-quick-start', { detail: { intent, componentId: score.componentId } }))
  }

  return (
    <div className="rounded-lg border border-zinc-700 bg-zinc-900 p-3 text-sm">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="font-mono text-zinc-200 text-xs">{score.componentName}</span>
          <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${tierColor}`}>
            {score.tier} RISK
          </span>
        </div>
        <span className={`text-xs ${trendColor}`}>{trend}</span>
      </div>

      {reasons.length > 0 && (
        <div className="mb-2">
          <p className="text-xs text-zinc-500 mb-1">Why this ranks high:</p>
          <ul className="space-y-0.5">
            {reasons.map((r, i) => (
              <li key={i} className="text-xs text-zinc-400">· {r}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex gap-2 mt-2">
        <button
          onClick={() => openQuickStart(`Improve model coverage and dependency mapping for ${score.componentName}`)}
          className="text-xs bg-zinc-800 hover:bg-zinc-700 text-zinc-200 px-2 py-1 rounded"
        >
          Stabilize Component
        </button>
        <button className="text-xs text-zinc-400 hover:text-zinc-200 underline">
          View in System Model →
        </button>
      </div>
    </div>
  )
}

export function RiskRadar({ riskScores, projectId }: RiskRadarProps) {
  if (riskScores.length === 0) {
    return (
      <section>
        <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wide mb-3">Risk Radar</h2>
        <p className="text-sm text-zinc-500">No high-risk components detected — model coverage looks healthy.</p>
      </section>
    )
  }

  return (
    <section>
      <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wide mb-3">Risk Radar</h2>
      <div className="space-y-2">
        {riskScores.slice(0, 5).map(s => (
          <RiskCard key={s.componentId} score={s} projectId={projectId} />
        ))}
      </div>
    </section>
  )
}
