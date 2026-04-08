import { describe, it, expect, vi, beforeEach } from 'vitest'
import { runFullScan } from '@/lib/scanner/scanner'

// Mock the fetcher
const mockFileTree = ['tsconfig.json', 'lib/auth/token.ts', 'app/api/projects/route.ts']
const mockContent: Record<string, string> = {
  'tsconfig.json': JSON.stringify({ compilerOptions: { paths: { '@/*': ['./src/*'] } } }),
  'lib/auth/token.ts': `export function getToken() {}`,
  'app/api/projects/route.ts': `export async function GET(req: Request) {}`,
}

vi.mock('@/lib/scanner/github-fetcher', () => ({
  GithubFileFetcher: vi.fn().mockImplementation(function() {
    return {
      getFileTree: async () => mockFileTree,
      getContent: async (path: string) => mockContent[path] ?? '',
    }
  }),
}))

function makeDb(project = { id: 'proj-1', repo_url: 'https://github.com/owner/repo', repo_token: null }) {
  const calls: Array<{ table: string; op: string; data?: unknown }> = []
  const db = {
    from: (table: string) => ({
      select: () => ({
        eq: (col: string, val: unknown) => ({
          single: async () => ({ data: project, error: null }),
          is: () => ({ order: () => ({ data: [], error: null }) }),
        }),
      }),
      update: (data: unknown) => {
        calls.push({ table, op: 'update', data })
        return { eq: () => ({ error: null }) }
      },
      upsert: (data: unknown) => {
        calls.push({ table, op: 'upsert', data })
        return {
          select: () => ({
            data: Array.isArray(data)
              ? data.map((d: any, i: number) => ({ ...d, id: `id-${i}` }))
              : [{ ...(data as object), id: 'id-0' }],
            error: null,
          }),
        }
      },
      insert: (data: unknown) => {
        calls.push({ table, op: 'insert', data })
        return { error: null }
      },
      delete: () => ({
        in: () => ({ error: null }),
      }),
      in: () => ({ eq: () => ({ data: [], error: null }) }),
      is: () => ({ order: () => ({ data: [], error: null }) }),
    }),
    _calls: calls,
  }
  return db
}

describe('runFullScan', () => {
  it('sets scan_status to scanning then ready on success', async () => {
    const db = makeDb()
    await runFullScan('proj-1', db as any)
    const updates = db._calls.filter(c => c.table === 'projects' && c.op === 'update')
    const statuses = updates.map((u: any) => (u.data as any).scan_status)
    expect(statuses).toContain('scanning')
    expect(statuses).toContain('ready')
  })

  it('upserts files from file tree', async () => {
    const db = makeDb()
    await runFullScan('proj-1', db as any)
    const fileUpserts = db._calls.filter(c => c.table === 'files' && c.op === 'upsert')
    expect(fileUpserts.length).toBeGreaterThan(0)
  })

  it('upserts system_components', async () => {
    const db = makeDb()
    await runFullScan('proj-1', db as any)
    const compUpserts = db._calls.filter(c => c.table === 'system_components' && c.op === 'upsert')
    expect(compUpserts.length).toBeGreaterThan(0)
  })

  it('sets scan_status to failed with error message when fetch fails', async () => {
    const { GithubFileFetcher } = await import('@/lib/scanner/github-fetcher')
    vi.mocked(GithubFileFetcher).mockImplementationOnce(function() {
      return {
        getFileTree: async () => { throw new Error('Network error') },
        getContent: async () => '',
      }
    })
    const db = makeDb()
    await runFullScan('proj-1', db as any)
    const failUpdate = db._calls.find(
      (c: any) => c.table === 'projects' && (c.data as any)?.scan_status === 'failed'
    )
    expect(failUpdate).toBeDefined()
    expect((failUpdate?.data as any)?.scan_error).toBe('Network error')
  })
})
