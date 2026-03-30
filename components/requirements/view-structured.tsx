'use client'
import { useState, useMemo } from 'react'
// TODO: replaced in Plan 2/3/4 — old types removed in migration 006
/* eslint-disable @typescript-eslint/no-explicit-any */
// import type { RequirementItem, RequirementStatus } from '@/lib/supabase/types' // removed in migration 006

const TYPE_ORDER: string[] = ['functional', 'non-functional', 'constraint', 'assumption']

const TYPE_CONFIG: Record<string, { label: string; icon: string; color: string }> = {
  functional:       { label: 'Functional',     icon: 'check_box',    color: '#818cf8' },
  'non-functional': { label: 'Non-Functional', icon: 'speed',        color: '#34d399' },
  constraint:       { label: 'Constraints',    icon: 'block',        color: '#f59e0b' },
  assumption:       { label: 'Assumptions',    icon: 'help_outline', color: '#94a3b8' },
}

const PRIORITY_STYLES: Record<string, string> = {
  high:   'text-error',
  medium: 'text-amber-400',
  low:    'text-slate-500',
}

// ── Inline add form ───────────────────────────────────────────────────────────

interface AddFormProps {
  type: any
  requirementId: string
  onAdd: (item: any) => void
  onCancel: () => void
}

function AddForm({ type, requirementId, onAdd, onCancel }: AddFormProps) {
  const [title, setTitle]       = useState('')
  const [description, setDesc]  = useState('')
  const [priority, setPriority] = useState<'high' | 'medium' | 'low'>('medium')
  const [saving, setSaving]     = useState(false)
  const [aiLoading, setAiLoading] = useState(false)
  const [error, setError]       = useState<string | null>(null)

  async function handleAiAssist() {
    if (!title.trim()) return
    setAiLoading(true)
    setError(null)
    const res = await fetch(`/api/requirements/${requirementId}/ai-assist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, title, description }),
    })
    setAiLoading(false)
    if (!res.ok) {
      const d = await res.json()
      setError(d.error ?? 'AI assist failed')
      return
    }
    const { description: suggested } = await res.json()
    setDesc(suggested)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!title.trim() || !description.trim()) return
    setSaving(true)
    setError(null)
    const res = await fetch(`/api/requirements/${requirementId}/items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, title, description, priority }),
    })
    setSaving(false)
    if (!res.ok) {
      const d = await res.json()
      setError(d.error ?? 'Failed to add')
      return
    }
    const item: any = await res.json()
    onAdd(item)
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="mt-2 rounded-xl border border-indigo-500/20 bg-indigo-500/5 p-4 space-y-3"
    >
      <input
        autoFocus
        type="text"
        value={title}
        onChange={e => setTitle(e.target.value)}
        placeholder="Short title (max 10 words)"
        className="w-full rounded-lg px-4 py-2.5 text-sm outline-none transition-all"
        style={{
          background: 'var(--bg-surface)',
          border: '1px solid var(--border-default)',
          color: 'var(--text-primary)',
          fontFamily: 'var(--font-jetbrains)',
          fontSize: '13px',
        }}
        onFocus={e => { e.currentTarget.style.borderColor = 'var(--border-accent)' }}
        onBlur={e => { e.currentTarget.style.borderColor = 'var(--border-default)' }}
      />
      <div className="relative">
        <textarea
          value={description}
          onChange={e => setDesc(e.target.value)}
          placeholder="1–2 sentence description..."
          rows={3}
          className="w-full rounded-lg px-4 py-2.5 resize-none text-sm outline-none transition-all"
          style={{
            background: 'var(--bg-surface)',
            border: '1px solid var(--border-default)',
            color: 'var(--text-primary)',
            fontFamily: 'var(--font-jetbrains)',
            fontSize: '13px',
            lineHeight: '1.6',
          }}
          onFocus={e => { e.currentTarget.style.borderColor = 'var(--border-accent)' }}
          onBlur={e => { e.currentTarget.style.borderColor = 'var(--border-default)' }}
        />
        <button
          type="button"
          disabled={!title.trim() || aiLoading}
          onClick={handleAiAssist}
          title={description.trim() ? 'Improve with AI' : 'Generate description with AI'}
          className="absolute bottom-2 right-2 flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-headline font-bold transition-all disabled:opacity-30"
          style={{
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border-default)',
            color: '#818cf8',
          }}
        >
          {aiLoading
            ? <span className="material-symbols-outlined animate-spin" style={{ fontSize: '13px' }}>progress_activity</span>
            : <span className="material-symbols-outlined" style={{ fontSize: '13px' }}>auto_awesome</span>
          }
          {aiLoading ? 'Thinking...' : description.trim() ? 'Improve' : 'Generate'}
        </button>
      </div>
      <div className="flex items-center gap-3">
        {/* Priority toggle */}
        <div className="flex gap-1 p-0.5 rounded-lg bg-surface-container-low">
          {(['high', 'medium', 'low'] as const).map(p => (
            <button
              key={p}
              type="button"
              onClick={() => setPriority(p)}
              className={[
                'px-3 py-1 rounded-md text-[11px] font-bold uppercase font-headline transition-all',
                priority === p
                  ? p === 'high' ? 'bg-error/15 text-error'
                  : p === 'medium' ? 'bg-amber-400/15 text-amber-400'
                  : 'bg-slate-500/15 text-slate-400'
                  : 'text-slate-600 hover:text-slate-400',
              ].join(' ')}
            >
              {p}
            </button>
          ))}
        </div>

        <div className="flex gap-2 ml-auto">
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-1.5 rounded-lg text-xs text-slate-400 hover:text-slate-200 hover:bg-surface-container transition-all"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!title.trim() || !description.trim() || saving}
            className="px-4 py-1.5 rounded-lg text-xs font-headline font-bold bg-gradient-to-br from-primary to-primary-container text-on-primary-container disabled:opacity-40 transition-all"
          >
            {saving ? 'Adding...' : 'Add'}
          </button>
        </div>
      </div>
      {error && <p className="text-error text-xs font-mono">{error}</p>}
    </form>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

interface Props {
  requirementId: string
  items: any[]
  gaps: Array<{ id: string; item_id: string | null; severity: string; resolved_at: string | null; merged_into: string | null }>
  status: any
  isGenerating?: boolean
  blockedGapDescriptions: string[]
  onMarkReady: () => Promise<void>
  onAdd: (item: any) => void
  onViewGap?: () => void
}

export function ViewStructured({
  requirementId, items, gaps, status, isGenerating,
  blockedGapDescriptions, onMarkReady, onAdd, onViewGap,
}: Props) {
  const [marking, setMarking]   = useState(false)
  const [markError, setMarkError] = useState<string | null>(null)
  const [addingType, setAddingType] = useState<any>(null)

  const activeGapsByItemId = useMemo(() => {
    const map = new Map<string, typeof gaps[number][]>()
    for (const gap of gaps) {
      if (!gap.resolved_at && !gap.merged_into && gap.item_id) {
        const list = map.get(gap.item_id) ?? []
        list.push(gap)
        map.set(gap.item_id, list)
      }
    }
    return map
  }, [gaps])

  const grouped = useMemo(() =>
    TYPE_ORDER.map(type => ({
      type,
      items: items.filter(i => i.type === type),
    })),
  [items])

  const canMarkReady = (status === 'draft' || status === 'review_required') && items.length > 0
  const isReady = status === 'ready_for_dev'

  async function handleMarkReady() {
    setMarking(true)
    setMarkError(null)
    try {
      await onMarkReady()
    } catch (err) {
      setMarkError(String(err))
    } finally {
      setMarking(false)
    }
  }

  if (items.length === 0 && !isGenerating) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <span className="material-symbols-outlined text-slate-600 mb-4" style={{ fontSize: '40px' }}>edit_note</span>
        <p className="text-slate-400 text-sm">No requirements yet.</p>
        <p className="text-slate-600 text-xs mt-1">Generate them from the Vision step or add manually below.</p>
        <div className="mt-6 flex flex-wrap gap-2 justify-center">
          {TYPE_ORDER.map(type => {
            const cfg = TYPE_CONFIG[type]
            return (
              <button
                key={type}
                onClick={() => setAddingType(type)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-headline font-bold border border-white/10 hover:border-white/20 bg-surface-container transition-all"
                style={{ color: cfg.color }}
              >
                <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>{cfg.icon}</span>
                Add {cfg.label}
              </button>
            )
          })}
        </div>
        {addingType && (
          <div className="mt-4 w-full max-w-lg text-left">
            <AddForm
              type={addingType}
              requirementId={requirementId}
              onAdd={item => { onAdd(item); setAddingType(null) }}
              onCancel={() => setAddingType(null)}
            />
          </div>
        )}
      </div>
    )
  }

  if (items.length === 0 && isGenerating) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <span className="relative flex h-4 w-4 mb-4">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-75" />
          <span className="relative inline-flex rounded-full h-4 w-4 bg-indigo-400" />
        </span>
        <p className="text-slate-400 text-sm">Waiting for first requirement...</p>
      </div>
    )
  }

  return (
    <div className="space-y-8">
      {/* Header row */}
      <div className="flex items-start justify-between">
        <p className="text-sm text-slate-500 font-mono">{items.length} item{items.length !== 1 ? 's' : ''}</p>
        <div className="text-right">
          {!canMarkReady && blockedGapDescriptions.length > 0 && (
            <p className="mb-2 text-xs text-error max-w-xs">
              Blocked by {blockedGapDescriptions.length} critical gap{blockedGapDescriptions.length > 1 ? 's' : ''}.{' '}
              {onViewGap && <button onClick={onViewGap} className="underline opacity-70 hover:opacity-100">View gaps</button>}
            </p>
          )}
          <button
            disabled={!canMarkReady || marking}
            onClick={handleMarkReady}
            className={[
              'px-5 py-2 rounded-lg text-sm font-headline font-bold flex items-center gap-2 transition-all',
              isReady
                ? 'bg-[#22c55e]/10 text-[#22c55e] border border-[#22c55e]/30'
                : canMarkReady
                  ? 'bg-gradient-to-br from-primary to-primary-container text-on-primary-container shadow-[0_4px_20px_rgba(189,194,255,0.15)] hover:scale-[1.02] active:scale-95'
                  : 'bg-surface-container text-slate-500 border border-white/5 cursor-not-allowed',
            ].join(' ')}
          >
            {marking ? (
              <>
                <span className="material-symbols-outlined animate-spin" style={{ fontSize: '16px' }}>progress_activity</span>
                Saving...
              </>
            ) : isReady ? (
              <>
                <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>check_circle</span>
                Ready for Planning
              </>
            ) : (
              'Mark Ready for Planning'
            )}
          </button>
          {markError && <p className="text-error text-xs mt-1 font-mono">{markError}</p>}
        </div>
      </div>

      {/* Grouped sections */}
      {grouped.map(({ type, items: typeItems }) => {
        const cfg = TYPE_CONFIG[type]
        const isAddingHere = addingType === type
        return (
          <section key={type}>
            {/* Section header */}
            <div className="flex items-center gap-2 mb-3">
              <span className="material-symbols-outlined" style={{ fontSize: '16px', color: cfg.color }}>{cfg.icon}</span>
              <h3 className="text-[10px] font-bold uppercase tracking-widest font-headline" style={{ color: cfg.color }}>
                {cfg.label}
              </h3>
              <span className="text-[10px] font-mono text-slate-600">({typeItems.length})</span>
              <button
                onClick={() => setAddingType(isAddingHere ? null : type)}
                className="ml-1 flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-headline font-bold uppercase tracking-wider transition-all border"
                style={{
                  color: isAddingHere ? cfg.color : '#64748b',
                  borderColor: isAddingHere ? cfg.color + '40' : 'rgba(255,255,255,0.08)',
                  background: isAddingHere ? cfg.color + '10' : 'transparent',
                }}
              >
                <span className="material-symbols-outlined" style={{ fontSize: '12px' }}>
                  {isAddingHere ? 'close' : 'add'}
                </span>
                {isAddingHere ? 'Cancel' : 'Add'}
              </button>
            </div>

            <ul className="space-y-2">
              {typeItems.map(item => {
                const itemGaps = activeGapsByItemId.get(item.id) ?? []
                const hasCritical = itemGaps.some(g => g.severity === 'critical')
                return (
                  <li
                    key={item.id}
                    className={[
                      'rounded-xl p-4 border transition-all',
                      hasCritical ? 'bg-error/5 border-error/20' : 'bg-surface-container border-white/5',
                    ].join(' ')}
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1 flex-wrap">
                          <span className="font-semibold text-sm text-on-surface">{item.title}</span>
                          <span className={`text-[10px] font-bold uppercase font-headline ${PRIORITY_STYLES[item.priority] ?? 'text-slate-500'}`}>
                            {item.priority}
                          </span>
                          {item.nfr_category && (
                            <span className="text-[10px] font-mono text-slate-500 bg-surface-container-high rounded px-1.5 py-0.5">
                              {item.nfr_category}
                            </span>
                          )}
                        </div>
                        <p className="text-sm text-slate-400 leading-relaxed">{item.description}</p>
                      </div>
                      {itemGaps.length > 0 && (
                        <div className="flex flex-col gap-1 flex-shrink-0 items-end">
                          {itemGaps.map(gap => (
                            <span
                              key={gap.id}
                              className={[
                                'text-[10px] font-bold uppercase font-headline px-2 py-0.5 rounded',
                                gap.severity === 'critical' ? 'bg-error/10 text-error' :
                                gap.severity === 'major'    ? 'bg-amber-400/10 text-amber-400' :
                                                              'bg-slate-500/10 text-slate-400',
                              ].join(' ')}
                            >
                              {gap.severity}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </li>
                )
              })}
            </ul>

            {/* Inline add form */}
            {isAddingHere && (
              <AddForm
                type={type}
                requirementId={requirementId}
                onAdd={item => { onAdd(item); setAddingType(null) }}
                onCancel={() => setAddingType(null)}
              />
            )}
          </section>
        )
      })}
    </div>
  )
}
