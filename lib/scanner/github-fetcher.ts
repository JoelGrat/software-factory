import { unzipSync } from 'fflate'

export function parseRepoUrl(url: string): { owner: string; repo: string } {
  const match = url.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/)
  if (!match) throw new Error(`Cannot parse GitHub URL: ${url}`)
  return { owner: match[1], repo: match[2] }
}

export class GithubFileFetcher {
  private owner: string
  private repo: string
  private token?: string

  // Populated after first getFileTree() call
  private fileContents: Map<string, string> | null = null

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

  // Download and unzip the whole repo in one request.
  // Uses the direct archive URL (not the API endpoint) to avoid rate limits.
  // Subsequent getContent() calls are served from memory.
  async getFileTree(): Promise<string[]> {
    // Direct archive download — does NOT count against GitHub API rate limits
    const url = `https://github.com/${this.owner}/${this.repo}/archive/HEAD.zip`
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 120_000) // 2 min timeout
    let res: Response
    try {
      res = await fetch(url, { headers: this.headers, signal: controller.signal })
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error('Timed out downloading repository archive — the repo may be too large or GitHub is slow. Try again.')
      }
      throw err
    } finally {
      clearTimeout(timeout)
    }

    if (res.status === 404) {
      throw new Error('Repository not found or not accessible. Check the URL and token.')
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error('Repository access denied. Add a GitHub Personal Access Token for private repos.')
    }
    if (!res.ok) {
      throw new Error(`Failed to download repository archive: ${res.status} ${res.statusText}`)
    }

    const buffer = await res.arrayBuffer()
    const zip = unzipSync(new Uint8Array(buffer))

    // GitHub zips all files under a top-level directory like "owner-repo-abc123/"
    // Strip that prefix so paths match what the repo looks like
    this.fileContents = new Map()
    const entries = Object.entries(zip)
    const prefix = entries[0]?.[0].split('/')[0] + '/'

    for (const [zipPath, bytes] of entries) {
      const normalised = zipPath.startsWith(prefix) ? zipPath.slice(prefix.length) : zipPath
      if (!normalised || normalised.endsWith('/')) continue  // skip directories
      try {
        this.fileContents.set(normalised, new TextDecoder().decode(bytes))
      } catch {
        // Binary file — skip, we only need text
      }
    }

    return [...this.fileContents.keys()]
  }

  async getContent(path: string): Promise<string> {
    if (this.fileContents) {
      const content = this.fileContents.get(path)
      if (content !== undefined) return content
      throw new Error(`File not found in zip: ${path}`)
    }

    // Fallback: individual file fetch (used in tests or if getFileTree not called first)
    const res = await fetch(
      `https://api.github.com/repos/${this.owner}/${this.repo}/contents/${path}`,
      { headers: this.headers }
    )
    if (!res.ok) throw new Error(`GitHub API error fetching ${path}: ${res.status} ${res.statusText}`)
    const data = await res.json()
    return Buffer.from(data.content as string, 'base64').toString('utf-8')
  }
}
