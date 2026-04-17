/** Given a list of filenames in the repo root, return the best install command. */
export function detectInstallCommand(files: string[]): string {
  const set = new Set(files)
  if (set.has('pnpm-lock.yaml')) return 'pnpm install --frozen-lockfile'
  if (set.has('yarn.lock'))      return 'yarn install --frozen-lockfile'
  if (set.has('bun.lockb'))      return 'bun install'
  if (set.has('package-lock.json')) return 'npm ci'
  return 'npm install'
}

/** Given package.json scripts object, return the best start command. */
export function detectStartCommand(scripts: Record<string, string>): string {
  if (scripts.preview) return 'npm run preview'
  if (scripts.start)   return 'npm run start'
  return 'npm run dev'
}
