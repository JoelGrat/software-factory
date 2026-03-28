'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'

interface Project {
  id: string
  name: string
  created_at: string
}

export function ProjectList({ projects: initial }: { projects: Project[] }) {
  const [projects, setProjects] = useState(initial)
  const [deleting, setDeleting] = useState<string | null>(null)
  const router = useRouter()

  async function handleDelete(id: string) {
    setDeleting(id)
    await fetch(`/api/projects/${id}`, { method: 'DELETE' })
    setProjects(prev => prev.filter(p => p.id !== id))
    setDeleting(null)
    router.refresh()
  }

  if (!projects.length) {
    return (
      <div
        className="rounded-xl p-12 text-center"
        style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)' }}
      >
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
          No projects yet. Create one to get started.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {projects.map(p => (
        <div
          key={p.id}
          className="flex items-center justify-between px-5 py-4 rounded-xl group transition-all bg-surface-container-low border border-white/5 hover:border-white/10 hover:bg-[#171f33]"
        >
          <Link
            href={`/projects/${p.id}/requirements`}
            className="flex items-center gap-3 flex-1 min-w-0"
          >
            <div className="w-2 h-2 rounded-full bg-indigo-400 flex-shrink-0" style={{ boxShadow: '0 0 6px rgba(129,140,248,0.6)' }} />
            <span className="font-semibold text-sm text-on-surface font-headline truncate">
              {p.name}
            </span>
          </Link>

          <div className="flex items-center gap-3 flex-shrink-0 ml-4">
            <span className="text-xs font-mono text-slate-500">
              {new Date(p.created_at).toLocaleDateString('en-GB')}
            </span>
            <button
              onClick={() => handleDelete(p.id)}
              disabled={deleting === p.id}
              className="opacity-0 group-hover:opacity-100 p-1.5 rounded-lg text-slate-500 hover:text-error hover:bg-error-container/20 transition-all disabled:opacity-40"
              title="Delete project"
            >
              {deleting === p.id
                ? <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>hourglass_empty</span>
                : <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>delete</span>
              }
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}
