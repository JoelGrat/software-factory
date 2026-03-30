'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'

export function CreateProjectForm() {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [repoUrl, setRepoUrl] = useState('')
  const [repoToken, setRepoToken] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const router = useRouter()

  function reset() {
    setOpen(false)
    setName('')
    setRepoUrl('')
    setRepoToken('')
    setError(null)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          repo_url: repoUrl || undefined,
          repo_token: repoToken || undefined,
        }),
      })
      if (!res.ok) {
        const data = await res.json()
        setError(data.error ?? 'Failed to create project')
        return
      }
      const project = await res.json()
      router.push(`/projects/${project.id}`)
    } finally {
      setLoading(false)
    }
  }

  const inputStyle = {
    background: 'var(--bg-elevated)',
    border: '1px solid var(--border-default)',
    color: 'var(--text-primary)',
    fontFamily: 'var(--font-dm-sans)',
  }

  if (!open) {
    return <Button onClick={() => setOpen(true)}>+ New Project</Button>
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3 p-4 rounded-xl border border-white/10 bg-[#131b2e] w-80">
      <p className="text-xs font-bold uppercase tracking-widest text-indigo-400 font-headline">New Project</p>

      <input
        autoFocus
        value={name}
        onChange={e => setName(e.target.value)}
        placeholder="Project name"
        required
        className="w-full rounded-lg px-3 py-2 text-sm outline-none transition-all"
        style={inputStyle}
        onFocus={e => { e.currentTarget.style.borderColor = 'var(--border-accent)' }}
        onBlur={e => { e.currentTarget.style.borderColor = 'var(--border-default)' }}
      />

      <input
        value={repoUrl}
        onChange={e => setRepoUrl(e.target.value)}
        placeholder="GitHub repo URL (optional)"
        className="w-full rounded-lg px-3 py-2 text-sm outline-none transition-all"
        style={inputStyle}
        onFocus={e => { e.currentTarget.style.borderColor = 'var(--border-accent)' }}
        onBlur={e => { e.currentTarget.style.borderColor = 'var(--border-default)' }}
      />

      <input
        value={repoToken}
        onChange={e => setRepoToken(e.target.value)}
        placeholder="GitHub token (optional)"
        type="password"
        className="w-full rounded-lg px-3 py-2 text-sm outline-none transition-all"
        style={inputStyle}
        onFocus={e => { e.currentTarget.style.borderColor = 'var(--border-accent)' }}
        onBlur={e => { e.currentTarget.style.borderColor = 'var(--border-default)' }}
      />

      <div className="flex items-center gap-2 pt-1">
        <Button type="submit" loading={loading}>Create</Button>
        <Button type="button" variant="ghost" onClick={reset}>Cancel</Button>
      </div>

      {error && <p className="text-xs" style={{ color: 'var(--danger)' }}>{error}</p>}
    </form>
  )
}
