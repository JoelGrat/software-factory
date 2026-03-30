import type { ComponentType } from '@/lib/supabase/types'
import type { RawEdge, FileFetcher, AliasMap, ParsedComponent, LanguageParser } from './types'

export interface TypeSignals {
  hasHttpHandlers: boolean
  hasJsx: boolean
  hasDbCalls: boolean
}

export function scoreComponentType(signals: TypeSignals): ComponentType {
  const scores: Record<string, number> = { api: 0, ui: 0, db: 0, service: 1 }
  if (signals.hasHttpHandlers) scores.api += 3
  if (signals.hasJsx) scores.ui += 3
  if (signals.hasDbCalls) scores.db += 3
  const sorted = (Object.entries(scores) as [string, number][]).sort(([, a], [, b]) => b - a)
  return sorted[0][0] as ComponentType
}

export function detectAnchoredPath(filePath: string): boolean {
  return (
    filePath.startsWith('app/api/') ||
    filePath.startsWith('api/') ||
    filePath.includes('/migrations/') ||
    filePath.endsWith('schema.prisma')
  )
}

export function groupFilesByComponent(files: string[]): Map<string, string[]> {
  const groups = new Map<string, string[]>()
  for (const file of files) {
    const parts = file.split('/')
    let key: string
    if (parts.length === 1) {
      // root-level file — use filename without extension as key
      key = parts[0]!.replace(/\.[^.]+$/, '')
    } else if (parts.length === 2) {
      // one level deep — e.g. lib/index.ts → 'lib/index'
      key = `${parts[0]}/${parts[1]!.replace(/\.[^.]+$/, '')}`
    } else {
      // deeper — group by first two path segments: lib/auth/token.ts → 'lib/auth'
      key = `${parts[0]}/${parts[1]}`
    }
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(file)
  }
  return groups
}
