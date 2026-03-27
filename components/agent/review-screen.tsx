'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import type { Job, TestResult } from '@/lib/supabase/types'

interface Props {
  jobId: string
  projectId: string
  job: Job
  diff: string
  testResult: TestResult | null
}

function DiffViewer({ diff }: { diff: string }) {
  if (!diff) return <p style={{ color: 'var(--text-muted)', fontSize: '13px' }}>No diff available.</p>
  return (
    <pre style={{ fontFamily: 'var(--font-jetbrains)', fontSize: '12px', lineHeight: '1.6', overflowX: 'auto', margin: 0 }}>
      {diff.split('\n').map((line, i) => {
        const color = line.startsWith('+') ? '#22c55e' : line.startsWith('-') ? '#ef4444' : line.startsWith('@@') ? '#60a5fa' : 'var(--text-secondary)'
        return <span key={`line-${i}`} style={{ display: 'block', color }}>{line}</span>
      })}
    </pre>
  )
}

export function ReviewScreen({ jobId, projectId, job, diff, testResult }: Props) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const isDone = job.status === 'done'

  async function approve() {
    setLoading(true)
    setActionError(null)
    try {
      const res = await fetch(`/api/jobs/${jobId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'approve_review' }),
      })
      if (!res.ok) { setActionError('Failed to approve. Please try again.'); return }
      router.push(`/projects/${projectId}/requirements`)
    } catch {
      setActionError('Failed to approve. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  async function retry() {
    setLoading(true)
    setActionError(null)
    try {
      const res = await fetch(`/api/jobs/${jobId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'retry' }),
      })
      if (!res.ok) { setActionError('Failed to start retry. Please try again.'); return }
      router.push(`/projects/${projectId}/jobs/${jobId}/execution`)
    } catch {
      setActionError('Failed to start retry. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{ background: 'var(--bg-base)', minHeight: '100vh', padding: '2rem' }}>
      <div style={{ maxWidth: '900px', margin: '0 auto' }}>
        <div style={{ marginBottom: '2rem' }}>
          <p style={{ fontSize: '12px', color: 'var(--accent)', fontFamily: 'var(--font-jetbrains)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '0.5rem' }}>
            Code Review
          </p>
          <h1 style={{ fontSize: '1.75rem', fontFamily: 'var(--font-syne)', color: 'var(--text-primary)', marginBottom: '0.25rem' }}>
            Review Changes
          </h1>
          <p style={{ color: 'var(--text-muted)', fontSize: '13px' }}>Branch: <code style={{ fontFamily: 'var(--font-jetbrains)', color: 'var(--accent)' }}>{job.branch_name ?? 'not yet created'}</code></p>
          {isDone && <p style={{ color: '#22c55e', fontSize: '12px', marginTop: '0.25rem', fontFamily: 'var(--font-jetbrains)' }}>✓ Approved</p>}
        </div>

        {/* Test results */}
        <div style={{ marginBottom: '1.5rem' }}>
          {testResult ? (
            <div style={{ display: 'flex', gap: '1rem' }}>
              <div style={{ padding: '0.75rem 1.25rem', background: 'rgba(34,197,94,0.1)', border: '1px solid #22c55e', borderRadius: '8px', fontSize: '13px', color: '#22c55e', fontFamily: 'var(--font-jetbrains)' }}>
                ✓ {testResult.passed} passed
              </div>
              {testResult.failed > 0 && (
                <div style={{ padding: '0.75rem 1.25rem', background: 'rgba(239,68,68,0.1)', border: '1px solid #ef4444', borderRadius: '8px', fontSize: '13px', color: '#ef4444', fontFamily: 'var(--font-jetbrains)' }}>
                  ✗ {testResult.failed} failed
                </div>
              )}
            </div>
          ) : (
            <p style={{ color: 'var(--text-muted)', fontSize: '13px', fontFamily: 'var(--font-jetbrains)' }}>Test results unavailable.</p>
          )}
        </div>

        {/* Diff viewer */}
        <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: '12px', padding: '1.25rem', marginBottom: '2rem', maxHeight: '500px', overflowY: 'auto' }}>
          <DiffViewer diff={diff} />
        </div>

        {/* Actions */}
        {!isDone && (
          <div>
            <div style={{ display: 'flex', gap: '1rem' }}>
              <button
                onClick={approve}
                disabled={loading}
                style={{ padding: '0.75rem 2rem', background: 'var(--accent)', color: '#000', borderRadius: '8px', fontSize: '14px', fontWeight: 600, cursor: loading ? 'not-allowed' : 'pointer', border: 'none', fontFamily: 'var(--font-jetbrains)', opacity: loading ? 0.7 : 1 }}
              >
                {loading ? 'Working...' : 'Approve → Done'}
              </button>
              <button
                onClick={retry}
                disabled={loading}
                style={{ padding: '0.75rem 1.5rem', background: 'transparent', color: 'var(--text-secondary)', borderRadius: '8px', fontSize: '14px', cursor: loading ? 'not-allowed' : 'pointer', border: '1px solid var(--border-subtle)', opacity: loading ? 0.7 : 1 }}
              >
                Retry Coding
              </button>
            </div>
            {actionError && <p style={{ color: '#ef4444', fontSize: '12px', marginTop: '0.75rem', fontFamily: 'var(--font-jetbrains)' }}>{actionError}</p>}
          </div>
        )}
      </div>
    </div>
  )
}
