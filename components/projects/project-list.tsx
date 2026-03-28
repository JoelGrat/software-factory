'use client'

import Link from 'next/link'

interface Project {
  id: string
  name: string
  created_at: string
}

export function ProjectList({ projects }: { projects: Project[] }) {
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
        <Link
          key={p.id}
          href={`/projects/${p.id}/requirements`}
          className="flex items-center justify-between px-5 py-4 rounded-xl group transition-all"
          style={{
            background: 'var(--bg-surface)',
            border: '1px solid var(--border-subtle)',
          }}
          onMouseEnter={e => {
            const el = e.currentTarget as HTMLElement
            el.style.borderColor = 'var(--border-default)'
            el.style.background = 'var(--bg-elevated)'
          }}
          onMouseLeave={e => {
            const el = e.currentTarget as HTMLElement
            el.style.borderColor = 'var(--border-subtle)'
            el.style.background = 'var(--bg-surface)'
          }}
        >
          <div className="flex items-center gap-3">
            <div className="w-2 h-2 rounded-full" style={{ background: 'var(--accent)', boxShadow: '0 0 6px var(--accent)' }} />
            <span className="font-medium text-sm" style={{ color: 'var(--text-primary)', fontFamily: 'var(--font-syne)' }}>
              {p.name}
            </span>
          </div>
          <span className="text-xs font-mono" style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-jetbrains)' }}>
            {new Date(p.created_at).toLocaleDateString('en-GB')}
          </span>
        </Link>
      ))}
    </div>
  )
}
