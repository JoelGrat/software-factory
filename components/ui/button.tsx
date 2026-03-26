import type { ButtonHTMLAttributes } from 'react'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost'
  loading?: boolean
}

const STYLES: Record<string, { bg: string; color: string; border: string; hoverBg: string }> = {
  primary:   { bg: 'var(--accent)',        color: '#fff',                  border: 'transparent',                    hoverBg: 'var(--accent-hover)' },
  secondary: { bg: 'var(--bg-elevated)',   color: 'var(--text-primary)',   border: 'var(--border-default)',          hoverBg: 'var(--bg-overlay)' },
  danger:    { bg: 'var(--danger-soft)',   color: 'var(--danger)',         border: 'rgba(255,69,69,0.25)',           hoverBg: 'rgba(255,69,69,0.15)' },
  ghost:     { bg: 'transparent',          color: 'var(--text-secondary)', border: 'transparent',                    hoverBg: 'var(--bg-hover)' },
}

export function Button({ variant = 'primary', loading = false, disabled, children, className = '', style, ...props }: ButtonProps) {
  const s = STYLES[variant]
  return (
    <button
      disabled={disabled || loading}
      className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all disabled:opacity-40 ${className}`}
      style={{
        background: s.bg,
        color: s.color,
        border: `1px solid ${s.border}`,
        fontFamily: 'var(--font-syne)',
        letterSpacing: '0.01em',
        ...style,
      }}
      onMouseEnter={e => { if (!disabled && !loading) e.currentTarget.style.background = s.hoverBg }}
      onMouseLeave={e => { if (!disabled && !loading) e.currentTarget.style.background = s.bg }}
      {...props}
    >
      {loading && (
        <svg className="animate-spin h-3.5 w-3.5 opacity-70" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      )}
      {children}
    </button>
  )
}
