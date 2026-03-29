'use client'
import { useEffect, useRef } from 'react'
import type { LogLevel } from '@/lib/supabase/types'

const LOG_COLORS: Record<string, string> = {
  info: '#c7c4d7', warn: '#f59e0b', error: '#ffb4ab', success: '#22c55e',
}
const LOG_ICONS: Record<string, string> = {
  info: 'info', warn: 'warning', error: 'error', success: 'check_circle',
}

export interface FeedEntry {
  id: string
  level: LogLevel
  message: string
  created_at: string
}

interface Props {
  logs: FeedEntry[]
}

export function LogFeed({ logs }: Props) {
  const endRef = useRef<HTMLDivElement>(null)
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [logs])
  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-1 font-mono text-[11px]">
      {logs.length === 0 && (
        <div className="flex items-center gap-2 text-slate-500">
          <span className="material-symbols-outlined animate-pulse" style={{ fontSize: '14px' }}>hourglass_empty</span>
          <span>Waiting...</span>
        </div>
      )}
      {logs.map(log => (
        <div key={log.id} className="flex items-start gap-2 py-0.5">
          <span
            className="material-symbols-outlined mt-0.5 flex-shrink-0"
            style={{ fontSize: '12px', color: LOG_COLORS[log.level] ?? '#c7c4d7' }}
          >
            {LOG_ICONS[log.level] ?? 'circle'}
          </span>
          <div className="flex-1 min-w-0">
            <span className="text-slate-600 mr-2">{new Date(log.created_at).toLocaleTimeString()}</span>
            <span style={{ color: LOG_COLORS[log.level] ?? '#c7c4d7' }}>{log.message}</span>
          </div>
        </div>
      ))}
      <div ref={endRef} />
    </div>
  )
}
