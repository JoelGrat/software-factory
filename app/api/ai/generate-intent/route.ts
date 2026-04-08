import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getProvider } from '@/lib/ai/registry'

export async function POST(req: Request) {
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { title, intent, type } = await req.json()
  if (!title?.trim()) return NextResponse.json({ error: 'Title is required' }, { status: 400 })

  const ai = getProvider()

  const prompt = intent?.trim()
    ? `You are a software change request assistant. A developer has written the following intent for a "${type ?? 'feature'}" change request titled "${title}".

Current intent:
${intent}

Improve this intent to be clearer, more specific, and actionable. Explain what needs to change and why. Keep it concise (2–5 sentences). Return only the improved intent text, no preamble.`
    : `You are a software change request assistant. Generate a clear, specific intent for a "${type ?? 'feature'}" change request titled: "${title}".

Describe what likely needs to change and why, in 2–5 sentences. Be concrete and actionable. Return only the intent text, no preamble.`

  const result = await ai.complete(prompt, { maxTokens: 300, temperature: 0.4 })

  return NextResponse.json({ intent: result.content.trim() })
}
