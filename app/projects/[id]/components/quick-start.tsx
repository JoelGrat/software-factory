'use client'
import { useState, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'

interface QuickStartProps {
  projectId: string
  onChangeCreated: (changeId: string, clientRequestId: string) => void
}

interface PreFillData {
  intent?: string
  title?: string
}

export function QuickStart({ projectId, onChangeCreated }: QuickStartProps) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [intent, setIntent] = useState('')
  const [priority, setPriority] = useState<'low' | 'medium' | 'high'>('medium')
  const [submitting, setSubmitting] = useState(false)
  const [generatingIntent, setGeneratingIntent] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const intentRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    function handler(e: Event) {
      const detail = (e as CustomEvent<PreFillData>).detail
      if (detail.intent) setIntent(detail.intent)
      if (detail.title) setTitle(detail.title)
      setOpen(true)
    }
    window.addEventListener('open-quick-start', handler)
    return () => window.removeEventListener('open-quick-start', handler)
  }, [])

  function handleClose() {
    setOpen(false)
    setTitle('')
    setIntent('')
    setPriority('medium')
    setError(null)
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
          intent,
          type: 'feature',
          priority,
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
            placeholder="Describe what needs to change and why. Be specific — this drives the impact analysis."
            rows={4}
            className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-blue-500 resize-none"
          />
        </div>

        {/* Priority */}
        <div className="mb-4">
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

        {error && <p className="text-xs text-red-400 mb-4">{error}</p>}

        <div className="flex gap-2">
          <button
            onClick={() => handleSubmit(true)}
            disabled={submitting || !title.trim() || !intent.trim()}
            className="flex-1 bg-blue-600 hover:bg-blue-500 text-white text-sm px-3 py-2 rounded disabled:opacity-50"
          >
            {submitting ? 'Submitting…' : 'Submit Change'}
          </button>
          <button
            onClick={() => handleSubmit(false)}
            disabled={submitting || !title.trim() || !intent.trim()}
            className="flex-1 bg-zinc-700 hover:bg-zinc-600 text-zinc-200 text-sm px-3 py-2 rounded disabled:opacity-50"
          >
            Save draft
          </button>
        </div>
      </div>
    </div>
  )
}
