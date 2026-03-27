'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import type { AgentPlan, PlanTask } from '@/lib/supabase/types'

interface Props {
  jobId: string
  projectId: string
  plan: AgentPlan
}

export function PlanScreen({ jobId, projectId, plan }: Props) {
  const router = useRouter()
  const [approving, setApproving] = useState(false)
  const [approveError, setApproveError] = useState<string | null>(null)

  async function approvePlan() {
    setApproving(true)
    setApproveError(null)
    try {
      const res = await fetch(`/api/jobs/${jobId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'approve_plan' }),
      })
      if (!res.ok) {
        setApproveError('Failed to approve plan. Please try again.')
        return
      }
      router.push(`/projects/${projectId}/jobs/${jobId}/execution`)
    } catch {
      setApproveError('Failed to approve plan. Please try again.')
    } finally {
      setApproving(false)
    }
  }

  async function cancel() {
    try {
      await fetch(`/api/jobs/${jobId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'cancel' }),
      })
    } catch {
      // best-effort cancel — navigate away regardless
    }
    router.push(`/projects/${projectId}/requirements`)
  }

  return (
    <div style={{ background: 'var(--bg-base)', minHeight: '100vh', padding: '2rem' }}>
      <div style={{ maxWidth: '900px', margin: '0 auto' }}>
        <div style={{ marginBottom: '2rem' }}>
          <p style={{ fontSize: '12px', color: 'var(--accent)', fontFamily: 'var(--font-jetbrains)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '0.5rem' }}>
            Agent Plan
          </p>
          <h1 style={{ fontSize: '1.75rem', fontFamily: 'var(--font-syne)', color: 'var(--text-primary)', marginBottom: '0.5rem' }}>
            Review Implementation Plan
          </h1>
          <p style={{ color: 'var(--text-muted)', fontSize: '13px' }}>Branch: <code style={{ fontFamily: 'var(--font-jetbrains)', color: 'var(--accent)' }}>{plan.branch_name}</code></p>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5rem', marginBottom: '2rem' }}>
          {/* Files to create */}
          <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: '12px', padding: '1.25rem' }}>
            <h3 style={{ fontSize: '12px', color: '#22c55e', fontFamily: 'var(--font-jetbrains)', textTransform: 'uppercase', marginBottom: '0.75rem' }}>
              Create ({plan.files_to_create.length})
            </h3>
            {plan.files_to_create.map(f => (
              <div key={f} style={{ fontSize: '12px', color: 'var(--text-secondary)', fontFamily: 'var(--font-jetbrains)', marginBottom: '0.25rem' }}>+ {f}</div>
            ))}
          </div>

          {/* Files to modify */}
          <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: '12px', padding: '1.25rem' }}>
            <h3 style={{ fontSize: '12px', color: '#f59e0b', fontFamily: 'var(--font-jetbrains)', textTransform: 'uppercase', marginBottom: '0.75rem' }}>
              Modify ({plan.files_to_modify.length})
            </h3>
            {plan.files_to_modify.map(f => (
              <div key={f} style={{ fontSize: '12px', color: 'var(--text-secondary)', fontFamily: 'var(--font-jetbrains)', marginBottom: '0.25rem' }}>~ {f}</div>
            ))}
          </div>
        </div>

        {/* Test approach */}
        <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: '12px', padding: '1.25rem', marginBottom: '2rem' }}>
          <h3 style={{ fontSize: '12px', color: 'var(--text-muted)', fontFamily: 'var(--font-jetbrains)', textTransform: 'uppercase', marginBottom: '0.5rem' }}>Test Approach</h3>
          <p style={{ color: 'var(--text-secondary)', fontSize: '13px' }}>{plan.test_approach}</p>
        </div>

        {/* Tasks */}
        <div style={{ marginBottom: '2.5rem' }}>
          <h2 style={{ fontSize: '1rem', color: 'var(--text-primary)', fontFamily: 'var(--font-syne)', marginBottom: '1rem' }}>
            Tasks ({plan.tasks.length})
          </h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            {(plan.tasks as PlanTask[]).map((task, i) => (
              <div key={task.id} style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: '10px', padding: '1rem' }}>
                <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'flex-start' }}>
                  <span style={{ fontSize: '11px', color: 'var(--accent)', fontFamily: 'var(--font-jetbrains)', minWidth: '24px' }}>{i + 1}</span>
                  <div>
                    <p style={{ color: 'var(--text-primary)', fontWeight: 600, fontSize: '14px', marginBottom: '0.25rem' }}>{task.title}</p>
                    <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginBottom: '0.5rem' }}>{task.description}</p>
                    <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                      {task.files.map(f => (
                        <span key={f} style={{ fontSize: '11px', color: 'var(--text-muted)', fontFamily: 'var(--font-jetbrains)', background: 'var(--bg-elevated)', padding: '2px 6px', borderRadius: '4px' }}>{f}</span>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', gap: '1rem', flexDirection: 'column' }}>
          <div style={{ display: 'flex', gap: '1rem' }}>
            <button
              onClick={approvePlan}
              disabled={approving}
              style={{ padding: '0.75rem 2rem', background: 'var(--accent)', color: '#000', borderRadius: '8px', fontSize: '14px', fontWeight: 600, cursor: approving ? 'not-allowed' : 'pointer', border: 'none', fontFamily: 'var(--font-jetbrains)', opacity: approving ? 0.7 : 1 }}
            >
              {approving ? 'Approving...' : 'Approve Plan → Start Coding'}
            </button>
            <button
              onClick={cancel}
              style={{ padding: '0.75rem 1.5rem', background: 'transparent', color: 'var(--text-muted)', borderRadius: '8px', fontSize: '14px', cursor: 'pointer', border: '1px solid var(--border-subtle)' }}
            >
              Cancel
            </button>
          </div>
          {approveError && <p style={{ color: '#ef4444', fontSize: '12px', marginTop: '0.75rem', fontFamily: 'var(--font-jetbrains)' }}>{approveError}</p>}
        </div>
      </div>
    </div>
  )
}
