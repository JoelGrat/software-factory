'use client'
import { useState, useRef, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'

const STEP_LABELS: Record<string, string> = {
  parse:     'Requirements parsed',
  gaps:      'Gaps detected',
  questions: 'Questions generated',
  tasks:     'Investigation tasks created',
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
  const cleanupRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    return () => { cleanupRef.current?.() }
  }, [])

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
    return () => { void supabase.removeChannel(channel) }
  }

  async function handleAnalyze() {
    if (!text.trim()) return
    setError(null)
    setCompletedSteps([])
    setAnalyzing(true)

    const unsubscribe = subscribeToProgress()
    let cleaned = false
    const doCleanup = () => {
      if (cleaned) return
      cleaned = true
      unsubscribe()
      cleanupRef.current = null
    }
    cleanupRef.current = doCleanup

    try {
      const saveRes = await fetch(`/api/requirements/${requirementId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ raw_input: text }),
      })
      if (!saveRes.ok) {
        const saveData = await saveRes.json().catch(() => ({}))
        setError((saveData as { error?: string }).error ?? 'Failed to save requirements text')
        return
      }

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
      doCleanup()
      setAnalyzing(false)
    }
  }

  return (
    <div className="space-y-4">
      <textarea
        value={text}
        onChange={e => setText(e.target.value)}
        disabled={analyzing}
        placeholder="Paste requirements here — plain text, bullet points, user stories, or meeting notes…"
        className="w-full h-72 rounded-xl px-5 py-4 text-sm resize-y outline-none transition-all disabled:opacity-40"
        style={{
          background: 'var(--bg-surface)',
          border: '1px solid var(--border-default)',
          color: 'var(--text-primary)',
          fontFamily: 'var(--font-jetbrains)',
          fontSize: '13px',
          lineHeight: '1.7',
        }}
        onFocus={e => { e.currentTarget.style.borderColor = 'var(--border-accent)' }}
        onBlur={e => { e.currentTarget.style.borderColor = 'var(--border-default)' }}
      />

      <div className="flex items-center gap-6">
        <Button
          onClick={handleAnalyze}
          loading={analyzing}
          disabled={!text.trim() || analyzing}
        >
          {analyzing ? 'Analyzing…' : 'Analyze Requirements'}
        </Button>

        {analyzing && completedSteps.length > 0 && (
          <ul className="space-y-1.5">
            {completedSteps.map(step => (
              <li key={step} className="flex items-center gap-2 text-xs" style={{ color: 'var(--success)', fontFamily: 'var(--font-syne)' }}>
                <svg className="w-3 h-3" viewBox="0 0 12 12" fill="none">
                  <path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
                {STEP_LABELS[step] ?? step}
              </li>
            ))}
            <li className="flex items-center gap-2 text-xs animate-pulse" style={{ color: 'var(--accent)', fontFamily: 'var(--font-syne)' }}>
              <svg className="w-3 h-3 animate-spin" viewBox="0 0 12 12" fill="none">
                <circle cx="6" cy="6" r="4" stroke="currentColor" strokeWidth="1.5" strokeDasharray="6 6" />
              </svg>
              Processing…
            </li>
          </ul>
        )}
      </div>

      {error && (
        <div
          className="rounded-lg px-4 py-3 text-sm"
          style={{
            background: 'var(--danger-soft)',
            border: '1px solid rgba(255,69,69,0.2)',
            color: 'var(--danger)',
          }}
        >
          {error}
        </div>
      )}
    </div>
  )
}
