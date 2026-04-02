// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { zipSync, strToU8 } from 'fflate'
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

function makeZip(files: Record<string, string>): ArrayBuffer {
  const entries: Record<string, Uint8Array> = {}
  for (const [path, content] of Object.entries(files)) {
    entries[`owner-repo-abc123/${path}`] = strToU8(content)
  }
  const zipped = zipSync(entries)
  return zipped.buffer.slice(zipped.byteOffset, zipped.byteOffset + zipped.byteLength) as ArrayBuffer
}

function mockFetchZip(files: Record<string, string>, status = 200) {
  const zip = makeZip(files)
  vi.mocked(fetch).mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : status === 403 ? 'Forbidden' : 'Error',
    arrayBuffer: async () => zip,
    text: async () => 'rate limit exceeded',
  } as Response)
}

describe('GithubFileFetcher', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('getFileTree returns all file paths from zip', async () => {
    mockFetchZip({ 'src/index.ts': 'export {}', 'README.md': '# hi' })
    const fetcher = new GithubFileFetcher('https://github.com/owner/repo')
    const files = await fetcher.getFileTree()
    expect(files).toContain('src/index.ts')
    expect(files).toContain('README.md')
  })

  it('getFileTree strips the top-level zip prefix', async () => {
    mockFetchZip({ 'lib/foo.ts': 'export {}' })
    const fetcher = new GithubFileFetcher('https://github.com/owner/repo')
    const files = await fetcher.getFileTree()
    expect(files).toContain('lib/foo.ts')
    expect(files.some(f => f.includes('owner-repo'))).toBe(false)
  })

  it('getFileTree sends Authorization header when token provided', async () => {
    mockFetchZip({ 'index.ts': '' })
    const fetcher = new GithubFileFetcher('https://github.com/owner/repo', 'ghp_token')
    await fetcher.getFileTree()
    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/repos/owner/repo/zipball')
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer ghp_token')
  })

  it('getContent returns file from in-memory zip after getFileTree', async () => {
    mockFetchZip({ 'src/foo.ts': 'export const foo = 1' })
    const fetcher = new GithubFileFetcher('https://github.com/owner/repo')
    await fetcher.getFileTree()
    const content = await fetcher.getContent('src/foo.ts')
    expect(content).toBe('export const foo = 1')
  })

  it('getFileTree throws with helpful message on 403', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false, status: 403, statusText: 'Forbidden',
      arrayBuffer: async () => new ArrayBuffer(0),
      text: async () => 'rate limit exceeded',
    } as Response)
    const fetcher = new GithubFileFetcher('https://github.com/owner/repo')
    await expect(fetcher.getFileTree()).rejects.toThrow('rate limit')
  })

  it('getFileTree throws on 404', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false, status: 404, statusText: 'Not Found',
      arrayBuffer: async () => new ArrayBuffer(0),
      text: async () => '',
    } as Response)
    const fetcher = new GithubFileFetcher('https://github.com/owner/repo')
    await expect(fetcher.getFileTree()).rejects.toThrow('404')
  })
})
