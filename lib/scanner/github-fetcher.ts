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
