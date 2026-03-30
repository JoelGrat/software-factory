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
    let aliasMap: Record<string, string> = {}
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
      .order('name' as any)
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
