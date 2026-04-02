# Change Intelligence System — Plan 3: Repository Scanner

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the repository scanner — a pipeline that fetches a GitHub repository's file tree, parses it into a structured system model (components, file assignments, dependency edges), and writes the results to the database. Expose the scan as a POST API endpoint and surface the system model in a browsable UI page.

**Architecture:** The scanner is a pure TypeScript library (`lib/scanner/`) with no framework dependencies. A `FileFetcher` interface abstracts GitHub I/O so every parser and the orchestrator are fully unit-testable with mocks. Two parsers implement `LanguageParser`: `TypeScriptParser` (uses ts-morph for AST-level import extraction, preferred when `tsconfig.json` is present) and `HeuristicParser` (directory-grouping fallback for any repo). The orchestrator `runFullScan` is called fire-and-forget from two API routes: a dedicated `POST /api/projects/[id]/scan` endpoint and auto-trigger on project creation. The system model UI is a server-rendered page with a client-side `SystemModelBrowser` component for search/filter/expand.

**Tech Stack:** Next.js 14 App Router, TypeScript, Tailwind CSS, Supabase, Vitest, ts-morph

---

## File Structure

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `lib/scanner/types.ts` | FileFetcher, AliasMap, ParsedComponent, LanguageParser, RawEdge interfaces |
| Create | `lib/scanner/github-fetcher.ts` | parseRepoUrl, GithubFileFetcher class |
| Create | `lib/scanner/alias-resolver.ts` | buildAliasMap(tsconfigContent) |
| Create | `lib/scanner/scan-helpers.ts` | shouldReassign, isComponentUnstable pure functions |
| Create | `lib/scanner/heuristic-parser.ts` | HeuristicParser |
| Create | `lib/scanner/typescript-parser.ts` | extractImports, scoreComponentType, detectAnchoredPath, groupFilesByComponent, TypeScriptParser |
| Create | `lib/scanner/scanner.ts` | runFullScan(projectId, db) orchestrator |
| Create | `tests/lib/scanner/github-fetcher.test.ts` | Unit tests for GithubFileFetcher |
| Create | `tests/lib/scanner/alias-resolver.test.ts` | Unit tests for buildAliasMap |
| Create | `tests/lib/scanner/scan-helpers.test.ts` | Unit tests for shouldReassign and isComponentUnstable |
| Create | `tests/lib/scanner/heuristic-parser.test.ts` | Unit tests for HeuristicParser |
| Create | `tests/lib/scanner/typescript-parser.test.ts` | Unit tests for pure helpers, extractImports, TypeScriptParser |
| Create | `tests/lib/scanner/scanner.test.ts` | Integration tests for runFullScan with mocked DB |
| Create | `app/api/projects/[id]/scan/route.ts` | POST: trigger scan (auth, 202, fire-and-forget) |
| Modify | `app/api/projects/route.ts` | POST: auto-trigger scan if repo_url present |
| Create | `app/projects/[id]/system-model/page.tsx` | Server component: auth, fetch components + assignments |
| Create | `app/projects/[id]/system-model/system-model-browser.tsx` | Client component: search/filter/expand |

---

### Task 1: Install ts-morph and create scanner type definitions

**Files:**
- Create: `lib/scanner/types.ts`

Install the `ts-morph` package (AST-level TypeScript parsing) and define the shared interfaces used by every scanner module.

- [ ] **Step 1: Install ts-morph**

Run from the project root (`C:/Users/joelg/softwareFactory_git`):

```bash
npm install ts-morph
```

- [ ] **Step 2: Create `lib/scanner/types.ts`**

```typescript
export interface FileFetcher {
  getFileTree(): Promise<string[]>
  getContent(path: string): Promise<string>
}

export type AliasMap = Record<string, string>  // alias prefix → real path prefix e.g. '@/' → 'src/'

export interface RawEdge {
  fromPath: string
  toSpecifier: string   // raw import specifier (may be alias or relative)
  edgeType: 'static' | 're-export' | 'dynamic-static-string' | 'dynamic-template' | 'dynamic-computed'
}

export interface ParsedComponent {
  name: string
  type: 'service' | 'module' | 'api' | 'db' | 'ui'
  files: string[]
  dependsOn: string[]           // component names
  unknownDependencies: boolean
  exposedInterfaces: string[]
  confidence: number            // 0–100
  edges: RawEdge[]              // all raw import edges found in files
}

export interface LanguageParser {
  canParse(files: string[]): boolean
  parse(files: string[], fetcher: FileFetcher, aliases: AliasMap): Promise<ParsedComponent[]>
}
```

- [ ] **Step 3: Verify TypeScript compiles cleanly**

```bash
npx tsc --noEmit 2>&1 | grep "error TS" | grep -v "tests/" | head -10
```

Expected: 0 errors outside `tests/`.

- [ ] **Step 4: Commit**

```bash
git add lib/scanner/types.ts package.json package-lock.json
git commit -m "feat(scanner): install ts-morph and define scanner type interfaces"
```

---

### Task 2: GitHub FileFetcher

**Files:**
- Create: `tests/lib/scanner/github-fetcher.test.ts`
- Create: `lib/scanner/github-fetcher.ts`

Write tests first, then implement `parseRepoUrl` and `GithubFileFetcher`.

- [ ] **Step 1: Write failing test — `tests/lib/scanner/github-fetcher.test.ts`**

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { parseRepoUrl, GithubFileFetcher } from '@/lib/scanner/github-fetcher'

describe('parseRepoUrl', () => {
  it('parses standard GitHub URL', () => {
    expect(parseRepoUrl('https://github.com/owner/my-repo')).toEqual({ owner: 'owner', repo: 'my-repo' })
  })
  it('parses .git suffix', () => {
    expect(parseRepoUrl('https://github.com/org/project.git')).toEqual({ owner: 'org', repo: 'project' })
  })
  it('parses trailing slash', () => {
    expect(parseRepoUrl('https://github.com/owner/repo/')).toEqual({ owner: 'owner', repo: 'repo' })
  })
  it('throws on invalid URL', () => {
    expect(() => parseRepoUrl('https://gitlab.com/owner/repo')).toThrow()
  })
})

describe('GithubFileFetcher', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('getFileTree returns blob paths only', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        tree: [
          { path: 'src/index.ts', type: 'blob' },
          { path: 'src/', type: 'tree' },
          { path: 'README.md', type: 'blob' },
        ],
      }),
    } as Response)
    const fetcher = new GithubFileFetcher('https://github.com/owner/repo')
    const files = await fetcher.getFileTree()
    expect(files).toEqual(['src/index.ts', 'README.md'])
  })

  it('getFileTree sends Authorization header when token provided', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ tree: [] }),
    } as Response)
    const fetcher = new GithubFileFetcher('https://github.com/owner/repo', 'ghp_token')
    await fetcher.getFileTree()
    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/repos/owner/repo/git/trees/HEAD?recursive=1')
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer ghp_token')
  })

  it('getContent fetches and decodes base64 content', async () => {
    const content = 'export const foo = 1'
    const encoded = Buffer.from(content).toString('base64')
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ encoding: 'base64', content: encoded }),
    } as Response)
    const fetcher = new GithubFileFetcher('https://github.com/owner/repo')
    const result = await fetcher.getContent('src/foo.ts')
    expect(result).toBe(content)
  })

  it('getFileTree throws on non-ok response', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false, status: 404, statusText: 'Not Found',
    } as Response)
    const fetcher = new GithubFileFetcher('https://github.com/owner/repo')
    await expect(fetcher.getFileTree()).rejects.toThrow('404')
  })

  it('getContent throws on non-ok response', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false, status: 403, statusText: 'Forbidden',
    } as Response)
    const fetcher = new GithubFileFetcher('https://github.com/owner/repo')
    await expect(fetcher.getContent('src/foo.ts')).rejects.toThrow('403')
  })
})
```

- [ ] **Step 2: Run to confirm tests fail**

```bash
npx vitest run tests/lib/scanner/github-fetcher.test.ts 2>&1 | tail -20
```

Expected: all tests fail with "Cannot find module" or similar.

- [ ] **Step 3: Write implementation — `lib/scanner/github-fetcher.ts`**

```typescript
export function parseRepoUrl(url: string): { owner: string; repo: string } {
  const match = url.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/)
  if (!match) throw new Error(`Cannot parse GitHub URL: ${url}`)
  return { owner: match[1], repo: match[2] }
}

export class GithubFileFetcher {
  private owner: string
  private repo: string
  private token?: string

  constructor(repoUrl: string, token?: string) {
    const { owner, repo } = parseRepoUrl(repoUrl)
    this.owner = owner
    this.repo = repo
    this.token = token
  }

  private get headers(): Record<string, string> {
    const h: Record<string, string> = { Accept: 'application/vnd.github+json' }
    if (this.token) h['Authorization'] = `Bearer ${this.token}`
    return h
  }

  async getFileTree(): Promise<string[]> {
    const res = await fetch(
      `https://api.github.com/repos/${this.owner}/${this.repo}/git/trees/HEAD?recursive=1`,
      { headers: this.headers }
    )
    if (!res.ok) throw new Error(`GitHub API error: ${res.status} ${res.statusText}`)
    const data = await res.json()
    return (data.tree as Array<{ path: string; type: string }>)
      .filter(item => item.type === 'blob')
      .map(item => item.path)
  }

  async getContent(path: string): Promise<string> {
    const res = await fetch(
      `https://api.github.com/repos/${this.owner}/${this.repo}/contents/${path}`,
      { headers: this.headers }
    )
    if (!res.ok) throw new Error(`GitHub API error fetching ${path}: ${res.status} ${res.statusText}`)
    const data = await res.json()
    return Buffer.from(data.content as string, 'base64').toString('utf-8')
  }
}
```

- [ ] **Step 4: Run to confirm tests pass**

```bash
npx vitest run tests/lib/scanner/github-fetcher.test.ts 2>&1 | tail -20
```

Expected: all 9 tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/scanner/github-fetcher.ts tests/lib/scanner/github-fetcher.test.ts
git commit -m "feat(scanner): GithubFileFetcher with parseRepoUrl and base64 content decoding"
```

---

### Task 3: AliasResolver

**Files:**
- Create: `tests/lib/scanner/alias-resolver.test.ts`
- Create: `lib/scanner/alias-resolver.ts`

Parse `tsconfig.json` `paths` into a flat prefix-to-prefix map used during import resolution.

- [ ] **Step 1: Write failing test — `tests/lib/scanner/alias-resolver.test.ts`**

```typescript
import { describe, it, expect } from 'vitest'
import { buildAliasMap } from '@/lib/scanner/alias-resolver'

describe('buildAliasMap', () => {
  it('maps @/* paths from tsconfig', () => {
    const tsconfig = JSON.stringify({
      compilerOptions: {
        paths: { '@/*': ['./src/*'] }
      }
    })
    const map = buildAliasMap(tsconfig)
    expect(map['@/']).toBe('src/')
  })

  it('handles multiple aliases', () => {
    const tsconfig = JSON.stringify({
      compilerOptions: {
        paths: {
          '@/*': ['./src/*'],
          '@lib/*': ['./src/lib/*'],
        }
      }
    })
    const map = buildAliasMap(tsconfig)
    expect(map['@/']).toBe('src/')
    expect(map['@lib/']).toBe('src/lib/')
  })

  it('returns empty map when no paths configured', () => {
    const tsconfig = JSON.stringify({ compilerOptions: {} })
    expect(buildAliasMap(tsconfig)).toEqual({})
  })

  it('returns empty map on malformed JSON', () => {
    expect(buildAliasMap('{ not json')).toEqual({})
  })

  it('returns empty map when compilerOptions missing', () => {
    expect(buildAliasMap(JSON.stringify({}))).toEqual({})
  })

  it('handles tsconfig with JSON comments', () => {
    const tsconfig = `{
      // this is a comment
      "compilerOptions": {
        "paths": { "@/*": ["./src/*"] }
      }
    }`
    const map = buildAliasMap(tsconfig)
    expect(map['@/']).toBe('src/')
  })
})
```

- [ ] **Step 2: Run to confirm tests fail**

```bash
npx vitest run tests/lib/scanner/alias-resolver.test.ts 2>&1 | tail -20
```

Expected: all tests fail.

- [ ] **Step 3: Write implementation — `lib/scanner/alias-resolver.ts`**

```typescript
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
```

- [ ] **Step 4: Run to confirm tests pass**

```bash
npx vitest run tests/lib/scanner/alias-resolver.test.ts 2>&1 | tail -20
```

Expected: all 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/scanner/alias-resolver.ts tests/lib/scanner/alias-resolver.test.ts
git commit -m "feat(scanner): buildAliasMap parses tsconfig paths with comment stripping"
```

---

### Task 4: Scan helpers (pure functions)

**Files:**
- Create: `tests/lib/scanner/scan-helpers.test.ts`
- Create: `lib/scanner/scan-helpers.ts`

Two pure functions that encode the reassignment cooldown logic and component stability rules. These are intentionally framework-free and fully deterministic.

- [ ] **Step 1: Write failing test — `tests/lib/scanner/scan-helpers.test.ts`**

```typescript
import { describe, it, expect } from 'vitest'
import { shouldReassign, isComponentUnstable } from '@/lib/scanner/scan-helpers'

describe('shouldReassign', () => {
  it('returns true when confidence gap > 25 and cooldown met', () => {
    expect(shouldReassign(50, 80, 3)).toBe(true)
  })
  it('returns true when confidence gap > 25 and exactly 3 scans since move', () => {
    expect(shouldReassign(50, 80, 3)).toBe(true)
  })
  it('returns false when confidence gap > 25 but cooldown not met', () => {
    expect(shouldReassign(50, 80, 2)).toBe(false)
  })
  it('returns false when confidence gap exactly 25 (not > 25)', () => {
    expect(shouldReassign(50, 75, 5)).toBe(false)
  })
  it('overrides cooldown when confidence gap > 50', () => {
    expect(shouldReassign(20, 80, 1)).toBe(true)
  })
  it('overrides cooldown at exactly > 50 gap', () => {
    expect(shouldReassign(20, 71, 0)).toBe(true)
  })
  it('does NOT override cooldown at exactly 50 gap', () => {
    expect(shouldReassign(20, 70, 0)).toBe(false)
  })
  it('returns false when new confidence is lower', () => {
    expect(shouldReassign(80, 50, 10)).toBe(false)
  })
})

describe('isComponentUnstable', () => {
  it('returns true when reassignmentCount > 3', () => {
    expect(isComponentUnstable(4, 80)).toBe(true)
  })
  it('returns false at exactly 3 reassignments', () => {
    expect(isComponentUnstable(3, 80)).toBe(false)
  })
  it('returns true when avgConfidence < 40', () => {
    expect(isComponentUnstable(0, 39)).toBe(true)
  })
  it('returns false at exactly 40 confidence', () => {
    expect(isComponentUnstable(0, 40)).toBe(false)
  })
  it('returns false when both are within bounds', () => {
    expect(isComponentUnstable(2, 75)).toBe(false)
  })
})
```

- [ ] **Step 2: Run to confirm tests fail**

```bash
npx vitest run tests/lib/scanner/scan-helpers.test.ts 2>&1 | tail -20
```

Expected: all tests fail.

- [ ] **Step 3: Write implementation — `lib/scanner/scan-helpers.ts`**

```typescript
/**
 * Whether to reassign a file's canonical component owner.
 * @param currentConf     current assignment confidence (0–100)
 * @param newConf         new candidate confidence (0–100)
 * @param scansSinceMove  number of scans elapsed since the last reassignment
 */
export function shouldReassign(currentConf: number, newConf: number, scansSinceMove: number): boolean {
  const gap = newConf - currentConf
  if (gap <= 25) return false
  if (gap > 50) return true          // obvious wrong case — override cooldown
  return scansSinceMove >= 3          // normal reassignment requires cooldown
}

/**
 * Whether a component should be marked as unstable.
 */
export function isComponentUnstable(reassignmentCount: number, avgConfidence: number): boolean {
  return reassignmentCount > 3 || avgConfidence < 40
}
```

- [ ] **Step 4: Run to confirm tests pass**

```bash
npx vitest run tests/lib/scanner/scan-helpers.test.ts 2>&1 | tail -20
```

Expected: all 13 tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/scanner/scan-helpers.ts tests/lib/scanner/scan-helpers.test.ts
git commit -m "feat(scanner): shouldReassign and isComponentUnstable pure helper functions"
```

---

### Task 5: HeuristicParser

**Files:**
- Create: `tests/lib/scanner/heuristic-parser.test.ts`
- Create: `lib/scanner/heuristic-parser.ts`

A fallback parser that groups files by their top-level directory segment and classifies each group by name. Used for non-TypeScript repos or when `tsconfig.json` is absent.

- [ ] **Step 1: Write failing test — `tests/lib/scanner/heuristic-parser.test.ts`**

```typescript
import { describe, it, expect } from 'vitest'
import { HeuristicParser } from '@/lib/scanner/heuristic-parser'

const mockFetcher = { getFileTree: async () => [], getContent: async () => '' }
const emptyAliases = {}

describe('HeuristicParser', () => {
  const parser = new HeuristicParser()

  it('canParse returns true for any file list', () => {
    expect(parser.canParse([])).toBe(true)
    expect(parser.canParse(['src/foo.py', 'main.go'])).toBe(true)
  })

  it('groups files by first path segment', async () => {
    const files = ['lib/auth.ts', 'lib/utils.ts', 'app/page.tsx']
    const result = await parser.parse(files, mockFetcher, emptyAliases)
    const names = result.map(c => c.name).sort()
    expect(names).toEqual(['app', 'lib'])
  })

  it('handles files with no directory (root level)', async () => {
    const files = ['middleware.ts', 'next.config.ts']
    const result = await parser.parse(files, mockFetcher, emptyAliases)
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('root')
  })

  it('classifies api directory as api type', async () => {
    const result = await parser.parse(['api/users.ts'], mockFetcher, emptyAliases)
    expect(result[0].type).toBe('api')
  })

  it('classifies routes directory as api type', async () => {
    const result = await parser.parse(['routes/auth.ts'], mockFetcher, emptyAliases)
    expect(result[0].type).toBe('api')
  })

  it('classifies components directory as ui type', async () => {
    const result = await parser.parse(['components/Button.tsx'], mockFetcher, emptyAliases)
    expect(result[0].type).toBe('ui')
  })

  it('classifies db directory as db type', async () => {
    const result = await parser.parse(['db/schema.ts'], mockFetcher, emptyAliases)
    expect(result[0].type).toBe('db')
  })

  it('classifies unknown directory as module type', async () => {
    const result = await parser.parse(['lib/scanner.ts'], mockFetcher, emptyAliases)
    expect(result[0].type).toBe('module')
  })

  it('sets unknownDependencies true on all components', async () => {
    const result = await parser.parse(['lib/foo.ts', 'app/bar.tsx'], mockFetcher, emptyAliases)
    expect(result.every(c => c.unknownDependencies)).toBe(true)
  })

  it('sets confidence to 30', async () => {
    const result = await parser.parse(['lib/foo.ts'], mockFetcher, emptyAliases)
    expect(result[0].confidence).toBe(30)
  })

  it('sets dependsOn to empty array', async () => {
    const result = await parser.parse(['lib/foo.ts'], mockFetcher, emptyAliases)
    expect(result[0].dependsOn).toEqual([])
  })

  it('sets edges to empty array', async () => {
    const result = await parser.parse(['lib/foo.ts'], mockFetcher, emptyAliases)
    expect(result[0].edges).toEqual([])
  })
})
```

- [ ] **Step 2: Run to confirm tests fail**

```bash
npx vitest run tests/lib/scanner/heuristic-parser.test.ts 2>&1 | tail -20
```

Expected: all tests fail.

- [ ] **Step 3: Write implementation — `lib/scanner/heuristic-parser.ts`**

```typescript
import type { LanguageParser, FileFetcher, AliasMap, ParsedComponent } from './types'
import type { ComponentType } from '@/lib/supabase/types'

const DIR_TYPE_MAP: Record<string, ComponentType> = {
  routes: 'api', api: 'api',
  ui: 'ui', components: 'ui', views: 'ui', pages: 'ui',
  db: 'db', database: 'db', models: 'db', prisma: 'db',
}

export class HeuristicParser implements LanguageParser {
  canParse(_files: string[]): boolean {
    return true
  }

  async parse(files: string[], _fetcher: FileFetcher, _aliases: AliasMap): Promise<ParsedComponent[]> {
    const groups = new Map<string, string[]>()
    for (const file of files) {
      const segment = file.includes('/') ? file.split('/')[0]! : 'root'
      if (!groups.has(segment)) groups.set(segment, [])
      groups.get(segment)!.push(file)
    }
    return Array.from(groups.entries()).map(([dir, dirFiles]) => ({
      name: dir,
      type: DIR_TYPE_MAP[dir.toLowerCase()] ?? 'module',
      files: dirFiles,
      dependsOn: [],
      unknownDependencies: true,
      exposedInterfaces: [],
      confidence: 30,
      edges: [],
    }))
  }
}
```

- [ ] **Step 4: Run to confirm tests pass**

```bash
npx vitest run tests/lib/scanner/heuristic-parser.test.ts 2>&1 | tail -20
```

Expected: all 12 tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/scanner/heuristic-parser.ts tests/lib/scanner/heuristic-parser.test.ts
git commit -m "feat(scanner): HeuristicParser groups files by top-level directory with type classification"
```

---

### Task 6: TypeScript parser — pure helpers

**Files:**
- Create: `tests/lib/scanner/typescript-parser.test.ts` (pure helper section only)
- Create: `lib/scanner/typescript-parser.ts` (pure helpers only — class added in Task 7)

Define and test the three pure helper functions used by `TypeScriptParser` before adding the AST-dependent logic.

- [ ] **Step 1: Write failing test — `tests/lib/scanner/typescript-parser.test.ts`**

Create the file with just the pure helper tests. The `extractImports` and `TypeScriptParser` tests will be appended in Task 7.

```typescript
import { describe, it, expect } from 'vitest'
import { scoreComponentType, detectAnchoredPath, groupFilesByComponent } from '@/lib/scanner/typescript-parser'

describe('scoreComponentType', () => {
  it('returns api when hasHttpHandlers', () => {
    expect(scoreComponentType({ hasHttpHandlers: true, hasJsx: false, hasDbCalls: false })).toBe('api')
  })
  it('returns ui when hasJsx', () => {
    expect(scoreComponentType({ hasHttpHandlers: false, hasJsx: true, hasDbCalls: false })).toBe('ui')
  })
  it('returns db when hasDbCalls', () => {
    expect(scoreComponentType({ hasHttpHandlers: false, hasJsx: false, hasDbCalls: true })).toBe('db')
  })
  it('returns service when no specific signals', () => {
    expect(scoreComponentType({ hasHttpHandlers: false, hasJsx: false, hasDbCalls: false })).toBe('service')
  })
  it('api wins over ui when both signals present', () => {
    expect(scoreComponentType({ hasHttpHandlers: true, hasJsx: true, hasDbCalls: false })).toBe('api')
  })
})

describe('detectAnchoredPath', () => {
  it('anchors paths under app/api/', () => {
    expect(detectAnchoredPath('app/api/projects/route.ts')).toBe(true)
  })
  it('anchors paths under api/', () => {
    expect(detectAnchoredPath('api/users.ts')).toBe(true)
  })
  it('anchors migration files', () => {
    expect(detectAnchoredPath('supabase/migrations/001_init.sql')).toBe(true)
  })
  it('anchors schema.prisma', () => {
    expect(detectAnchoredPath('prisma/schema.prisma')).toBe(true)
  })
  it('does not anchor regular files', () => {
    expect(detectAnchoredPath('lib/auth/token.ts')).toBe(false)
    expect(detectAnchoredPath('components/Button.tsx')).toBe(false)
  })
})

describe('groupFilesByComponent', () => {
  it('groups by second path segment', () => {
    const groups = groupFilesByComponent(['lib/auth/token.ts', 'lib/auth/session.ts', 'lib/utils.ts'])
    expect(groups.get('lib/auth')).toEqual(['lib/auth/token.ts', 'lib/auth/session.ts'])
    expect(groups.get('lib/utils')).toEqual(['lib/utils.ts'])
  })
  it('uses first segment when no second', () => {
    const groups = groupFilesByComponent(['middleware.ts'])
    expect(groups.get('middleware')).toEqual(['middleware.ts'])
  })
  it('uses second segment when file is directly in first-level dir', () => {
    const groups = groupFilesByComponent(['lib/index.ts'])
    expect(groups.get('lib/index')).toEqual(['lib/index.ts'])
  })
})
```

- [ ] **Step 2: Run to confirm tests fail**

```bash
npx vitest run tests/lib/scanner/typescript-parser.test.ts 2>&1 | tail -20
```

Expected: all tests fail.

- [ ] **Step 3: Write pure helper implementations — `lib/scanner/typescript-parser.ts`**

Create the file with just the pure helpers. `extractImports` and `TypeScriptParser` will be added in Task 7.

```typescript
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
```

- [ ] **Step 4: Run to confirm pure helper tests pass**

```bash
npx vitest run tests/lib/scanner/typescript-parser.test.ts 2>&1 | tail -20
```

Expected: all 13 tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/scanner/typescript-parser.ts tests/lib/scanner/typescript-parser.test.ts
git commit -m "feat(scanner): scoreComponentType, detectAnchoredPath, groupFilesByComponent pure helpers"
```

---

### Task 7: TypeScript parser — import extraction and full class

**Files:**
- Modify: `tests/lib/scanner/typescript-parser.test.ts` (append extractImports and TypeScriptParser tests)
- Modify: `lib/scanner/typescript-parser.ts` (append extractImports and TypeScriptParser class)

Add AST-level import extraction using ts-morph and the full `TypeScriptParser` class that integrates all helpers.

- [ ] **Step 1: Append failing tests to `tests/lib/scanner/typescript-parser.test.ts`**

Append the following to the bottom of the existing test file:

```typescript
import { extractImports, TypeScriptParser } from '@/lib/scanner/typescript-parser'
import type { FileFetcher } from '@/lib/scanner/types'

describe('extractImports', () => {
  it('extracts static imports', () => {
    const source = `import { foo } from './bar'`
    const result = extractImports('test.ts', source)
    expect(result).toContainEqual({ fromPath: 'test.ts', toSpecifier: './bar', edgeType: 'static' })
  })

  it('classifies re-exports', () => {
    const source = `export { foo } from './qux'`
    const result = extractImports('test.ts', source)
    expect(result).toContainEqual({ fromPath: 'test.ts', toSpecifier: './qux', edgeType: 're-export' })
  })

  it('classifies dynamic import with string literal', () => {
    const source = `const mod = import('./dynamic')`
    const result = extractImports('test.ts', source)
    expect(result).toContainEqual({ fromPath: 'test.ts', toSpecifier: './dynamic', edgeType: 'dynamic-static-string' })
  })

  it('returns empty array for file with no imports', () => {
    const source = `export const x = 1`
    expect(extractImports('test.ts', source)).toEqual([])
  })
})

describe('TypeScriptParser', () => {
  it('canParse returns true when tsconfig.json present', () => {
    const parser = new TypeScriptParser()
    expect(parser.canParse(['tsconfig.json', 'src/index.ts'])).toBe(true)
  })

  it('canParse returns true when next.config.ts present', () => {
    const parser = new TypeScriptParser()
    expect(parser.canParse(['next.config.ts', 'app/page.tsx'])).toBe(true)
  })

  it('canParse returns false for non-TS project', () => {
    const parser = new TypeScriptParser()
    expect(parser.canParse(['main.py', 'requirements.txt'])).toBe(false)
  })

  it('parse produces components grouped by directory', async () => {
    const parser = new TypeScriptParser()
    const mockFetcher: FileFetcher = {
      getFileTree: async () => [],
      getContent: async (path: string) => {
        if (path === 'lib/auth/token.ts') return `import { createClient } from '@supabase/supabase-js'`
        if (path === 'app/api/auth/route.ts') return `export async function GET(req: Request) {}`
        return ''
      },
    }
    const files = ['tsconfig.json', 'lib/auth/token.ts', 'app/api/auth/route.ts']
    const components = await parser.parse(files, mockFetcher, { '@/': '' })
    expect(components.length).toBeGreaterThan(0)
    const authComponent = components.find(c => c.name === 'lib/auth')
    expect(authComponent).toBeDefined()
    expect(authComponent?.type).toBe('db')  // imports supabase client → db signal
    const apiComponent = components.find(c => c.name === 'app/api')
    expect(apiComponent).toBeDefined()
    expect(apiComponent?.type).toBe('api')  // HTTP handler signal
  })
})
```

- [ ] **Step 2: Run to confirm new tests fail**

```bash
npx vitest run tests/lib/scanner/typescript-parser.test.ts 2>&1 | tail -20
```

Expected: the previously passing pure helper tests still pass; `extractImports` and `TypeScriptParser` tests fail.

- [ ] **Step 3: Append implementation to `lib/scanner/typescript-parser.ts`**

Add the following imports at the top of the file (after existing imports):

```typescript
import { Project, Node, SyntaxKind } from 'ts-morph'
```

Then append after the existing pure helpers:

```typescript
const DB_IMPORT_PATTERNS = [
  '@supabase/supabase-js', '@supabase/ssr', 'prisma', '@prisma/client',
  'pg', 'mongoose', 'sequelize', 'typeorm',
]
const HTTP_EXPORT_NAMES = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD']

export function extractImports(filePath: string, sourceCode: string): RawEdge[] {
  const project = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true })
  const sf = project.createSourceFile(filePath, sourceCode, { overwrite: true })
  const results: RawEdge[] = []

  // Static imports: import { foo } from './bar'
  for (const imp of sf.getImportDeclarations()) {
    results.push({ fromPath: filePath, toSpecifier: imp.getModuleSpecifierValue(), edgeType: 'static' })
  }

  // Re-exports: export { foo } from './bar'
  for (const exp of sf.getExportDeclarations()) {
    const spec = exp.getModuleSpecifierValue()
    if (spec) results.push({ fromPath: filePath, toSpecifier: spec, edgeType: 're-export' })
  }

  // Dynamic imports: import('./foo'), import(`./foo/${bar}`)
  for (const node of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expr = node.getExpression()
    if (expr.getKind() !== SyntaxKind.ImportKeyword) continue
    const arg = node.getArguments()[0]
    if (!arg) continue
    if (Node.isStringLiteral(arg)) {
      results.push({ fromPath: filePath, toSpecifier: arg.getLiteralText(), edgeType: 'dynamic-static-string' })
    } else if (
      arg.getKind() === SyntaxKind.TemplateExpression ||
      arg.getKind() === SyntaxKind.NoSubstitutionTemplateLiteral
    ) {
      const text = arg.getText().replace(/`/g, '').replace(/\$\{[^}]*\}/g, '').trim()
      results.push({ fromPath: filePath, toSpecifier: text, edgeType: 'dynamic-template' })
    } else {
      results.push({ fromPath: filePath, toSpecifier: arg.getText(), edgeType: 'dynamic-computed' })
    }
  }

  return results
}

function detectTypeSignals(filePath: string, sourceCode: string): TypeSignals {
  const hasJsx = filePath.endsWith('.tsx') || filePath.endsWith('.jsx')
  const hasDbCalls = DB_IMPORT_PATTERNS.some(p => sourceCode.includes(p))
  const hasHttpHandlers =
    filePath.includes('/route.ts') ||
    filePath.includes('/route.tsx') ||
    HTTP_EXPORT_NAMES.some(
      name =>
        sourceCode.includes(`export async function ${name}`) ||
        sourceCode.includes(`export function ${name}`)
    )
  return { hasHttpHandlers, hasJsx, hasDbCalls }
}

export class TypeScriptParser implements LanguageParser {
  canParse(files: string[]): boolean {
    return files.some(f => f === 'tsconfig.json' || f.startsWith('next.config.'))
  }

  async parse(files: string[], fetcher: FileFetcher, _aliases: AliasMap): Promise<ParsedComponent[]> {
    // Only parse code files; skip config, tests, and lock files
    const codeFiles = files.filter(
      f =>
        (f.endsWith('.ts') || f.endsWith('.tsx') || f.endsWith('.js') || f.endsWith('.jsx')) &&
        !f.endsWith('.test.ts') &&
        !f.endsWith('.test.tsx') &&
        !f.endsWith('.spec.ts') &&
        !f.endsWith('.spec.tsx')
    )

    const groups = groupFilesByComponent(codeFiles)
    const components: ParsedComponent[] = []

    for (const [componentName, componentFiles] of groups.entries()) {
      const allEdges: RawEdge[] = []
      let hasHttpHandlers = false
      let hasJsx = false
      let hasDbCalls = false

      for (const file of componentFiles) {
        let source = ''
        try {
          source = await fetcher.getContent(file)
        } catch {
          continue
        }
        const edges = extractImports(file, source)
        allEdges.push(...edges)
        const signals = detectTypeSignals(file, source)
        if (signals.hasHttpHandlers) hasHttpHandlers = true
        if (signals.hasJsx) hasJsx = true
        if (signals.hasDbCalls) hasDbCalls = true
      }

      const signals: TypeSignals = { hasHttpHandlers, hasJsx, hasDbCalls }
      const type = scoreComponentType(signals)
      const signalCount = (hasHttpHandlers ? 1 : 0) + (hasJsx ? 1 : 0) + (hasDbCalls ? 1 : 0)
      const confidence = signalCount > 0 ? Math.min(50 + signalCount * 15, 90) : 50

      components.push({
        name: componentName,
        type,
        files: componentFiles,
        dependsOn: [],
        unknownDependencies: false,
        exposedInterfaces: [],
        confidence,
        edges: allEdges,
      })
    }

    return components
  }
}
```

- [ ] **Step 4: Run to confirm all tests pass**

```bash
npx vitest run tests/lib/scanner/typescript-parser.test.ts 2>&1 | tail -20
```

Expected: all tests pass (pure helpers + extractImports + TypeScriptParser).

- [ ] **Step 5: TypeScript check**

```bash
npx tsc --noEmit 2>&1 | grep "error TS" | grep -v "tests/" | head -10
```

Expected: 0 errors outside `tests/`.

- [ ] **Step 6: Commit**

```bash
git add lib/scanner/typescript-parser.ts tests/lib/scanner/typescript-parser.test.ts
git commit -m "feat(scanner): extractImports (ts-morph AST) and TypeScriptParser class"
```

---

### Task 8: Full scan orchestrator

**Files:**
- Create: `tests/lib/scanner/scanner.test.ts`
- Create: `lib/scanner/scanner.ts`

The orchestrator wires every scanner module together: fetches file tree, resolves aliases, selects a parser, upserts files/components/edges/assignments to DB, and updates `scan_status` throughout.

- [ ] **Step 1: Write failing test — `tests/lib/scanner/scanner.test.ts`**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { runFullScan } from '@/lib/scanner/scanner'

// Mock the fetcher
const mockFileTree = ['tsconfig.json', 'lib/auth/token.ts', 'app/api/projects/route.ts']
const mockContent: Record<string, string> = {
  'tsconfig.json': JSON.stringify({ compilerOptions: { paths: { '@/*': ['./src/*'] } } }),
  'lib/auth/token.ts': `export function getToken() {}`,
  'app/api/projects/route.ts': `export async function GET(req: Request) {}`,
}

vi.mock('@/lib/scanner/github-fetcher', () => ({
  GithubFileFetcher: vi.fn().mockImplementation(() => ({
    getFileTree: async () => mockFileTree,
    getContent: async (path: string) => mockContent[path] ?? '',
  })),
}))

function makeDb(project = { id: 'proj-1', repo_url: 'https://github.com/owner/repo', repo_token: null }) {
  const calls: Array<{ table: string; op: string; data?: unknown }> = []
  const db = {
    from: (table: string) => ({
      select: () => ({ eq: () => ({ single: async () => ({ data: project, error: null }) }) }),
      update: (data: unknown) => {
        calls.push({ table, op: 'update', data })
        return { eq: () => ({ error: null }) }
      },
      upsert: (data: unknown) => {
        calls.push({ table, op: 'upsert', data })
        return {
          select: () => ({
            data: Array.isArray(data)
              ? data.map((d: any, i: number) => ({ ...d, id: `id-${i}` }))
              : [{ ...data, id: 'id-0' }],
            error: null,
          }),
        }
      },
      insert: (data: unknown) => {
        calls.push({ table, op: 'insert', data })
        return { error: null }
      },
      in: () => ({ eq: () => ({ data: [], error: null }) }),
      is: () => ({ order: () => ({ data: [], error: null }) }),
    }),
    _calls: calls,
  }
  return db
}

describe('runFullScan', () => {
  it('sets scan_status to scanning then ready on success', async () => {
    const db = makeDb()
    await runFullScan('proj-1', db as any)
    const updates = db._calls.filter(c => c.table === 'projects' && c.op === 'update')
    const statuses = updates.map((u: any) => (u.data as any).scan_status)
    expect(statuses).toContain('scanning')
    expect(statuses).toContain('ready')
  })

  it('upserts files from file tree', async () => {
    const db = makeDb()
    await runFullScan('proj-1', db as any)
    const fileUpserts = db._calls.filter(c => c.table === 'files' && c.op === 'upsert')
    expect(fileUpserts.length).toBeGreaterThan(0)
  })

  it('upserts system_components', async () => {
    const db = makeDb()
    await runFullScan('proj-1', db as any)
    const compUpserts = db._calls.filter(c => c.table === 'system_components' && c.op === 'upsert')
    expect(compUpserts.length).toBeGreaterThan(0)
  })

  it('sets scan_status to failed with error message when fetch fails', async () => {
    const { GithubFileFetcher } = await import('@/lib/scanner/github-fetcher')
    vi.mocked(GithubFileFetcher).mockImplementationOnce(() => ({
      getFileTree: async () => { throw new Error('Network error') },
      getContent: async () => '',
    }))
    const db = makeDb()
    await runFullScan('proj-1', db as any)
    const failUpdate = db._calls.find(
      (c: any) => c.table === 'projects' && (c.data as any)?.scan_status === 'failed'
    )
    expect(failUpdate).toBeDefined()
    expect((failUpdate?.data as any)?.scan_error).toBe('Network error')
  })
})
```

- [ ] **Step 2: Run to confirm tests fail**

```bash
npx vitest run tests/lib/scanner/scanner.test.ts 2>&1 | tail -20
```

Expected: all tests fail.

- [ ] **Step 3: Write implementation — `lib/scanner/scanner.ts`**

```typescript
import type { SupabaseClient } from '@supabase/supabase-js'
import { GithubFileFetcher } from './github-fetcher'
import { buildAliasMap } from './alias-resolver'
import { TypeScriptParser } from './typescript-parser'
import { HeuristicParser } from './heuristic-parser'
import { isComponentUnstable } from './scan-helpers'
import type { ParsedComponent } from './types'

export async function runFullScan(projectId: string, db: SupabaseClient): Promise<void> {
  // 1. Get project
  const { data: project } = await db
    .from('projects')
    .select('id, repo_url, repo_token')
    .eq('id', projectId)
    .single()

  if (!project?.repo_url) {
    await db
      .from('projects')
      .update({ scan_status: 'failed', scan_error: 'No repo_url configured' })
      .eq('id', projectId)
    return
  }

  // 2. Mark scanning
  await db
    .from('projects')
    .update({ scan_status: 'scanning', scan_error: null })
    .eq('id', projectId)

  try {
    // 3. Fetch file tree
    const fetcher = new GithubFileFetcher(project.repo_url, project.repo_token ?? undefined)
    const files = await fetcher.getFileTree()

    // 4. Build alias map from tsconfig.json if present
    let aliasMap = {}
    if (files.includes('tsconfig.json')) {
      try {
        const content = await fetcher.getContent('tsconfig.json')
        aliasMap = buildAliasMap(content)
      } catch {
        // Non-fatal: proceed with empty alias map
      }
    }

    // 5. Select parser
    const tsParser = new TypeScriptParser()
    const heuristicParser = new HeuristicParser()
    const parser = tsParser.canParse(files) ? tsParser : heuristicParser

    // 6. Parse into components
    const components: ParsedComponent[] = await parser.parse(files, fetcher, aliasMap)

    // 7. Upsert files
    const fileRows = files.map(path => ({ project_id: projectId, path, hash: null }))
    const { data: upsertedFiles } = await db
      .from('files')
      .upsert(fileRows, { onConflict: 'project_id,path' })
      .select()
    const fileIdMap = new Map<string, string>()
    for (const f of (upsertedFiles ?? [])) fileIdMap.set(f.path, f.id)

    // 8. Fetch existing components for stability tracking
    const { data: existingComponents } = await db
      .from('system_components')
      .select('id, name, scan_count, reassignment_count, status')
      .eq('project_id', projectId)
      .is('deleted_at', null)
    const existingMap = new Map<string, { id: string; scan_count: number; reassignment_count: number; status: string }>()
    for (const c of (existingComponents ?? [])) existingMap.set(c.name, c)

    // 9. Upsert system_components
    const now = new Date().toISOString()
    const componentRows = components.map(c => {
      const existing = existingMap.get(c.name)
      const newScanCount = (existing?.scan_count ?? 0) + 1
      const unstable = isComponentUnstable(existing?.reassignment_count ?? 0, c.confidence)
      const isAnchored = c.files.some(f => f.startsWith('app/api/') || f.startsWith('api/'))
      return {
        project_id: projectId,
        name: c.name,
        type: c.type,
        exposed_interfaces: c.exposedInterfaces,
        status: unstable ? 'unstable' : 'stable',
        is_anchored: isAnchored,
        scan_count: newScanCount,
        last_updated: now,
        deleted_at: null,
      }
    })
    const { data: upsertedComponents } = await db
      .from('system_components')
      .upsert(componentRows, { onConflict: 'project_id,name' })
      .select()
    const componentIdMap = new Map<string, string>()
    for (const c of (upsertedComponents ?? [])) componentIdMap.set(c.name, c.id)

    // 10. Upsert component_assignment (one row per file)
    for (const comp of components) {
      const componentId = componentIdMap.get(comp.name)
      if (!componentId) continue
      for (const file of comp.files) {
        const fileId = fileIdMap.get(file)
        if (!fileId) continue
        await db.from('component_assignment').upsert(
          {
            file_id: fileId,
            component_id: componentId,
            confidence: comp.confidence,
            is_primary: true,
            status: 'assigned',
            reassignment_count: 0,
            last_validated_at: now,
            last_moved_at: now,
          },
          { onConflict: 'file_id' }
        )
      }
    }

    // 11. Upsert component_graph_edges (resolved import edges)
    const edgeRows = components.flatMap(comp =>
      comp.edges
        .filter(e => fileIdMap.has(e.fromPath))
        .flatMap(e => {
          const toPath = resolveSpecifier(e.toSpecifier, e.fromPath, aliasMap, files)
          if (!toPath || !fileIdMap.has(toPath)) return []
          return [{
            from_file_id: fileIdMap.get(e.fromPath)!,
            to_file_id: fileIdMap.get(toPath)!,
            project_id: projectId,
            edge_type: e.edgeType,
          }]
        })
    )
    if (edgeRows.length > 0) {
      await db
        .from('component_graph_edges')
        .upsert(edgeRows, { onConflict: 'from_file_id,to_file_id' })
    }

    // 12. Upsert component_dependencies (component-to-component)
    const depRows = components.flatMap(comp => {
      const fromId = componentIdMap.get(comp.name)
      if (!fromId) return []
      return comp.dependsOn
        .map(depName => componentIdMap.get(depName))
        .filter((id): id is string => !!id)
        .map(toId => ({ from_id: fromId, to_id: toId, type: 'sync' as const, deleted_at: null }))
    })
    if (depRows.length > 0) {
      await db
        .from('component_dependencies')
        .upsert(depRows, { onConflict: 'from_id,to_id' })
    }

    // 13. Insert component version snapshots
    const versionRows = components
      .map(c => ({
        component_id: componentIdMap.get(c.name)!,
        version: (existingMap.get(c.name)?.scan_count ?? 0) + 1,
        snapshot: { name: c.name, type: c.type, files: c.files, confidence: c.confidence } as Record<string, unknown>,
        created_at: now,
      }))
      .filter(v => v.component_id)
    if (versionRows.length > 0) {
      await db.from('system_component_versions').insert(versionRows)
    }

    // 14. Mark ready
    await db
      .from('projects')
      .update({ scan_status: 'ready', scan_error: null })
      .eq('id', projectId)

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await db
      .from('projects')
      .update({ scan_status: 'failed', scan_error: message })
      .eq('id', projectId)
  }
}

function resolveSpecifier(
  specifier: string,
  fromPath: string,
  aliases: Record<string, string>,
  files: string[]
): string | null {
  let resolved = specifier

  // Apply alias substitutions
  for (const [prefix, target] of Object.entries(aliases)) {
    if (resolved.startsWith(prefix)) {
      resolved = resolved.replace(prefix, target)
      break
    }
  }

  // Resolve relative paths
  if (resolved.startsWith('.')) {
    const fromDir = fromPath.split('/').slice(0, -1).join('/')
    const joined = fromDir ? `${fromDir}/${resolved}` : resolved
    const parts = joined.split('/')
    const normalized: string[] = []
    for (const p of parts) {
      if (p === '..') normalized.pop()
      else if (p !== '.') normalized.push(p)
    }
    resolved = normalized.join('/')
  }

  // Try common extensions
  const candidates = ['', '.ts', '.tsx', '/index.ts', '/index.tsx', '.js', '.jsx', '/index.js']
  for (const ext of candidates) {
    const candidate = resolved + ext
    if (files.includes(candidate)) return candidate
  }
  return null
}
```

- [ ] **Step 4: Run to confirm tests pass**

```bash
npx vitest run tests/lib/scanner/scanner.test.ts 2>&1 | tail -20
```

Expected: all 4 tests pass.

- [ ] **Step 5: TypeScript check**

```bash
npx tsc --noEmit 2>&1 | grep "error TS" | grep -v "tests/" | head -10
```

Expected: 0 errors outside `tests/`.

- [ ] **Step 6: Run all scanner tests**

```bash
npx vitest run tests/lib/scanner/ 2>&1 | tail -15
```

Expected: all scanner tests pass.

- [ ] **Step 7: Commit**

```bash
git add lib/scanner/scanner.ts tests/lib/scanner/scanner.test.ts
git commit -m "feat(scanner): runFullScan orchestrator with file/component/edge upserts"
```

---

### Task 9: Scan API endpoint and auto-trigger on project creation

**Files:**
- Create: `app/api/projects/[id]/scan/route.ts`
- Modify: `app/api/projects/route.ts`

Expose scanning as a POST endpoint and wire auto-trigger when a project is created with a `repo_url`.

- [ ] **Step 1: Create `app/api/projects/[id]/scan/route.ts`**

```typescript
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { runFullScan } from '@/lib/scanner/scanner'

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: project } = await db
    .from('projects')
    .select('id, repo_url')
    .eq('id', id)
    .eq('owner_id', user.id)
    .single()

  if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (!project.repo_url) return NextResponse.json({ error: 'No repository configured' }, { status: 400 })

  const adminDb = createAdminClient()
  await adminDb.from('projects').update({ scan_status: 'scanning', scan_error: null }).eq('id', id)

  // Fire and forget — don't await so the 202 returns immediately
  runFullScan(id, adminDb).catch(err => console.error('[scan]', err))

  return NextResponse.json({ status: 'scanning' }, { status: 202 })
}
```

- [ ] **Step 2: Read `app/api/projects/route.ts` to find the current import block and POST handler**

Identify the exact lines for existing imports and the `return NextResponse.json(project, { status: 201 })` line.

- [ ] **Step 3: Add imports to `app/api/projects/route.ts`**

Add these two imports after the existing import block:

```typescript
import { createAdminClient } from '@/lib/supabase/admin'
import { runFullScan } from '@/lib/scanner/scanner'
```

- [ ] **Step 4: Replace the final `return` in the POST handler in `app/api/projects/route.ts`**

Find:

```typescript
  return NextResponse.json(project, { status: 201 })
```

Replace with:

```typescript
  // Auto-trigger scan if repo_url was provided
  if (project.repo_url) {
    const adminDb = createAdminClient()
    await adminDb.from('projects').update({ scan_status: 'scanning' }).eq('id', project.id)
    runFullScan(project.id, adminDb).catch(err => console.error('[scan] auto-trigger failed:', err))
  }

  return NextResponse.json(project, { status: 201 })
```

- [ ] **Step 5: TypeScript check**

```bash
npx tsc --noEmit 2>&1 | grep "error TS" | grep -v "tests/" | head -10
```

Expected: 0 errors outside `tests/`.

- [ ] **Step 6: Run all tests**

```bash
npm test 2>&1 | tail -10
```

Expected: all tests pass (no regressions).

- [ ] **Step 7: Commit**

```bash
git add app/api/projects/[id]/scan/route.ts app/api/projects/route.ts
git commit -m "feat(scanner): POST /api/projects/[id]/scan endpoint and auto-trigger on project creation"
```

---

### Task 10: System model browser UI

**Files:**
- Create: `app/projects/[id]/system-model/page.tsx`
- Create: `app/projects/[id]/system-model/system-model-browser.tsx`

A server-rendered page that fetches the system model from the DB and passes it to a client-side browser component with search, type filters, and expandable dependency panels.

- [ ] **Step 1: Create `app/projects/[id]/system-model/page.tsx`**

```tsx
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { SystemModelBrowser } from './system-model-browser'

export default async function SystemModelPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) redirect('/login')

  const { data: project } = await db
    .from('projects')
    .select('id, name, scan_status')
    .eq('id', id)
    .eq('owner_id', user.id)
    .single()

  if (!project) redirect('/projects')

  const { data: components } = await db
    .from('system_components')
    .select('id, name, type, status, is_anchored, scan_count, last_updated')
    .eq('project_id', id)
    .is('deleted_at', null)
    .order('name')

  // Count primary file assignments per component
  const { data: assignments } = await db
    .from('component_assignment')
    .select('component_id')
    .in('component_id', (components ?? []).map(c => c.id))
    .eq('is_primary', true)

  const fileCounts: Record<string, number> = {}
  for (const a of (assignments ?? [])) {
    fileCounts[a.component_id] = (fileCounts[a.component_id] ?? 0) + 1
  }

  // Fetch outgoing dependencies for all components
  const { data: dependencies } = await db
    .from('component_dependencies')
    .select('from_id, to_id')
    .in('from_id', (components ?? []).map(c => c.id))
    .is('deleted_at', null)

  return (
    <SystemModelBrowser
      project={project}
      components={(components ?? []).map(c => ({
        ...c,
        fileCount: fileCounts[c.id] ?? 0,
      }))}
      dependencies={dependencies ?? []}
    />
  )
}
```

- [ ] **Step 2: Create `app/projects/[id]/system-model/system-model-browser.tsx`**

```tsx
'use client'
import { useState, useMemo } from 'react'
import Link from 'next/link'
import { LeftNav } from '@/components/app/left-nav'
import { ProfileAvatar } from '@/components/app/profile-avatar'

interface Project { id: string; name: string; scan_status: string }
interface Component {
  id: string; name: string; type: string; status: string;
  is_anchored: boolean; scan_count: number; last_updated: string; fileCount: number;
}
interface Dependency { from_id: string; to_id: string }

const TYPE_COLORS: Record<string, string> = {
  api: 'text-indigo-400 bg-indigo-400/10',
  ui: 'text-blue-400 bg-blue-400/10',
  db: 'text-purple-400 bg-purple-400/10',
  service: 'text-amber-400 bg-amber-400/10',
  module: 'text-slate-400 bg-slate-400/10',
}

function Badge({ label, colorClass }: { label: string; colorClass: string }) {
  return (
    <span className={`text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded font-mono ${colorClass}`}>
      {label}
    </span>
  )
}

export function SystemModelBrowser({
  project, components, dependencies,
}: {
  project: Project; components: Component[]; dependencies: Dependency[]
}) {
  const [search, setSearch] = useState('')
  const [filterUnstable, setFilterUnstable] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)

  const depMap = useMemo(() => {
    const m: Record<string, string[]> = {}
    for (const d of dependencies) {
      if (!m[d.from_id]) m[d.from_id] = []
      m[d.from_id].push(d.to_id)
    }
    return m
  }, [dependencies])

  const componentById = useMemo(() => {
    const m: Record<string, Component> = {}
    for (const c of components) m[c.id] = c
    return m
  }, [components])

  const filtered = useMemo(() => {
    return components.filter(c => {
      if (filterUnstable && c.status !== 'unstable') return false
      if (search) {
        const q = search.toLowerCase()
        return c.name.toLowerCase().includes(q)
      }
      return true
    })
  }, [components, search, filterUnstable])

  // Group by type for rendering
  const grouped = useMemo(() => {
    const m = new Map<string, Component[]>()
    for (const c of filtered) {
      if (!m.has(c.type)) m.set(c.type, [])
      m.get(c.type)!.push(c)
    }
    return m
  }, [filtered])

  const typeOrder = ['api', 'ui', 'service', 'db', 'module']

  return (
    <div className="flex flex-col h-screen bg-[#0b1326] text-on-surface overflow-hidden">
      <header className="w-full h-16 flex-shrink-0 flex items-center justify-between px-6 bg-[#0b1326] border-b border-white/5 z-50 font-headline antialiased tracking-tight">
        <div className="flex items-center gap-2 text-sm">
          <Link href="/projects" className="font-black text-indigo-400 tracking-tighter hover:text-indigo-300 transition-colors">
            FactoryOS
          </Link>
          <span className="text-slate-600">/</span>
          <Link href={`/projects/${project.id}`} className="text-slate-400 hover:text-slate-200 transition-colors font-medium truncate max-w-[180px]">
            {project.name}
          </Link>
          <span className="text-slate-600">/</span>
          <span className="text-slate-200 font-medium">System Model</span>
        </div>
        <div className="flex items-center gap-1">
          <div className="w-px h-5 bg-white/10 mx-1" />
          <ProfileAvatar />
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        <LeftNav />
        <main className="flex-1 overflow-y-auto bg-[#0b1326] p-10">
          <div className="max-w-4xl mx-auto space-y-8">

            <div className="flex items-start justify-between">
              <div>
                <p className="text-xs uppercase tracking-widest font-bold text-indigo-400 font-headline mb-1">System Model</p>
                <h1 className="text-3xl font-extrabold font-headline tracking-tight text-on-surface">{project.name}</h1>
                <p className="text-sm text-slate-400 mt-1">{components.length} components detected</p>
              </div>
            </div>

            {/* Search + filters */}
            <div className="flex items-center gap-3 flex-wrap">
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search components…"
                className="rounded-lg px-3 py-2 text-sm outline-none w-64 transition-all"
                style={{
                  background: 'var(--bg-elevated)',
                  border: '1px solid var(--border-default)',
                  color: 'var(--text-primary)',
                }}
                onFocus={e => { e.currentTarget.style.borderColor = 'var(--border-accent)' }}
                onBlur={e => { e.currentTarget.style.borderColor = 'var(--border-default)' }}
              />
              <button
                onClick={() => setFilterUnstable(v => !v)}
                className={`text-xs px-3 py-1.5 rounded-full font-bold font-mono transition-all ${
                  filterUnstable ? 'bg-red-400/20 text-red-300' : 'bg-white/5 text-slate-400 hover:bg-white/10'
                }`}
              >
                Unstable only
              </button>
            </div>

            {/* Components grouped by type */}
            {typeOrder.map(type => {
              const group = grouped.get(type)
              if (!group?.length) return null
              return (
                <div key={type}>
                  <h2 className="text-xs font-bold uppercase tracking-widest text-slate-500 font-headline mb-3">{type}</h2>
                  <div className="space-y-1">
                    {group.map(c => (
                      <div key={c.id}>
                        <button
                          onClick={() => setExpanded(expanded === c.id ? null : c.id)}
                          className="w-full flex items-center gap-4 px-5 py-3 rounded-xl bg-[#131b2e] border border-white/5 hover:border-white/10 hover:bg-[#171f33] transition-all text-left"
                        >
                          <div className="flex-1 min-w-0">
                            <span className="text-sm font-semibold text-on-surface font-mono truncate">{c.name}</span>
                          </div>
                          <div className="flex items-center gap-2 flex-shrink-0">
                            <Badge label={c.type} colorClass={TYPE_COLORS[c.type] ?? 'text-slate-400 bg-slate-400/10'} />
                            {c.status === 'unstable' && <Badge label="unstable" colorClass="text-red-400 bg-red-400/10" />}
                            {c.is_anchored && <Badge label="anchored" colorClass="text-green-400 bg-green-400/10" />}
                            <span className="text-xs text-slate-500 font-mono">{c.fileCount} files</span>
                            <span
                              className="material-symbols-outlined text-slate-600 transition-transform"
                              style={{ fontSize: '16px', transform: expanded === c.id ? 'rotate(90deg)' : undefined }}
                            >
                              chevron_right
                            </span>
                          </div>
                        </button>

                        {expanded === c.id && (
                          <div className="mt-1 ml-4 rounded-xl p-4 bg-[#0f1929] border border-white/5 space-y-3">
                            {depMap[c.id]?.length ? (
                              <div>
                                <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500 font-headline mb-1.5">
                                  Depends on
                                </p>
                                <div className="flex flex-wrap gap-1.5">
                                  {depMap[c.id].map(toId => (
                                    <span
                                      key={toId}
                                      className="text-xs font-mono text-indigo-300 bg-indigo-400/10 px-2 py-0.5 rounded"
                                    >
                                      {componentById[toId]?.name ?? toId}
                                    </span>
                                  ))}
                                </div>
                              </div>
                            ) : (
                              <p className="text-xs text-slate-600">No outgoing dependencies detected.</p>
                            )}
                            <div>
                              <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500 font-headline mb-1">
                                Last scanned
                              </p>
                              <p className="text-xs text-slate-500 font-mono">{new Date(c.last_updated).toLocaleString()}</p>
                            </div>
                            <div>
                              <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500 font-headline mb-1">
                                Scan count
                              </p>
                              <p className="text-xs text-slate-500 font-mono">{c.scan_count}</p>
                            </div>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )
            })}

            {filtered.length === 0 && (
              <div className="rounded-xl p-12 text-center bg-[#131b2e] border border-white/5">
                <span className="material-symbols-outlined text-slate-600 mb-3 block" style={{ fontSize: '32px' }}>schema</span>
                <p className="text-sm text-slate-500">
                  {components.length === 0
                    ? 'No system model yet. Trigger a scan from the project dashboard.'
                    : 'No components match your filters.'}
                </p>
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: TypeScript check**

```bash
npx tsc --noEmit 2>&1 | grep "error TS" | grep -v "tests/" | head -10
```

Expected: 0 errors outside `tests/`.

- [ ] **Step 4: Run all tests**

```bash
npm test 2>&1 | tail -10
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add app/projects/[id]/system-model/page.tsx app/projects/[id]/system-model/system-model-browser.tsx
git commit -m "feat(scanner): system model browser UI with search, filter, and dependency expand"
```
