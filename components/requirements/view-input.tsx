'use client'
import { useState, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'

const STEP_LABELS: Record<string, string> = {
  parse:     '✓ Requirements parsed',
  gaps:      '✓ Gaps detected',
  questions: '✓ Questions generated',
  tasks:     '✓ Investigation tasks created',
}

interface Props {
  requirementId: string
  initialRawInput: string
  onAnalysisComplete: () => void
}

export function ViewInput({ requirementId, initialRawInput, onAnalysisComplete }: Props) {
  const [text, setText] = useState(initialRawInput)
  const [analyzing, setAnalyzing] = useState(false)
  const [completedSteps, setCompletedSteps] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const channelRef = useRef<ReturnType<ReturnType<typeof createClient>['channel']> | null>(null)

  function subscribeToProgress() {
    const supabase = createClient()
    const channel = supabase
      .channel(`pipeline-${requirementId}`)
      .on('postgres_changes', {
        event: 'INSERT', schema: 'public', table: 'audit_log',
        filter: `entity_id=eq.${requirementId}`,
      }, (payload) => {
        const diff = payload.new?.diff as Record<string, unknown> | undefined
        if (diff?.step && typeof diff.step === 'string') {
          setCompletedSteps(prev => prev.includes(diff.step as string) ? prev : [...prev, diff.step as string])
        }
      })
      .subscribe()
    channelRef.current = channel
    return () => { void supabase.removeChannel(channel) }
  }

  async function handleAnalyze() {
    if (!text.trim()) return
    setError(null)
    setCompletedSteps([])
    setAnalyzing(true)

    // Save raw_input first
    await fetch(`/api/requirements/${requirementId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw_input: text }),
    })

    // Subscribe to progress events
    const unsubscribe = subscribeToProgress()

    try {
      const res = await fetch(`/api/requirements/${requirementId}/analyze`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok || !data.success) {
        setError(data.error ?? 'Analysis failed')
        return
      }
      onAnalysisComplete()
    } catch (err) {
      setError(String(err))
    } finally {
      unsubscribe()
      setAnalyzing(false)
    }
  }

  return (
    <div className="space-y-4">
      <textarea
        value={text}
        onChange={e => setText(e.target.value)}
        disabled={analyzing}
        placeholder="Paste your requirements here — plain text, bullet points, user stories, or meeting notes..."
        className="w-full h-64 border rounded-lg px-3 py-2 font-mono text-sm resize-y focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-60"
      />

      <div className="flex items-start gap-6">
        <Button
          onClick={handleAnalyze}
          loading={analyzing}
          disabled={!text.trim() || analyzing}
        >
          {analyzing ? 'Analyzing…' : 'Analyze Requirements'}
        </Button>

        {analyzing && completedSteps.length > 0 && (
          <ul className="text-sm space-y-1">
            {completedSteps.map(step => (
              <li key={step} className="text-green-700">{STEP_LABELS[step] ?? `✓ ${step}`}</li>
            ))}
            <li className="text-blue-600 animate-pulse">Processing…</li>
          </ul>
        )}
      </div>

      {error && (
        <div className="border border-red-300 bg-red-50 rounded p-3 text-red-700 text-sm">
          {error}
        </div>
      )}
    </div>
  )
}
