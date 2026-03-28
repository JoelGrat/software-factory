'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'

export default function LoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const router = useRouter()
  const supabase = createClient()

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)
    try {
      const { error } = await supabase.auth.signInWithPassword({ email, password })
      if (error) {
        setError(error.message)
      } else {
        router.push('/projects')
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <div
      className="rounded-xl p-8"
      style={{
        background: 'var(--bg-surface)',
        border: '1px solid var(--border-default)',
      }}
    >
      <div className="mb-8">
        <p className="text-xs font-mono uppercase tracking-widest mb-3" style={{ color: 'var(--accent)', fontFamily: 'var(--font-jetbrains)' }}>
          Software Factory
        </p>
        <h1 className="text-2xl font-bold" style={{ fontFamily: 'var(--font-syne)', color: 'var(--text-primary)' }}>
          Sign in
        </h1>
        <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>
          Welcome back. Let&apos;s build something.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-5">
        <div>
          <label htmlFor="email" className="block text-xs font-medium mb-2 uppercase tracking-wider" style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-syne)' }}>
            Email
          </label>
          <input
            id="email"
            type="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            required
            className="w-full rounded-lg px-4 py-3 text-sm outline-none transition-all"
            style={{
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border-default)',
              color: 'var(--text-primary)',
              fontFamily: 'var(--font-dm-sans)',
            }}
            onFocus={e => { e.currentTarget.style.borderColor = 'var(--border-accent)' }}
            onBlur={e => { e.currentTarget.style.borderColor = 'var(--border-default)' }}
          />
        </div>
        <div>
          <label htmlFor="password" className="block text-xs font-medium mb-2 uppercase tracking-wider" style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-syne)' }}>
            Password
          </label>
          <input
            id="password"
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            required
            className="w-full rounded-lg px-4 py-3 text-sm outline-none transition-all"
            style={{
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border-default)',
              color: 'var(--text-primary)',
              fontFamily: 'var(--font-dm-sans)',
            }}
            onFocus={e => { e.currentTarget.style.borderColor = 'var(--border-accent)' }}
            onBlur={e => { e.currentTarget.style.borderColor = 'var(--border-default)' }}
          />
        </div>

        {error && (
          <div className="rounded-lg px-4 py-3 text-sm" style={{ background: 'var(--danger-soft)', border: '1px solid rgba(255,69,69,0.2)', color: 'var(--danger)' }}>
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-lg py-3 text-sm font-semibold transition-all disabled:opacity-50"
          style={{
            background: loading ? 'var(--bg-overlay)' : 'var(--accent)',
            color: '#fff',
            fontFamily: 'var(--font-syne)',
            letterSpacing: '0.02em',
          }}
          onMouseEnter={e => { if (!loading) e.currentTarget.style.background = 'var(--accent-hover)' }}
          onMouseLeave={e => { if (!loading) e.currentTarget.style.background = 'var(--accent)' }}
        >
          {loading ? 'Signing in…' : 'Sign in →'}
        </button>
      </form>

      <p className="mt-6 text-xs text-center" style={{ color: 'var(--text-muted)' }}>
        No account?{' '}
        <Link href="/signup" style={{ color: 'var(--text-link)' }} className="hover:underline">
          Create one
        </Link>
      </p>
    </div>
  )
}
