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
