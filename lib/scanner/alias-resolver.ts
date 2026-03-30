import type { AliasMap } from './types'

export function buildAliasMap(tsconfigContent: string): AliasMap {
  let parsed: unknown
  try {
    // Strip single-line and block comments before parsing
    const stripped = tsconfigContent
      .replace(/\/\/[^\n]*/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
    parsed = JSON.parse(stripped)
  } catch {
    return {}
  }

  const paths = (parsed as any)?.compilerOptions?.paths as Record<string, string[]> | undefined
  if (!paths) return {}

  const map: AliasMap = {}
  for (const [alias, targets] of Object.entries(paths)) {
    if (!targets[0]) continue
    const aliasPrefix = alias.replace(/\*$/, '')
    const targetPrefix = targets[0].replace(/\*$/, '').replace(/^\.\//, '')
    map[aliasPrefix] = targetPrefix
  }
  return map
}
