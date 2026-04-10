'use client'
import { useState, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'

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
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [intent, setIntent] = useState('')
  const [showComponents, setShowComponents] = useState(false)
  const [selectedComponents, setSelectedComponents] = useState<string[]>([])
  const [priority, setPriority] = useState<'low' | 'medium' | 'high'>('medium')
  const [riskLevel, setRiskLevel] = useState<RiskLevel>('medium')
  const [submitting, setSubmitting] = useState(false)
  const [generatingIntent, setGeneratingIntent] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [intentMismatch, setIntentMismatch] = useState<string | null>(null)
  const intentRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    function handler(e: Event) {
      const detail = (e as CustomEvent<PreFillData>).detail
      if (detail.intent) setIntent(detail.intent)
      if (detail.componentId) {
        setSelectedComponents([detail.componentId])
        setShowComponents(true)
      }
      setOpen(true)
    }
    window.addEventListener('open-quick-start', handler)
    return () => window.removeEventListener('open-quick-start', handler)
  }, [])

  function handleClose() {
    setOpen(false)
    setTitle('')
    setIntent('')
    setSelectedComponents([])
    setShowComponents(false)
    setPriority('medium')
    setRiskLevel('medium')
    setError(null)
    setIntentMismatch(null)
  }

  async function generateIntent() {
    if (!title.trim() || generatingIntent) return
    setGeneratingIntent(true)
    try {
      const res = await fetch('/api/ai/generate-intent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, intent, type: 'feature' }),
      })
      if (res.ok) {
        const data = await res.json()
        setIntent(data.intent)
      }
    } finally {
      setGeneratingIntent(false)
    }
  }

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

  async function handleSubmit(startImmediately: boolean) {
    if (!title.trim() || !intent.trim()) return
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
          title,
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
      handleClose()

      if (startImmediately) {
        await fetch(`/api/change-requests/${changeId}/execute`, {
          method: 'POST',
          headers: { 'X-Client-Request-Id': clientRequestId },
        })
      }

      router.refresh()
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
      <div className="absolute inset-0 bg-black/40" onClick={handleClose} />

      <div className="relative bg-zinc-900 border-l border-zinc-700 w-full max-w-lg h-full overflow-y-auto p-6 shadow-2xl">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-base font-semibold text-zinc-100">New Change</h2>
          <button onClick={handleClose} className="text-zinc-400 hover:text-zinc-200">
            <span className="material-symbols-outlined" style={{ fontSize: '20px' }}>close</span>
          </button>
        </div>

        {/* Title */}
        <div className="mb-4">
          <label className="text-xs text-zinc-400 mb-1 block">Title</label>
          <input
            value={title}
            onChange={e => setTitle(e.target.value)}
            placeholder="Short description of the change"
            className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-blue-500"
          />
        </div>

        {/* Intent */}
        <div className="mb-4">
          <div className="flex items-center justify-between mb-1">
            <label className="text-xs text-zinc-400">Intent</label>
            <button
              type="button"
              onClick={generateIntent}
              disabled={!title.trim() || generatingIntent}
              className="flex items-center gap-1 text-xs font-semibold text-indigo-400 hover:text-indigo-300 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {generatingIntent ? (
                <>
                  <span className="material-symbols-outlined animate-spin" style={{ fontSize: '13px' }}>progress_activity</span>
                  {intent.trim() ? 'Improving…' : 'Generating…'}
                </>
              ) : (
                <>
                  <span className="material-symbols-outlined" style={{ fontSize: '13px' }}>auto_awesome</span>
                  {intent.trim() ? 'Improve' : 'Generate'}
                </>
              )}
            </button>
          </div>
          <textarea
            ref={intentRef}
            value={intent}
            onChange={e => setIntent(e.target.value)}
            onBlur={handleIntentBlur}
            placeholder="Describe what needs to change and why. Be specific — this drives the impact analysis."
            rows={4}
            className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-blue-500 resize-none"
          />
        </div>

        {/* Mismatch warning */}
        {intentMismatch && (
          <div className="mb-4 rounded-lg border border-amber-500/40 bg-amber-950/20 p-3 text-xs text-amber-300">
            Intent mentions &quot;{intentMismatch}&quot; but it&apos;s not selected.{' '}
            <button
              className="underline"
              onClick={() => {
                const c = components.find(c => c.name === intentMismatch)
                if (c) {
                  setSelectedComponents(prev => [...prev, c.id])
                  setShowComponents(true)
                }
                setIntentMismatch(null)
              }}
            >
              Add {intentMismatch}
            </button>
            {' '}·{' '}
            <button className="underline" onClick={() => setIntentMismatch(null)}>Ignore</button>
          </div>
        )}

        {/* Affected Components (optional, collapsed by default) */}
        <div className="mb-4">
          <button
            type="button"
            onClick={() => setShowComponents(v => !v)}
            className="flex items-center gap-1.5 text-xs text-zinc-400 hover:text-zinc-200 transition-colors mb-2"
          >
            <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>
              {showComponents ? 'expand_less' : 'expand_more'}
            </span>
            Affected Components {selectedComponents.length > 0 && `(${selectedComponents.length} selected)`}
            <span className="text-zinc-600 ml-1">— optional</span>
          </button>
          {showComponents && (
            <div className="space-y-1 max-h-40 overflow-y-auto bg-zinc-800 border border-zinc-700 rounded-lg p-2">
              {components.map(c => (
                <label key={c.id} className="flex items-center gap-2 cursor-pointer hover:bg-zinc-700 px-2 py-1 rounded">
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
          )}
        </div>

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
                disabled={submitting || !title.trim() || !intent.trim()}
                className="flex-1 bg-amber-700 hover:bg-amber-600 text-white text-sm px-3 py-2 rounded disabled:opacity-50"
              >
                {submitting ? 'Starting…' : 'Start anyway'}
              </button>
              <button
                onClick={() => handleSubmit(false)}
                disabled={submitting || !title.trim() || !intent.trim()}
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
              disabled={submitting || !title.trim() || !intent.trim()}
              className="flex-1 bg-blue-600 hover:bg-blue-500 text-white text-sm px-3 py-2 rounded disabled:opacity-50"
            >
              {submitting ? 'Starting…' : 'Start Execution →'}
            </button>
            <button
              onClick={() => handleSubmit(false)}
              disabled={submitting || !title.trim() || !intent.trim()}
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
