import type { SupabaseClient } from '@supabase/supabase-js'
import { GithubFileFetcher } from './github-fetcher'
import { buildAliasMap } from './alias-resolver'
import { TypeScriptParser } from './typescript-parser'
import { HeuristicParser } from './heuristic-parser'
import { isComponentUnstable } from './scan-helpers'
import type { ParsedComponent } from './types'

export interface ScanMilestone {
  id: string
  label: string
  status: 'done' | 'active' | 'pending'
  detail?: string
}

export interface ScanProgress {
  stage: 'fetching' | 'parsing' | 'building' | 'finalizing' | 'complete' | 'failed'
  parserType: 'typescript' | 'heuristic' | null
  milestones: ScanMilestone[]
  warnings: string[]
  fileCount?: number
  componentCount?: number
}

async function writeProgress(db: SupabaseClient, projectId: string, progress: ScanProgress) {
  await db.from('projects').update({ scan_progress: progress as any }).eq('id', projectId)
}

const BASE_MILESTONES: ScanMilestone[] = [
  { id: 'fetch',    label: 'Fetch repository file tree', status: 'pending' },
  { id: 'parse',    label: 'Parse components',           status: 'pending' },
  { id: 'build',    label: 'Build dependency graph',     status: 'pending' },
  { id: 'finalize', label: 'Finalize system model',      status: 'pending' },
]

function milestones(doneUpTo: string, active: string, detail?: Record<string, string>): ScanMilestone[] {
  const order = ['fetch', 'parse', 'build', 'finalize']
  const doneIdx = order.indexOf(doneUpTo)
  const activeIdx = order.indexOf(active)
  return BASE_MILESTONES.map((m, i) => ({
    ...m,
    status: i <= doneIdx ? 'done' : i === activeIdx ? 'active' : 'pending',
    detail: detail?.[m.id] ?? m.detail,
  }))
}

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

  // 2. Mark scanning + initial progress
  await db
    .from('projects')
    .update({
      scan_status: 'scanning',
      scan_error: null,
      scan_progress: {
        stage: 'fetching',
        parserType: null,
        milestones: milestones('', 'fetch'),
        warnings: [],
      } satisfies ScanProgress,
    })
    .eq('id', projectId)

  try {
    // 3. Fetch file tree
    const fetcher = new GithubFileFetcher(project.repo_url, project.repo_token ?? undefined)
    const files = await fetcher.getFileTree()

    // 4. Build alias map from tsconfig.json if present
    let aliasMap: Record<string, string> = {}
    const hasTsconfig = files.includes('tsconfig.json')
    console.log('[scan] tsconfig.json in files:', hasTsconfig, '| files sample:', files.slice(0, 5))
    if (hasTsconfig) {
      try {
        const content = await fetcher.getContent('tsconfig.json')
        aliasMap = buildAliasMap(content)
        console.log('[scan] buildAliasMap result:', JSON.stringify(aliasMap), '| tsconfig snippet:', content.slice(0, 200))
      } catch (e) {
        console.log('[scan] buildAliasMap error:', e)
      }
    }

    // 5. Select parser
    const tsParser = new TypeScriptParser()
    const heuristicParser = new HeuristicParser()
    const useTS = tsParser.canParse(files)
    const parser = useTS ? tsParser : heuristicParser
    const parserType: ScanProgress['parserType'] = useTS ? 'typescript' : 'heuristic'
    const warnings: string[] = []
    if (!useTS) warnings.push('Heuristic parser used — dependency graph may be incomplete')

    await writeProgress(db, projectId, {
      stage: 'parsing',
      parserType,
      fileCount: files.length,
      milestones: milestones('fetch', 'parse', {
        fetch: `${files.length.toLocaleString()} files`,
        parse: useTS ? 'TypeScript detected' : 'Heuristic parser',
      }),
      warnings,
    })

    // 6. Parse into components
    const components: ParsedComponent[] = await parser.parse(files, fetcher, aliasMap)

    // Debug: log alias map and dependency summary
    console.log('[scan] aliasMap:', JSON.stringify(aliasMap))
    console.log('[scan] components with dependsOn:', components.filter(c => c.dependsOn.length > 0).map(c => `${c.name} → [${c.dependsOn.join(', ')}]`))

    // Check for dynamic imports warning
    const hasDynamicImports = components.some(c => c.edges?.some(e =>
      e.edgeType === 'dynamic-template' || e.edgeType === 'dynamic-computed'
    ))
    if (hasDynamicImports) warnings.push('Dynamic imports detected — dependency graph may be incomplete')

    await writeProgress(db, projectId, {
      stage: 'building',
      parserType,
      fileCount: files.length,
      componentCount: components.length,
      milestones: milestones('parse', 'build', {
        fetch: `${files.length.toLocaleString()} files`,
        parse: `${components.length} components`,
      }),
      warnings,
    })

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
      .select('id, name, scan_count, status')
      .eq('project_id', projectId)
      .is('deleted_at', null)
      .order('name' as any)
    const existingMap = new Map<string, { id: string; scan_count: number; status: string }>()
    for (const c of (existingComponents ?? [])) existingMap.set(c.name, c)

    // 9. Upsert system_components
    const now = new Date().toISOString()
    const componentRows = components.map(c => {
      const existing = existingMap.get(c.name)
      const newScanCount = (existing?.scan_count ?? 0) + 1
      const unstable = isComponentUnstable(0, c.confidence)
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

    // 10. Write component_assignment (delete-then-insert to work around partial unique index)
    const allFileIds = [...fileIdMap.values()]
    if (allFileIds.length > 0) {
      await db.from('component_assignment').delete().in('file_id', allFileIds)
    }
    const assignmentRows = components.flatMap(comp => {
      const componentId = componentIdMap.get(comp.name)
      if (!componentId) return []
      return comp.files
        .map(file => fileIdMap.get(file))
        .filter((fileId): fileId is string => !!fileId)
        .map(fileId => ({
          file_id: fileId,
          component_id: componentId,
          confidence: comp.confidence,
          is_primary: true,
          status: 'assigned',
          reassignment_count: 0,
          last_validated_at: now,
          last_moved_at: now,
        }))
    })
    if (assignmentRows.length > 0) {
      await db.from('component_assignment').insert(assignmentRows)
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

    // 12. Insert component_dependencies (component-to-component)
    // Delete existing deps for these components first, then insert fresh
    const allComponentIds = [...componentIdMap.values()]
    if (allComponentIds.length > 0) {
      await db.from('component_dependencies').delete().in('from_id', allComponentIds)
    }
    const depRows = components.flatMap(comp => {
      const fromId = componentIdMap.get(comp.name)
      if (!fromId) return []
      return comp.dependsOn
        .map(depName => componentIdMap.get(depName))
        .filter((id): id is string => !!id)
        .map(toId => ({ from_id: fromId, to_id: toId, type: 'sync' as const, deleted_at: null }))
    })
    if (depRows.length > 0) {
      const { error: depError } = await db.from('component_dependencies').insert(depRows)
      if (depError) throw new Error(`Failed to write component dependencies: ${depError.message}`)
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
      .update({
        scan_status: 'ready',
        scan_error: null,
        scan_progress: {
          stage: 'complete',
          parserType,
          fileCount: files.length,
          componentCount: components.length,
          milestones: milestones('finalize', 'finalize', {
            fetch: `${files.length.toLocaleString()} files`,
            parse: `${components.length} components`,
            build: `${edgeRows.length} file edges, ${depRows.length} component deps`,
            finalize: 'System model ready',
          }),
          warnings,
        } satisfies ScanProgress,
      })
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
