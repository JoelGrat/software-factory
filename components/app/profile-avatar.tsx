'use client'
import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

export function ProfileAvatar() {
  const [initials, setInitials] = useState('')
  const [email, setEmail] = useState('')
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const router = useRouter()
  const db = createClient()

  useEffect(() => {
    db.auth.getUser().then(({ data: { user } }) => {
      if (!user) return
      setEmail(user.email ?? '')
      const fullName = user.user_metadata?.full_name as string | undefined
      if (fullName) {
        const parts = fullName.trim().split(/\s+/)
        setInitials(((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase())
      } else {
        setInitials((user.email?.[0] ?? '?').toUpperCase())
      }
    })
  }, [])

  useEffect(() => {
    function onOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onOutside)
    return () => document.removeEventListener('mousedown', onOutside)
  }, [])

  async function signOut() {
    await db.auth.signOut()
    router.push('/login')
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-8 h-8 rounded-full bg-surface-container-highest border border-outline-variant/20 flex items-center justify-center text-[11px] font-bold font-headline text-indigo-300 hover:border-indigo-500/40 transition-all active:scale-95 overflow-hidden"
        title={email}
      >
        {initials || <span className="material-symbols-outlined text-[14px]">person</span>}
      </button>

      {open && (
        <div className="absolute right-0 top-10 w-52 bg-surface-container-low border border-white/10 rounded-xl shadow-2xl z-50 overflow-hidden">
          {email && (
            <div className="px-3 py-2.5 border-b border-white/5">
              <p className="text-[10px] text-slate-500 truncate font-mono">{email}</p>
            </div>
          )}
          <button
            onClick={signOut}
            className="w-full text-left px-3 py-2.5 text-sm text-slate-400 hover:text-slate-200 hover:bg-[#171f33] transition-colors flex items-center gap-2"
          >
            <span className="material-symbols-outlined text-[16px]">logout</span>
            Sign out
          </button>
        </div>
      )}
    </div>
  )
}
