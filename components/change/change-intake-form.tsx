'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'

const CHANGE_TYPES = ['bug', 'feature', 'refactor', 'hotfix'] as const
const PRIORITIES = ['low', 'medium', 'high'] as const

interface Props {
  projectId: string
  initialTitle?: string
}

export function ChangeIntakeForm({ projectId, initialTitle = '' }: Props) {
  const router = useRouter()
  const [title, setTitle] = useState(initialTitle)
  const [intent, setIntent] = useState('')
  const [type, setType] = useState<string>('feature')
  const [priority, setPriority] = useState<string>('medium')
  const [tagInput, setTagInput] = useState('')
  const [tags, setTags] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [generatingIntent, setGeneratingIntent] = useState(false)

  function addTag() {
    const tag = tagInput.trim().toLowerCase()
    if (tag && !tags.includes(tag)) setTags(prev => [...prev, tag])
    setTagInput('')
  }

  async function generateIntent() {
    if (!title.trim() || generatingIntent) return
    setGeneratingIntent(true)
    try {
      const res = await fetch('/api/ai/generate-intent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, intent, type }),
      })
      if (res.ok) {
        const data = await res.json()
        setIntent(data.intent)
      }
    } finally {
      setGeneratingIntent(false)
    }
  }

  function removeTag(tag: string) {
    setTags(prev => prev.filter(t => t !== tag))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/change-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: projectId, title, intent, type, priority, tags }),
      })
      if (!res.ok) {
        const data = await res.json()
        setError(data.error ?? 'Failed to create change request')
        return
      }
      const change = await res.json()
      router.push(`/projects/${projectId}`)
    } finally {
      setLoading(false)
    }
  }

  const inputClass = "w-full rounded-lg px-3 py-2 text-sm outline-none transition-all bg-[#131b2e] border border-white/10 text-slate-200 placeholder:text-slate-600 focus:border-indigo-500"
  const labelClass = "block text-xs font-bold uppercase tracking-widest text-slate-400 font-headline mb-1.5"

  return (
    <form onSubmit={handleSubmit} className="space-y-6 max-w-xl">
      <div>
        <label className={labelClass}>Title</label>
        <input
          value={title}
          onChange={e => setTitle(e.target.value)}
          placeholder="Short description of the change"
          required
          className={inputClass}
        />
      </div>

      <div>
        <div className="flex items-center justify-between mb-1.5">
          <label className={labelClass + ' mb-0'}>Intent</label>
          <button
            type="button"
            onClick={generateIntent}
            disabled={!title.trim() || generatingIntent}
            className="flex items-center gap-1 text-xs font-semibold text-indigo-400 hover:text-indigo-300 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {generatingIntent ? (
              <>
                <span className="material-symbols-outlined animate-spin" style={{ fontSize: '14px' }}>progress_activity</span>
                {intent.trim() ? 'Improving…' : 'Generating…'}
              </>
            ) : (
              <>
                <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>auto_awesome</span>
                {intent.trim() ? 'Improve' : 'Generate'}
              </>
            )}
          </button>
        </div>
        <textarea
          value={intent}
          onChange={e => setIntent(e.target.value)}
          placeholder="Describe what needs to change and why. Be specific — this drives the impact analysis."
          required
          rows={5}
          className={`${inputClass} resize-none`}
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className={labelClass}>Type</label>
          <select
            value={type}
            onChange={e => setType(e.target.value)}
            className={inputClass}
          >
            {CHANGE_TYPES.map(t => (
              <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelClass}>Priority</label>
          <select
            value={priority}
            onChange={e => setPriority(e.target.value)}
            className={inputClass}
          >
            {PRIORITIES.map(p => (
              <option key={p} value={p}>{p.charAt(0).toUpperCase() + p.slice(1)}</option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <label className={labelClass}>Tags (optional)</label>
        <div className="flex gap-2">
          <input
            value={tagInput}
            onChange={e => setTagInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addTag() } }}
            placeholder="Add tag and press Enter"
            className={`${inputClass} flex-1`}
          />
          <button
            type="button"
            onClick={addTag}
            className="px-3 py-2 rounded-lg text-xs font-semibold text-slate-400 hover:text-slate-200 border border-white/10 hover:border-white/20 transition-all"
          >
            Add
          </button>
        </div>
        {tags.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-2">
            {tags.map(tag => (
              <span key={tag} className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-indigo-400/10 text-indigo-300 font-mono">
                {tag}
                <button type="button" onClick={() => removeTag(tag)} className="hover:text-white transition-colors">×</button>
              </span>
            ))}
          </div>
        )}
      </div>

      {error && <p className="text-xs text-red-400">{error}</p>}

      <div className="flex items-center gap-3 pt-2">
        <Button type="submit" loading={loading}>Submit Change</Button>
        <button
          type="button"
          onClick={() => router.back()}
          className="text-sm text-slate-400 hover:text-slate-200 transition-colors"
        >
          Cancel
        </button>
      </div>
    </form>
  )
}
