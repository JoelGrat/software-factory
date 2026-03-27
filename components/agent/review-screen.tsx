'use client'
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
        return <span key={i} style={{ display: 'block', color }}>{line}</span>
      })}
    </pre>
  )
}

export function ReviewScreen({ jobId, projectId, job, diff, testResult }: Props) {
  const router = useRouter()

  async function approve() {
    const res = await fetch(`/api/jobs/${jobId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'approve_review' }),
    })
    if (res.ok) router.push(`/projects/${projectId}/requirements`)
  }

  async function retry() {
    const res = await fetch(`/api/jobs/${jobId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'retry' }),
    })
    if (res.ok) router.push(`/projects/${projectId}/jobs/${jobId}/execution`)
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
          <p style={{ color: 'var(--text-muted)', fontSize: '13px' }}>Branch: <code style={{ fontFamily: 'var(--font-jetbrains)', color: 'var(--accent)' }}>{job.branch_name}</code></p>
        </div>

        {/* Test results */}
        {testResult && (
          <div style={{ display: 'flex', gap: '1rem', marginBottom: '1.5rem' }}>
            <div style={{ padding: '0.75rem 1.25rem', background: 'rgba(34,197,94,0.1)', border: '1px solid #22c55e', borderRadius: '8px', fontSize: '13px', color: '#22c55e', fontFamily: 'var(--font-jetbrains)' }}>
              ✓ {testResult.passed} passed
            </div>
            {testResult.failed > 0 && (
              <div style={{ padding: '0.75rem 1.25rem', background: 'rgba(239,68,68,0.1)', border: '1px solid #ef4444', borderRadius: '8px', fontSize: '13px', color: '#ef4444', fontFamily: 'var(--font-jetbrains)' }}>
                ✗ {testResult.failed} failed
              </div>
            )}
          </div>
        )}

        {/* Diff viewer */}
        <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: '12px', padding: '1.25rem', marginBottom: '2rem', maxHeight: '500px', overflowY: 'auto' }}>
          <DiffViewer diff={diff} />
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', gap: '1rem' }}>
          <button
            onClick={approve}
            style={{ padding: '0.75rem 2rem', background: 'var(--accent)', color: '#000', borderRadius: '8px', fontSize: '14px', fontWeight: 600, cursor: 'pointer', border: 'none', fontFamily: 'var(--font-jetbrains)' }}
          >
            Approve → Done
          </button>
          <button
            onClick={retry}
            style={{ padding: '0.75rem 1.5rem', background: 'transparent', color: 'var(--text-secondary)', borderRadius: '8px', fontSize: '14px', cursor: 'pointer', border: '1px solid var(--border-subtle)' }}
          >
            Retry Coding
          </button>
        </div>
      </div>
    </div>
  )
}
