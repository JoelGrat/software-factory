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
