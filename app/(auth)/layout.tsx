export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex items-center justify-center relative overflow-hidden" style={{ background: 'var(--bg-base)' }}>
      <div
        className="absolute inset-0 bg-grid opacity-50"
        aria-hidden="true"
      />
      <div
        className="absolute inset-0"
        style={{ background: 'radial-gradient(ellipse 80% 50% at 50% -10%, rgba(79,112,255,0.07) 0%, transparent 70%)' }}
        aria-hidden="true"
      />
      <div className="relative z-10 w-full max-w-sm px-4">{children}</div>
    </div>
  )
}
