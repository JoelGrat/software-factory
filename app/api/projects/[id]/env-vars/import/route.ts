// app/api/projects/[id]/env-vars/import/route.ts
import { NextResponse } from 'next/server'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createClient } from '@/lib/supabase/server'

type Params = { params: Promise<{ id: string }> }

/**
 * POST — reads the host .env.local file and returns parsed key/value pairs.
 * Does NOT store anything. The client reviews and saves explicitly.
 */
export async function POST(_req: Request, { params }: Params) {
  const { id } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: project } = await db.from('projects').select('id').eq('id', id).eq('owner_id', user.id).single()
  if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const envPath = join(process.cwd(), '.env.local')
  let content: string
  try {
    content = await readFile(envPath, 'utf8')
  } catch {
    return NextResponse.json({ error: '.env.local not found' }, { status: 404 })
  }

  const pairs: { key: string; value: string }[] = []
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx < 1) continue
    const key = trimmed.slice(0, eqIdx).trim()
    const value = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '')
    pairs.push({ key, value })
  }

  return NextResponse.json({ pairs })
}
