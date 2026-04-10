'use client'
import { useState, useEffect, useRef } from 'react'

interface Component {
  id: string
  name: string
  confidence: number
}

interface QuickStartProps {
  projectId: string
  components: Component[]
  onChangeCreated: (changeId: string, clientRequestId: string) => void
}

interface PreFillData {
  intent?: string
  componentId?: string
}

const RISK_LEVELS = ['low', 'medium', 'high'] as const
type RiskLevel = typeof RISK_LEVELS[number]

export function QuickStart({ projectId, components, onChangeCreated }: QuickStartProps) {
  const [open, setOpen] = useState(false)
  const [intent, setIntent] = useState('')
  const [selectedComponents, setSelectedComponents] = useState<string[]>([])
  const [priority, setPriority] = useState<'low' | 'medium' | 'high'>('medium')
  const [riskLevel, setRiskLevel] = useState<RiskLevel>('medium')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [intentMismatch, setIntentMismatch] = useState<string | null>(null)
  const intentRef = useRef<HTMLTextAreaElement>(null)

  // Listen for open-quick-start events from other components (Risk Radar, Next Best Actions)
  useEffect(() => {
    function handler(e: Event) {
      const detail = (e as CustomEvent<PreFillData>).detail
      if (detail.intent) setIntent(detail.intent)
      if (detail.componentId) setSelectedComponents([detail.componentId])
      setOpen(true)
    }
    window.addEventListener('open-quick-start', handler)
    return () => window.removeEventListener('open-quick-start', handler)
  }, [])

  // Detect intent/component mismatch on blur
  function handleIntentBlur() {
    if (!intent) return
    const lowerIntent = intent.toLowerCase()
    const mismatch = components.find(
      c => lowerIntent.includes(c.name.toLowerCase()) && !selectedComponents.includes(c.id)
    )
    setIntentMismatch(mismatch ? mismatch.name : null)
  }

  const impactCount = selectedComponents.length
  const isHighRisk = riskLevel === 'high' || impactCount >= 4
  const intentTooShort = intent.trim().length < 15

  async function handleSubmit(startImmediately: boolean) {
    if (!intent.trim()) return
    setSubmitting(true)
    setError(null)

    const clientRequestId = crypto.randomUUID()

    try {
      const res = await fetch('/api/change-requests', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Client-Request-Id': clientRequestId,
        },
        body: JSON.stringify({
          project_id: projectId,
          title: intent.slice(0, 100),
          description: intent,
          type: 'feature',
          priority,
          risk_level: riskLevel,
          component_ids: selectedComponents,
        }),
      })

      if (!res.ok) {
        const err = await res.json()
        setError(err.error ?? 'Failed to create change')
        return
      }

      const { id: changeId } = await res.json()
      onChangeCreated(changeId, clientRequestId)
      setOpen(false)
      setIntent('')
      setSelectedComponents([])
      setPriority('medium')
      setRiskLevel('medium')

      if (startImmediately) {
        await fetch(`/api/change-requests/${changeId}/execute`, {
          method: 'POST',
          headers: { 'X-Client-Request-Id': clientRequestId },
        })
      }
    } finally {
      setSubmitting(false)
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-6 right-6 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium px-4 py-2 rounded-lg shadow-lg"
      >
        + New Change
      </button>
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-end">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} />

      {/* Panel */}
      <div className="relative bg-zinc-900 border-l border-zinc-700 w-full max-w-lg h-full overflow-y-auto p-6 shadow-2xl">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-base font-semibold text-zinc-100">New Change</h2>
          <button onClick={() => setOpen(false)} className="text-zinc-400 hover:text-zinc-200">✕</button>
        </div>

        {/* Intent */}
        <div className="mb-4">
          <label className="text-xs text-zinc-400 mb-1 block">Intent</label>
          <textarea
            ref={intentRef}
            value={intent}
            onChange={e => setIntent(e.target.value)}
            onBlur={handleIntentBlur}
            placeholder={`e.g. "Add dependency mapping between AuthService and API layer"`}
            rows={3}
            className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-blue-500 resize-none"
          />
          {intentTooShort && intent.length > 0 && (
            <p className="text-xs text-amber-400 mt-1">Add more detail for better analysis</p>
          )}
        </div>

        {/* Mismatch warning */}
        {intentMismatch && (
          <div className="mb-4 rounded-lg border border-amber-500/40 bg-amber-950/20 p-3 text-xs text-amber-300">
            Intent mentions &quot;{intentMismatch}&quot; but it&apos;s not selected.{' '}
            <button
              className="underline"
              onClick={() => {
                const c = components.find(c => c.name === intentMismatch)
                if (c) setSelectedComponents(prev => [...prev, c.id])
                setIntentMismatch(null)
              }}
            >
              Add {intentMismatch}
            </button>
            {' '}·{' '}
            <button className="underline" onClick={() => setIntentMismatch(null)}>Ignore</button>
          </div>
        )}

        {/* Components */}
        <div className="mb-4">
          <label className="text-xs text-zinc-400 mb-1 block">Affected Components</label>
          <div className="space-y-1 max-h-40 overflow-y-auto">
            {components.map(c => (
              <label key={c.id} className="flex items-center gap-2 cursor-pointer hover:bg-zinc-800 px-2 py-1 rounded">
                <input
                  type="checkbox"
                  checked={selectedComponents.includes(c.id)}
                  onChange={e => {
                    setSelectedComponents(prev =>
                      e.target.checked ? [...prev, c.id] : prev.filter(id => id !== c.id)
                    )
                  }}
                  className="accent-blue-500"
                />
                <span className="text-sm text-zinc-200">{c.name}</span>
                <span className="text-xs text-zinc-500">{c.confidence}%</span>
              </label>
            ))}
          </div>
        </div>

        {/* Impact preview */}
        {selectedComponents.length > 0 && (
          <div className="mb-4 rounded-lg bg-zinc-800 border border-zinc-700 p-3 text-xs text-zinc-400">
            Impact preview: {selectedComponents.length} component{selectedComponents.length > 1 ? 's' : ''} in scope
          </div>
        )}

        {/* Priority + Risk */}
        <div className="grid grid-cols-2 gap-4 mb-4">
          <div>
            <label className="text-xs text-zinc-400 mb-1 block">Priority</label>
            <select
              value={priority}
              onChange={e => setPriority(e.target.value as typeof priority)}
              className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-200"
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
          </div>
          <div>
            <label className="text-xs text-zinc-400 mb-1 block">Risk Level</label>
            <select
              value={riskLevel}
              onChange={e => setRiskLevel(e.target.value as RiskLevel)}
              className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-200"
            >
              {RISK_LEVELS.map(r => (
                <option key={r} value={r}>{r.charAt(0).toUpperCase() + r.slice(1)}</option>
              ))}
            </select>
          </div>
        </div>

        {error && <p className="text-xs text-red-400 mb-4">{error}</p>}

        {/* Actions */}
        {isHighRisk ? (
          <div className="rounded-lg border border-amber-500/40 bg-amber-950/20 p-3 mb-4">
            <p className="text-xs text-amber-300 mb-3">
              ⚠ This change affects {impactCount} components
              {riskLevel === 'high' ? ' and is flagged as high risk' : ''}
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => handleSubmit(true)}
                disabled={submitting || !intent.trim()}
                className="flex-1 bg-amber-700 hover:bg-amber-600 text-white text-sm px-3 py-2 rounded disabled:opacity-50"
              >
                {submitting ? 'Starting…' : 'Start anyway'}
              </button>
              <button
                onClick={() => handleSubmit(false)}
                disabled={submitting || !intent.trim()}
                className="flex-1 bg-zinc-700 hover:bg-zinc-600 text-zinc-200 text-sm px-3 py-2 rounded disabled:opacity-50"
              >
                Review first
              </button>
            </div>
          </div>
        ) : (
          <div className="flex gap-2">
            <button
              onClick={() => handleSubmit(true)}
              disabled={submitting || !intent.trim()}
              className="flex-1 bg-blue-600 hover:bg-blue-500 text-white text-sm px-3 py-2 rounded disabled:opacity-50"
            >
              {submitting ? 'Starting…' : 'Start Execution →'}
            </button>
            <button
              onClick={() => handleSubmit(false)}
              disabled={submitting || !intent.trim()}
              className="flex-1 bg-zinc-700 hover:bg-zinc-600 text-zinc-200 text-sm px-3 py-2 rounded disabled:opacity-50"
            >
              Review first
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
