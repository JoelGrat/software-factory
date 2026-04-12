const ALLOWED_PREFIXES = [
  'app/',
  'components/',
  'lib/',
  'tests/',
  'styles/',
]

const ALLOWED_ROOT_FILES = [
  'tsconfig.json',
  'tailwind.config.js',
  'tailwind.config.ts',
  'tailwind.config.mjs',
  'next.config.js',
  'next.config.ts',
  'next.config.mjs',
]

const BLOCKED_PATTERNS: RegExp[] = [
  /^\.env(\..*)?$/,            // .env, .env.local, .env.production, etc.
  /^supabase\/migrations\//,   // migrations are append-only
  /^package(-lock)?\.json$/,   // no dep installs
  /\.(pem|key|secret)$/,       // secrets
]

export function isPathAllowed(path: string): boolean {
  // Check hard deny first
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(path)) return false
  }

  // Check allowed prefixes
  for (const prefix of ALLOWED_PREFIXES) {
    if (path.startsWith(prefix)) return true
  }

  // Check allowed root files
  if (ALLOWED_ROOT_FILES.includes(path)) return true

  return false
}

export function filterPathsToAllowed(paths: string[]): string[] {
  return paths.filter(isPathAllowed)
}
