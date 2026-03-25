'use client'
import { useState } from 'react'
import type { GapWithDetails } from '@/lib/requirements/gaps-with-details'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

interface DecisionForm {
  decision: string
  rationale: string
}

interface Props {
  requirementId: string
  gaps: GapWithDetails[]
  onUpdate: () => void   // called after any mutation to trigger parent re-fetch
}

export function ViewGaps({ requirementId, gaps, onUpdate }: Props) {
  const [showAll, setShowAll] = useState(false)
  const [expandedGapId, setExpandedGapId] = useState<string | null>(null)
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [savingAnswer, setSavingAnswer] = useState<string | null>(null)
  const [showDecision, setShowDecision] = useState<string | null>(null)
  const [decisionForms, setDecisionForms] = useState<Record<string, DecisionForm>>({})
  const [savingDecision, setSavingDecision] = useState<string | null>(null)
  const [generatingQuestion, setGeneratingQuestion] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})

  // gaps arrive pre-sorted by priority_score desc from buildGapsWithDetails
  const allNonMerged = gaps.filter(g => !g.merged_into)
  const topGaps = allNonMerged.slice(0, 10)   // top 10 by priority regardless of question presence
  const displayedGaps = showAll ? allNonMerged : topGaps

  async function saveAnswer(gap: GapWithDetails) {
    if (!gap.question) return
    const answer = answers[gap.id]?.trim()
    if (!answer) return
    setSavingAnswer(gap.id)
    setErrors(prev => ({ ...prev, [gap.id]: '' }))
    try {
      const res = await fetch(`/api/questions/${gap.question.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answer }),
      })
      if (!res.ok) {
        const d = await res.json()
        setErrors(prev => ({ ...prev, [gap.id]: d.error ?? 'Failed to save answer' }))
        return
      }
      onUpdate()
    } finally {
      setSavingAnswer(null)
    }
  }

  async function saveDecision(gap: GapWithDetails) {
    const form = decisionForms[gap.id]
    if (!form?.decision?.trim() || !form?.rationale?.trim()) {
      setErrors(prev => ({ ...prev, [gap.id]: 'Both decision and rationale are required' }))
      return
    }
    setSavingDecision(gap.id)
    setErrors(prev => ({ ...prev, [gap.id]: '' }))
    try {
      const res = await fetch(`/api/requirements/${requirementId}/decisions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          gap_id: gap.id,
          question_id: gap.question?.id ?? null,
          decision: form.decision.trim(),
          rationale: form.rationale.trim(),
        }),
      })
      if (!res.ok) {
        const d = await res.json()
        setErrors(prev => ({ ...prev, [gap.id]: d.error ?? 'Failed to record decision' }))
        return
      }
      setShowDecision(null)
      onUpdate()
    } finally {
      setSavingDecision(null)
    }
  }

  async function generateQuestion(gap: GapWithDetails) {
    setGeneratingQuestion(gap.id)
    setErrors(prev => ({ ...prev, [gap.id]: '' }))
    try {
      const res = await fetch(`/api/gaps/${gap.id}/question`, { method: 'POST' })
      if (!res.ok) {
        const d = await res.json()
        setErrors(prev => ({ ...prev, [gap.id]: d.error ?? 'Failed to generate question' }))
        return
      }
      onUpdate()
    } finally {
      setGeneratingQuestion(null)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-500">
          Showing {topGaps.length} of {allNonMerged.length} gap{allNonMerged.length !== 1 ? 's' : ''}
        </p>
        {allNonMerged.length > 10 && (
          <button
            onClick={() => setShowAll(v => !v)}
            className="text-sm text-blue-600 hover:underline"
          >
            {showAll ? 'Show top 10 only' : `Show all ${allNonMerged.length} gaps`}
          </button>
        )}
      </div>

      {displayedGaps.map(gap => (
        <div
          key={gap.id}
          className={`border rounded-lg overflow-hidden ${gap.resolved_at ? 'opacity-60' : ''}`}
        >
          {/* Gap header */}
          <div
            className="flex items-start justify-between gap-3 p-4 cursor-pointer hover:bg-gray-50"
            onClick={() => setExpandedGapId(expandedGapId === gap.id ? null : gap.id)}
          >
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap mb-1">
                <Badge variant={gap.severity} />
                <Badge variant={gap.category} />
                <Badge variant={gap.source} />
                {gap.merged_count > 0 && (
                  <span className="text-xs text-gray-400">+{gap.merged_count} similar</span>
                )}
                {gap.resolved_at && <Badge variant="answered" label="Resolved" />}
              </div>
              <p className="text-sm text-gray-800">{gap.description}</p>
              {gap.source === 'pattern' && (
                <p className="text-xs text-indigo-600 mt-1">Seen in previous requirements</p>
              )}
            </div>
            <span className="text-gray-400 text-sm shrink-0">{expandedGapId === gap.id ? '▲' : '▼'}</span>
          </div>

          {/* Expanded body */}
          {expandedGapId === gap.id && !gap.resolved_at && (
            <div className="border-t px-4 py-4 space-y-4 bg-gray-50">
              {/* Task status */}
              {gap.task && (
                <div className="flex items-center gap-2 text-sm">
                  <span className="text-gray-500">Task:</span>
                  <span className="font-medium">{gap.task.title}</span>
                  <Badge variant={gap.task.status} />
                </div>
              )}

              {/* Question */}
              {gap.question ? (
                <div className="space-y-3">
                  <div className="flex items-start gap-2">
                    <Badge variant={gap.question.target_role} />
                    <p className="text-sm font-medium">{gap.question.question_text}</p>
                  </div>

                  {gap.question.status === 'answered' ? (
                    <p className="text-sm text-green-700 bg-green-50 rounded p-2">
                      ✓ Answered: {gap.question.answer}
                    </p>
                  ) : (
                    <>
                      <textarea
                        value={answers[gap.id] ?? ''}
                        onChange={e => setAnswers(prev => ({ ...prev, [gap.id]: e.target.value }))}
                        placeholder="Type the stakeholder's answer here…"
                        rows={3}
                        className="w-full border rounded px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                      <div className="flex items-center gap-3">
                        <Button
                          variant="secondary"
                          loading={savingAnswer === gap.id}
                          disabled={!answers[gap.id]?.trim()}
                          onClick={() => saveAnswer(gap)}
                        >
                          Save Answer
                        </Button>
                        <button
                          onClick={() => setShowDecision(showDecision === gap.id ? null : gap.id)}
                          className="text-sm text-blue-600 hover:underline"
                        >
                          Record Decision instead
                        </button>
                      </div>
                    </>
                  )}
                </div>
              ) : (
                <div className="flex items-center gap-3">
                  <span className="text-sm text-gray-500">No question generated for this gap.</span>
                  <Button
                    variant="ghost"
                    loading={generatingQuestion === gap.id}
                    onClick={() => generateQuestion(gap)}
                  >
                    Generate question
                  </Button>
                </div>
              )}

              {/* Record Decision form */}
              {showDecision === gap.id && (
                <div className="border rounded-lg p-4 bg-white space-y-3">
                  <h4 className="text-sm font-semibold">Record Decision</h4>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Decision *</label>
                    <textarea
                      rows={2}
                      value={decisionForms[gap.id]?.decision ?? ''}
                      onChange={e => setDecisionForms(prev => ({
                        ...prev,
                        [gap.id]: { ...prev[gap.id], decision: e.target.value },
                      }))}
                      placeholder="What was decided?"
                      className="w-full border rounded px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Rationale *</label>
                    <textarea
                      rows={2}
                      value={decisionForms[gap.id]?.rationale ?? ''}
                      onChange={e => setDecisionForms(prev => ({
                        ...prev,
                        [gap.id]: { ...prev[gap.id], rationale: e.target.value },
                      }))}
                      placeholder="Why was this decided? What constraints or context informed it?"
                      className="w-full border rounded px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                  <div className="flex items-center gap-3">
                    <Button
                      loading={savingDecision === gap.id}
                      onClick={() => saveDecision(gap)}
                    >
                      Save Decision
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => setShowDecision(null)}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              )}

              {errors[gap.id] && (
                <p className="text-red-600 text-sm">{errors[gap.id]}</p>
              )}
            </div>
          )}
        </div>
      ))}

      {displayedGaps.length === 0 && (
        <p className="text-gray-400 text-center py-8">No gaps detected. Analysis not yet run or requirements are complete.</p>
      )}
    </div>
  )
}
