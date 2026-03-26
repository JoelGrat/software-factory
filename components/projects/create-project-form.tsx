'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'

export function CreateProjectForm() {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const router = useRouter()

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      if (!res.ok) {
        const data = await res.json()
        setError(data.error ?? 'Failed to create project')
        return
      }
      const project = await res.json()
      router.push(`/projects/${project.id}/requirements`)
    } finally {
      setLoading(false)
    }
  }

  if (!open) {
    return <Button onClick={() => setOpen(true)}>+ New Project</Button>
  }

  return (
    <form onSubmit={handleSubmit} className="flex items-center gap-2">
      <input
        autoFocus
        value={name}
        onChange={e => setName(e.target.value)}
        placeholder="Project name"
        required
        className="rounded-lg px-3 py-2 text-sm outline-none w-56 transition-all"
        style={{
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border-default)',
          color: 'var(--text-primary)',
          fontFamily: 'var(--font-dm-sans)',
        }}
        onFocus={e => { e.currentTarget.style.borderColor = 'var(--border-accent)' }}
        onBlur={e => { e.currentTarget.style.borderColor = 'var(--border-default)' }}
      />
      <Button type="submit" loading={loading}>Create</Button>
      <Button type="button" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
      {error && <p className="text-xs" style={{ color: 'var(--danger)' }}>{error}</p>}
    </form>
  )
}
