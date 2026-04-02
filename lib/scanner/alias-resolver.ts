import type { AliasMap } from './types'

export function buildAliasMap(tsconfigContent: string): AliasMap {
  let parsed: unknown
  try {
    // First try raw parse (most tsconfigs are valid JSON)
    // If that fails, strip // line comments (JSONC format) and retry
    // Do NOT strip /* */ block comments with regex — glob patterns like @/* and **/*.ts
    // contain /* and */ sequences that would be incorrectly matched
    try {
      parsed = JSON.parse(tsconfigContent)
    } catch {
      const stripped = tsconfigContent
        .split('\n')
        .map(line => line.replace(/^\s*\/\/.*$/, '').replace(/\s*\/\/[^"]*$/, ''))
        .join('\n')
      parsed = JSON.parse(stripped)
    }
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
