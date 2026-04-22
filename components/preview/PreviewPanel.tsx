// components/preview/PreviewPanel.tsx
'use client'
import { useState, useEffect, useRef, useCallback } from 'react'

type PreviewStatus =
  | 'none' | 'starting' | 'running' | 'stopped' | 'error'

interface StatusPayload {
  status: PreviewStatus
  previewId: string | null
  url: string | null
  startupLog: string
  errorMessage: string | null
  missingKeys: string[]
}

export function PreviewPanel({ changeId }: { changeId: string }) {
  const [status, setStatus] = useState<PreviewStatus>('none')
  const [previewId, setPreviewId] = useState<string | null>(null)
  const [url, setUrl] = useState<string | null>(null)
  const [startupLog, setStartupLog] = useState('')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [missingKeys, setMissingKeys] = useState<string[]>([])
  const [showLog, setShowLog] = useState(false)
  const [loading, setLoading] = useState(false)
  const [showMissingModal, setShowMissingModal] = useState(false)

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const keepaliveRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const stopPolling = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
  }, [])
  const stopKeepalive = useCallback(() => {
    if (keepaliveRef.current) { clearInterval(keepaliveRef.current); keepaliveRef.current = null }
  }, [])

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch(`/api/change-requests/${changeId}/preview/status`)
      if (!res.ok) return
      const data: StatusPayload = await res.json()
      setStatus(data.status)
      setPreviewId(data.previewId)
      setUrl(data.url)
      setStartupLog(data.startupLog)
      setErrorMessage(data.errorMessage)
      if (data.status === 'running' || data.status === 'stopped' || data.status === 'error') {
        stopPolling()
        if (data.status !== 'running') stopKeepalive()
      }
    } catch { /* ignore network errors during polling */ }
  }, [changeId, stopPolling, stopKeepalive])

  // Load initial status on mount
  useEffect(() => {
    fetchStatus()
  }, [fetchStatus])

  // Auto-expand startup log when status transitions to error
  useEffect(() => {
    if (status === 'error') setShowLog(true)
  }, [status])

  // Start keepalive loop when running
  useEffect(() => {
    if (status === 'running' && previewId) {
      stopKeepalive()
      keepaliveRef.current = setInterval(async () => {
        await fetch(`/api/change-requests/${changeId}/preview/keepalive`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ previewId }),
        })
      }, 60_000)
    } else {
      stopKeepalive()
    }
    return stopKeepalive
  }, [status, previewId, changeId, stopKeepalive])

  useEffect(() => () => { stopPolling(); stopKeepalive() }, [stopPolling, stopKeepalive])

  async function launch(force = false) {
    setLoading(true)
    setErrorMessage(null)
    setStartupLog('')
    setShowMissingModal(false)
    try {
      const res = await fetch(`/api/change-requests/${changeId}/preview/start`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force }),
      })
      const data = await res.json()
      if (data.status === 'needs_config') {
        setMissingKeys(data.missingKeys ?? [])
        setShowMissingModal(true)
        return
      }
      if (data.status === 'max_previews_reached' || data.status === 'port_exhausted') {
        setErrorMessage(data.errorMessage ?? data.status)
        setStatus('error')
        return
      }
      setPreviewId(data.previewId ?? null)
      setUrl(data.url ?? null)
      setStatus('starting')
      // Poll every 2 s until running/error
      stopPolling()
      pollRef.current = setInterval(fetchStatus, 2000)
    } finally {
      setLoading(false)
    }
  }

  async function stop() {
    if (!previewId) return
    setLoading(true)
    try {
      const res = await fetch(`/api/change-requests/${changeId}/preview/stop`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ previewId }),
      })
      if (!res.ok) {
        setErrorMessage('Failed to stop preview')
        return
      }
      setStatus('stopped')
      stopPolling(); stopKeepalive()
    } finally { setLoading(false) }
  }

  const logPanel = (startupLog || status === 'starting' || status === 'error') && (
    <div className="mt-2">
      <button type="button" onClick={() => setShowLog(v => !v)}
        className="text-[11px] text-slate-500 hover:text-slate-300 transition-colors flex items-center gap-1">
        <span className="material-symbols-outlined" style={{ fontSize: '13px' }}>
          {showLog ? 'expand_less' : 'expand_more'}
        </span>
        {showLog ? 'Hide' : 'View'} startup log
      </button>
      {showLog && (
        <div className="mt-1.5 rounded-lg bg-[#0a0f1a] border border-white/10 p-3 max-h-64 overflow-y-auto">
          <pre className="text-[10px] font-mono text-slate-400 whitespace-pre-wrap break-all">
            {startupLog || '(waiting for output…)'}
          </pre>
          <button
            onClick={() => navigator.clipboard.writeText(startupLog).catch(() => {})}
            className="mt-2 text-[10px] text-slate-600 hover:text-slate-400 transition-colors"
          >
            Copy
          </button>
        </div>
      )}
    </div>
  )

  // Missing vars modal
  const missingModal = showMissingModal && (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="rounded-xl bg-[#131b2e] border border-white/10 p-6 max-w-sm w-full mx-4 space-y-4">
        <h3 className="text-sm font-bold text-slate-200">Missing environment variables</h3>
        <p className="text-xs text-slate-400">
          The following expected keys are not saved in project settings:
        </p>
        <ul className="space-y-1">
          {missingKeys.map(k => (
            <li key={k} className="text-xs font-mono text-amber-400 flex items-center gap-1.5">
              <span className="material-symbols-outlined text-amber-500" style={{ fontSize: '13px' }}>warning</span>
              {k}
            </li>
          ))}
        </ul>
        <div className="flex gap-2 flex-wrap pt-2">
          <button onClick={() => launch(true)}
            className="px-4 py-2 rounded-lg text-xs font-semibold bg-slate-700 hover:bg-slate-600 text-slate-200 transition-colors">
            Continue anyway
          </button>
          <button onClick={() => setShowMissingModal(false)}
            className="px-4 py-2 rounded-lg text-xs font-semibold bg-[#0f1929] border border-white/10 text-slate-400 hover:text-slate-200 transition-colors">
            Cancel
          </button>
        </div>
      </div>
    </div>
  )

  if (status === 'none' || status === 'stopped') {
    return (
      <>
        {missingModal}
        <button onClick={() => launch()} disabled={loading}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-sm font-bold font-headline transition-colors">
          {loading
            ? <span className="animate-spin material-symbols-outlined" style={{ fontSize: '16px' }}>progress_activity</span>
            : <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>play_arrow</span>
          }
          {loading ? 'Launching…' : 'Launch Preview'}
        </button>
        {errorMessage && <p className="text-xs text-red-400 mt-1">{errorMessage}</p>}
      </>
    )
  }

  if (status === 'starting') {
    return (
      <div className="space-y-1">
        <div className="flex items-center gap-2 text-sm text-slate-400">
          <span className="animate-spin material-symbols-outlined text-indigo-400" style={{ fontSize: '16px' }}>progress_activity</span>
          Starting preview…
        </div>
        {logPanel}
      </div>
    )
  }

  if (status === 'running') {
    return (
      <div className="space-y-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="h-2 w-2 rounded-full bg-emerald-400 flex-shrink-0" />
          {url ? (
            <>
              <a href={url} target="_blank" rel="noreferrer"
                className="text-sm font-mono text-emerald-400 hover:text-emerald-300 underline underline-offset-2 truncate max-w-[200px]">
                {url}
              </a>
              <a href={url} target="_blank" rel="noreferrer"
                className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold transition-colors">
                <span className="material-symbols-outlined" style={{ fontSize: '13px' }}>open_in_new</span>
                Open
              </a>
            </>
          ) : (
            <span className="text-sm text-slate-500">URL not available</span>
          )}
          <button onClick={async () => { await stop(); launch() }} disabled={loading}
            className="px-3 py-1.5 rounded-lg bg-[#0f1929] border border-white/10 hover:border-white/20 text-slate-300 text-xs font-semibold transition-colors disabled:opacity-50">
            Restart
          </button>
          <button onClick={stop} disabled={loading}
            className="px-3 py-1.5 rounded-lg bg-[#0f1929] border border-white/10 hover:border-white/20 text-slate-300 text-xs font-semibold transition-colors disabled:opacity-50">
            Stop
          </button>
        </div>
        {logPanel}
      </div>
    )
  }

  if (status === 'error') {
    return (
      <>
        {missingModal}
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-red-400 flex-shrink-0" />
            <span className="text-sm text-red-400">{errorMessage ?? 'Preview failed to start'}</span>
            <button onClick={() => launch()} disabled={loading}
              className="px-3 py-1.5 rounded-lg bg-[#0f1929] border border-white/10 text-slate-300 text-xs font-semibold hover:border-white/20 transition-colors disabled:opacity-50">
              {loading ? 'Retrying…' : 'Retry'}
            </button>
          </div>
          {logPanel}
        </div>
      </>
    )
  }

  return null
}
