import type { ComponentType } from '@/lib/supabase/types'
import type { RawEdge, FileFetcher, AliasMap, ParsedComponent, LanguageParser } from './types'
import { Project, Node, SyntaxKind } from 'ts-morph'

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

    // Build file→component reverse map, then resolve cross-component dependencies
    const fileToComponent = new Map<string, string>()
    for (const comp of components) {
      for (const file of comp.files) {
        fileToComponent.set(file, comp.name)
      }
    }

    // resolveSpecifier inline (mirrors scanner.ts logic, no external dep)
    const resolveEdgeTarget = (specifier: string, fromPath: string): string | null => {
      if (specifier.startsWith('.')) {
        const fromDir = fromPath.split('/').slice(0, -1).join('/')
        const joined = fromDir ? `${fromDir}/${specifier}` : specifier
        const parts = joined.split('/')
        const normalized: string[] = []
        for (const p of parts) {
          if (p === '..') normalized.pop()
          else if (p !== '.') normalized.push(p)
        }
        const base = normalized.join('/')
        const candidates = ['', '.ts', '.tsx', '/index.ts', '/index.tsx', '.js', '.jsx', '/index.js']
        for (const ext of candidates) {
          const candidate = base + ext
          if (fileToComponent.has(candidate)) return candidate
        }
      }
      return null
    }

    for (const comp of components) {
      const depNames = new Set<string>()
      for (const edge of comp.edges) {
        const resolved = resolveEdgeTarget(edge.toSpecifier, edge.fromPath)
        if (!resolved) continue
        const targetComp = fileToComponent.get(resolved)
        if (targetComp && targetComp !== comp.name) {
          depNames.add(targetComp)
        }
      }
      comp.dependsOn = [...depNames]
    }

    return components
  }
}
