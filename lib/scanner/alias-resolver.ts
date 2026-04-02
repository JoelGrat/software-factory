import type { AliasMap } from './types'

export function buildAliasMap(tsconfigContent: string): AliasMap {
  let parsed: unknown
  try {
    // Strip single-line and block comments before parsing
    const stripped = tsconfigContent
      .replace(/\/\/[^\n]*/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
    parsed = JSON.parse(stripped)
  } catch (e) {
    console.log('[buildAliasMap] JSON.parse failed:', e, '| first 100 chars (hex):', Buffer.from(tsconfigContent.slice(0, 20)).toString('hex'))
    return {}
  }

  const paths = (parsed as any)?.compilerOptions?.paths as Record<string, string[]> | undefined
  console.log('[buildAliasMap] parsed ok, paths:', JSON.stringify(paths))
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
