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
  const [checkingAccess, setCheckingAccess] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const router = useRouter()

  function reset() {
    setOpen(false)
    setName('')
    setRepoUrl('')
    setRepoToken('')
    setError(null)
  }

  async function checkGitHubAccess(url: string, token: string): Promise<string | null> {
    const match = url.trim().match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/.*)?$/)
    if (!match) return 'Could not parse GitHub repository URL'
    const [, owner, repo] = match
    try {
      const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
      })
      if (res.status === 401) return 'Access token is invalid or expired'
      if (res.status === 403) return 'Token does not have permission to access this repository'
      if (res.status === 404) return 'Repository not found — check the URL and token scope'
      if (!res.ok) return `GitHub returned ${res.status}`
      const data = await res.json()
      if (!data.permissions?.push) return 'Token needs read/write (push) access to this repository'
      return null
    } catch {
      return 'Could not reach GitHub to verify access'
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

    setCheckingAccess(true)
    try {
      const accessError = await checkGitHubAccess(repoUrl, repoToken)
      if (accessError) { setError(accessError); return }
    } finally {
      setCheckingAccess(false)
    }

    setLoading(true)
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
        placeholder="https://github.com/org/repo"
        required
        className="w-full rounded-lg px-3 py-2 text-sm outline-none transition-all"
        style={inputStyle}
        onFocus={e => { e.currentTarget.style.borderColor = 'var(--border-accent)' }}
        onBlur={e => { e.currentTarget.style.borderColor = 'var(--border-default)' }}
      />

      <input
        value={repoToken}
        onChange={e => setRepoToken(e.target.value)}
        placeholder="ghp_..."
        required
        type="password"
        className="w-full rounded-lg px-3 py-2 text-sm outline-none transition-all"
        style={inputStyle}
        onFocus={e => { e.currentTarget.style.borderColor = 'var(--border-accent)' }}
        onBlur={e => { e.currentTarget.style.borderColor = 'var(--border-default)' }}
      />

      <div className="flex items-center gap-2 pt-1">
        <Button type="submit" loading={loading || checkingAccess}>
          {checkingAccess ? 'Checking access…' : 'Create'}
        </Button>
        <Button type="button" variant="ghost" onClick={reset}>Cancel</Button>
      </div>

      {error && <p className="text-xs" style={{ color: 'var(--danger)' }}>{error}</p>}
    </form>
  )
}
