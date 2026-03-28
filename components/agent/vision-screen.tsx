'use client'
import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { JobShell } from '@/components/agent/job-shell'
import { StepIndicator } from '@/components/agent/step-indicator'
import type { ProjectVision, VisionLog, VisionStatus, RequirementItem } from '@/lib/supabase/types'

// ─── Log feed ────────────────────────────────────────────────────────────────

const LOG_COLORS: Record<string, string> = {
  info: '#c7c4d7', warn: '#f59e0b', error: '#ffb4ab', success: '#22c55e',
}
const LOG_ICONS: Record<string, string> = {
  info: 'info', warn: 'warning', error: 'error', success: 'check_circle',
}

function LogFeed({ logs }: { logs: VisionLog[] }) {
  const endRef = useRef<HTMLDivElement>(null)
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [logs])
  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-1 font-mono text-[11px]">
      {logs.length === 0 && (
        <div className="flex items-center gap-2 text-slate-500">
          <span className="material-symbols-outlined animate-pulse" style={{ fontSize: '14px' }}>hourglass_empty</span>
          <span>Waiting...</span>
        </div>
      )}
      {logs.map(log => (
        <div key={log.id} className="flex items-start gap-2 py-0.5">
          <span className="material-symbols-outlined mt-0.5 flex-shrink-0"
            style={{ fontSize: '12px', color: LOG_COLORS[log.level] ?? '#c7c4d7' }}>
            {LOG_ICONS[log.level] ?? 'circle'}
          </span>
          <div className="flex-1 min-w-0">
            <span className="text-slate-600 mr-2">{new Date(log.created_at).toLocaleTimeString()}</span>
            <span style={{ color: LOG_COLORS[log.level] ?? '#c7c4d7' }}>{log.message}</span>
          </div>
        </div>
      ))}
      <div ref={endRef} />
    </div>
  )
}

// ─── Structured fields ────────────────────────────────────────────────────────

interface StructuredFields {
  goal: string; tech_stack: string; target_users: string
  key_features: string; constraints: string
}

const STRUCTURED_FIELD_DEFS: { key: keyof StructuredFields; label: string; placeholder: string; multiline?: boolean }[] = [
  { key: 'goal',         label: 'Goal',         placeholder: 'What problem does this project solve?' },
  { key: 'tech_stack',   label: 'Tech Stack',   placeholder: 'e.g. Next.js, Supabase, TypeScript' },
  { key: 'target_users', label: 'Target Users', placeholder: 'Who will use this?' },
  { key: 'key_features', label: 'Key Features', placeholder: 'List the main features, one per line', multiline: true },
  { key: 'constraints',  label: 'Constraints',  placeholder: 'Technical constraints, deadlines, non-goals (optional)', multiline: true },
]

// ─── Main component ───────────────────────────────────────────────────────────

interface Props {
  projectId:     string
  projectName:   string
  requirementId: string
  initialVision: ProjectVision
  initialLogs:   VisionLog[]
  initialItems:  RequirementItem[]
}

const PHASE_LABELS: Record<string, string> = {
  parsing:    'Parsing your vision...',
  generating: 'Generating requirements...',
  system:     'Finalising...',
}

export function VisionScreen({
  projectId, projectName, requirementId,
  initialVision, initialLogs, initialItems,
}: Props) {
  const router = useRouter()
  const db = createClient()

  const [vision,      setVision]      = useState<ProjectVision>(initialVision)
  const [logs,        setLogs]        = useState<VisionLog[]>(initialLogs)
  const [items,       setItems]       = useState<RequirementItem[]>(initialItems)
  const [freeForm,    setFreeForm]    = useState(initialVision.free_form_text)
  const [structured,  setStructured]  = useState<StructuredFields>({
    goal:         initialVision.goal,
    tech_stack:   initialVision.tech_stack,
    target_users: initialVision.target_users,
    key_features: initialVision.key_features,
    constraints:  initialVision.constraints,
  })
  const [mode, setMode]             = useState<'free_form' | 'structured'>(initialVision.mode)
  const [generating, setGenerating] = useState(false)
  const [genError, setGenError]     = useState<string | null>(null)
  const dbRef = useRef(db)

  const status: VisionStatus = vision.status
  const isGenerating = status === 'generating'
  const isFailed     = status === 'failed'
  const latestPhase  = logs.length > 0 ? logs[logs.length - 1].phase : 'system'

  // ── Realtime subscriptions ──────────────────────────────────────────────────
  useEffect(() => {
    const visionChannel = dbRef.current
      .channel(`vision-${projectId}`)
      .on('postgres_changes', {
        event: 'UPDATE', schema: 'public', table: 'project_visions',
        filter: `project_id=eq.${projectId}`,
      }, payload => {
        const updated = payload.new as ProjectVision
        setVision(updated)
        if (updated.status === 'done') {
          router.push(`/projects/${projectId}/requirements`)
        }
      })
      .subscribe()

    const logsChannel = dbRef.current
      .channel(`vision-logs-${projectId}`)
      .on('postgres_changes', {
        event: 'INSERT', schema: 'public', table: 'vision_logs',
        filter: `project_id=eq.${projectId}`,
      }, payload => {
        setLogs(prev => [...prev, payload.new as VisionLog])
      })
      .subscribe()

    const itemsChannel = dbRef.current
      .channel(`vision-items-${projectId}`)
      .on('postgres_changes', {
        event: 'INSERT', schema: 'public', table: 'requirement_items',
        filter: `requirement_id=eq.${requirementId}`,
      }, payload => {
        setItems(prev => [...prev, payload.new as RequirementItem])
      })
      .subscribe()

    return () => {
      dbRef.current.removeChannel(visionChannel)
      dbRef.current.removeChannel(logsChannel)
      dbRef.current.removeChannel(itemsChannel)
    }
  }, [projectId, requirementId, router])

  // ── Auto-save on blur ───────────────────────────────────────────────────────
  async function saveDraft() {
    if (status !== 'draft' && status !== 'failed') return
    await fetch(`/api/projects/${projectId}/vision`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode, free_form_text: freeForm, ...structured }),
    })
  }

  async function switchMode(next: 'free_form' | 'structured') {
    setMode(next)
    await fetch(`/api/projects/${projectId}/vision`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: next }),
    })
  }

  async function handleGenerate() {
    setGenerating(true)
    setGenError(null)
    await saveDraft()
    const res = await fetch(`/api/projects/${projectId}/vision/generate`, { method: 'POST' })
    if (!res.ok) {
      const data = await res.json()
      setGenError(data.error ?? 'Failed to start generation')
      setGenerating(false)
      return
    }
    // Navigate immediately — requirements page shows live progress
    router.push(`/projects/${projectId}/requirements`)
  }

  const hasContent = mode === 'free_form'
    ? freeForm.trim().length > 0
    : structured.goal.trim().length > 0 || structured.key_features.trim().length > 0

  // ── Sidebar ─────────────────────────────────────────────────────────────────
  const sidebar = (
    <div className="flex flex-col h-full">
      {(isGenerating || isFailed) ? (
        <LogFeed logs={logs} />
      ) : (
        <div className="p-5 space-y-3">
          <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500 font-headline">Tips</p>
          {[
            'Be specific about your tech stack',
            'Describe key user flows',
            'Mention constraints or non-goals',
            'List your primary user types',
          ].map(tip => (
            <div key={tip} className="flex items-start gap-2">
              <span className="material-symbols-outlined text-indigo-400 flex-shrink-0 mt-0.5" style={{ fontSize: '14px' }}>
                lightbulb
              </span>
              <p className="text-xs text-slate-400">{tip}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  )

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <JobShell
      projectName={projectName}
      projectId={projectId}
      sidebar={sidebar}
      sidebarTitle={isGenerating || isFailed ? `Agent Activity Log (${logs.length})` : 'Tips'}
    >
      <div className="max-w-4xl mx-auto space-y-8">
        <StepIndicator current={1} />

        {/* ── Generating state ─────────────────────────────────────────────── */}
        {(isGenerating || (status === 'done' && items.length > 0)) && (
          <>
            <div>
              <div className="flex items-center gap-3 mb-2">
                <span className="relative flex h-3 w-3">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-3 w-3 bg-indigo-400" />
                </span>
                <h1 className="text-3xl font-extrabold font-headline tracking-tight text-white">
                  Generating Requirements
                </h1>
              </div>
              <p className="text-slate-400 text-sm">{PHASE_LABELS[latestPhase] ?? 'Processing...'}</p>
            </div>

            <div className="space-y-3">
              {items.map((item) => (
                <div key={item.id}
                  className="bg-surface-container rounded-xl p-4 border border-white/5 flex items-start gap-3">
                  <span className="material-symbols-outlined text-[#22c55e] flex-shrink-0 mt-0.5" style={{ fontSize: '16px' }}>
                    check_circle
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-[10px] font-bold uppercase tracking-widest text-indigo-400 font-headline">
                        {item.type}
                      </span>
                      <span className={`text-[10px] font-bold uppercase ${
                        item.priority === 'high' ? 'text-error' :
                        item.priority === 'medium' ? 'text-tertiary' : 'text-slate-500'
                      }`}>{item.priority}</span>
                    </div>
                    <p className="text-sm font-semibold text-on-surface">{item.title}</p>
                    <p className="text-xs text-slate-400 mt-0.5">{item.description}</p>
                  </div>
                </div>
              ))}
              {isGenerating && (
                <div className="bg-surface-container rounded-xl p-4 border border-indigo-500/30 flex items-center gap-3">
                  <span className="relative flex h-3 w-3 flex-shrink-0">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-75" />
                    <span className="relative inline-flex rounded-full h-3 w-3 bg-indigo-400" />
                  </span>
                  <span className="text-sm text-indigo-300">Generating next requirement...</span>
                </div>
              )}
            </div>
          </>
        )}

        {/* ── Failed state ──────────────────────────────────────────────────── */}
        {isFailed && (
          <>
            <div>
              <h1 className="text-3xl font-extrabold font-headline tracking-tight text-white mb-2">
                Generation Failed
              </h1>
              <p className="text-slate-400 text-sm">Review the error below and try again.</p>
            </div>
            <div className="bg-error-container/10 rounded-xl p-6 border border-error/30">
              <div className="flex items-start gap-3">
                <span className="material-symbols-outlined text-error flex-shrink-0" style={{ fontSize: '24px' }}>error</span>
                <div>
                  <h3 className="font-headline font-bold text-error mb-1">Error</h3>
                  <p className="text-sm text-on-surface-variant font-mono leading-relaxed">
                    {vision.error ?? 'Unknown error'}
                  </p>
                </div>
              </div>
              <button
                onClick={handleGenerate}
                disabled={generating}
                className="mt-4 bg-gradient-to-br from-primary to-primary-container text-on-primary-container px-6 py-2.5 rounded-lg font-headline font-extrabold text-sm flex items-center gap-2 disabled:opacity-60"
              >
                {generating ? 'Retrying...' : 'Retry'}
                {!generating && <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>refresh</span>}
              </button>
            </div>
          </>
        )}

        {/* ── Draft state ───────────────────────────────────────────────────── */}
        {status === 'draft' && (
          <>
            <div className="flex items-start justify-between">
              <div>
                <h1 className="text-3xl font-extrabold font-headline tracking-tight text-white mb-2">
                  Describe Your Project
                </h1>
                <p className="text-slate-400 text-sm">
                  Tell us what you&apos;re building — the AI will generate structured requirements from your description.
                </p>
              </div>
              <div className="flex items-center gap-3 flex-shrink-0 ml-6">
                {genError && <span className="text-xs text-error font-mono">{genError}</span>}
                <button
                  onClick={handleGenerate}
                  disabled={!hasContent || generating}
                  className="bg-gradient-to-br from-primary to-primary-container text-on-primary-container px-6 py-2.5 rounded-lg font-headline font-extrabold text-sm flex items-center gap-2 shadow-[0_4px_20px_rgba(189,194,255,0.2)] hover:scale-[1.02] transition-transform active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed disabled:scale-100"
                >
                  {generating ? 'Starting...' : 'Generate Requirements'}
                  {!generating && <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>arrow_forward</span>}
                </button>
              </div>
            </div>

            {/* Mode toggle */}
            <div className="flex items-center gap-1 p-1 bg-surface-container-low rounded-xl w-fit">
              {(['free_form', 'structured'] as const).map(m => (
                <button
                  key={m}
                  onClick={() => switchMode(m)}
                  className={[
                    'px-4 py-1.5 rounded-lg text-xs font-bold font-headline uppercase tracking-wider transition-all',
                    mode === m
                      ? 'bg-indigo-500/20 text-indigo-300 ring-1 ring-indigo-500/40'
                      : 'text-slate-400 hover:text-slate-200',
                  ].join(' ')}
                >
                  {m === 'free_form' ? 'Free-form' : 'Structured'}
                </button>
              ))}
            </div>

            {/* Free-form */}
            {mode === 'free_form' && (
              <textarea
                value={freeForm}
                onChange={e => setFreeForm(e.target.value)}
                onBlur={e => { e.currentTarget.style.borderColor = 'var(--border-default)'; saveDraft() }}
                onFocus={e => { e.currentTarget.style.borderColor = 'var(--border-accent)' }}
                placeholder="Describe what you're building — goals, key features, tech stack, target users, constraints..."
                rows={14}
                className="w-full rounded-xl px-5 py-4 resize-none outline-none transition-all"
                style={{
                  background: 'var(--bg-surface)',
                  border: '1px solid var(--border-default)',
                  color: 'var(--text-primary)',
                  fontFamily: 'var(--font-jetbrains)',
                  fontSize: '13px',
                  lineHeight: '1.7',
                }}
              />
            )}

            {/* Structured fields */}
            {mode === 'structured' && (
              <div className="space-y-4">
                {STRUCTURED_FIELD_DEFS.map(field => (
                  <div key={field.key}>
                    <label className="block text-[10px] font-bold uppercase tracking-widest text-slate-400 font-headline mb-1.5">
                      {field.label}
                    </label>
                    {field.multiline ? (
                      <textarea
                        value={structured[field.key]}
                        onChange={e => setStructured(prev => ({ ...prev, [field.key]: e.target.value }))}
                        onBlur={e => { e.currentTarget.style.borderColor = 'var(--border-default)'; saveDraft() }}
                        onFocus={e => { e.currentTarget.style.borderColor = 'var(--border-accent)' }}
                        placeholder={field.placeholder}
                        rows={4}
                        className="w-full rounded-xl px-5 py-4 resize-none outline-none transition-all"
                        style={{
                          background: 'var(--bg-surface)',
                          border: '1px solid var(--border-default)',
                          color: 'var(--text-primary)',
                          fontFamily: 'var(--font-jetbrains)',
                          fontSize: '13px',
                          lineHeight: '1.7',
                        }}
                      />
                    ) : (
                      <input
                        type="text"
                        value={structured[field.key]}
                        onChange={e => setStructured(prev => ({ ...prev, [field.key]: e.target.value }))}
                        onBlur={e => { e.currentTarget.style.borderColor = 'var(--border-default)'; saveDraft() }}
                        onFocus={e => { e.currentTarget.style.borderColor = 'var(--border-accent)' }}
                        placeholder={field.placeholder}
                        className="w-full rounded-xl px-5 py-3 outline-none transition-all"
                        style={{
                          background: 'var(--bg-surface)',
                          border: '1px solid var(--border-default)',
                          color: 'var(--text-primary)',
                          fontFamily: 'var(--font-jetbrains)',
                          fontSize: '13px',
                        }}
                      />
                    )}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </JobShell>
  )
}
