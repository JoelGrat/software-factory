import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import Anthropic from '@anthropic-ai/sdk'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })

const SYSTEM_PROMPT = `You are a senior software requirements analyst. Write clear, precise, and actionable requirement descriptions.
- Keep descriptions to 1-2 sentences
- Be specific and measurable where possible
- Use active voice
- No markdown, no bullet points — plain text only`

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Verify ownership
  const { data: requirement } = await db
    .from('requirements')
    .select('project_id')
    .eq('id', id)
    .single()
  if (!requirement) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const { data: project } = await db
    .from('projects')
    .select('id')
    .eq('id', requirement.project_id)
    .eq('owner_id', user.id)
    .single()
  if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const body = await req.json()
  const { type, title, description } = body

  if (!title?.trim()) return NextResponse.json({ error: 'title is required' }, { status: 400 })

  const hasDescription = description?.trim().length > 0
  const userPrompt = hasDescription
    ? `Improve this ${type} requirement description for clarity and completeness.\n\nTitle: "${title}"\nCurrent description: "${description.trim()}"\n\nReturn only the improved description text.`
    : `Write a clear, concise description for this ${type} requirement.\n\nTitle: "${title}"\n\nReturn only the description text.`

  const message = await anthropic.messages.create({
    model: process.env.CLAUDE_MODEL ?? 'claude-haiku-4-5-20251001',
    max_tokens: 256,
    temperature: 0.3,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
  })

  const text = message.content[0].type === 'text' ? message.content[0].text.trim() : ''
  if (!text) return NextResponse.json({ error: 'No response from AI' }, { status: 500 })

  return NextResponse.json({ description: text })
}
