import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import Anthropic from '@anthropic-ai/sdk'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: project } = await db
    .from('projects')
    .select('id')
    .eq('id', id)
    .eq('owner_id', user.id)
    .single()
  if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const body = await req.json()
  const { text } = body
  if (!text?.trim() || text.trim().split(/\s+/).length < 3) {
    return NextResponse.json({ error: 'Not enough text to improve' }, { status: 400 })
  }

  const message = await anthropic.messages.create({
    model: process.env.CLAUDE_MODEL ?? 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    temperature: 0.3,
    system: `You are a senior product manager helping a developer articulate their project vision.
Improve the provided project description for clarity, completeness, and structure.
Keep the developer's intent and tone. Add specificity where it's vague.
If tech stack, users, or goals are implied but not stated, make them explicit.
Return only the improved description text — no preamble, no labels.`,
    messages: [{ role: 'user', content: `Improve this project description:\n\n${text.trim()}` }],
  })

  const improved = message.content[0].type === 'text' ? message.content[0].text.trim() : ''
  if (!improved) return NextResponse.json({ error: 'No response from AI' }, { status: 500 })

  return NextResponse.json({ text: improved })
}
