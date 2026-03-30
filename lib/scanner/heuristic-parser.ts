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
