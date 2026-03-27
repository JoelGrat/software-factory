import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getProvider } from '@/lib/ai/registry'
import { buildGenerateQuestionPrompt, GENERATE_QUESTION_SCHEMA } from '@/lib/ai/prompts/generate-question'
import type { TargetRole } from '@/lib/supabase/types'

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: gap } = await db.from('gaps').select('*').eq('id', id).single()
  if (!gap) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  if (gap.question_generated) {
    return NextResponse.json({ error: 'Question already generated for this gap' }, { status: 409 })
  }

  const ai = getProvider()
  const prompt = buildGenerateQuestionPrompt(gap.description, gap.category, null)
  const result = await ai.complete(prompt, { responseSchema: GENERATE_QUESTION_SCHEMA })
  const parsed = JSON.parse(result.content) as { question_text: string; target_role: TargetRole }

  const { data: question, error } = await db
    .from('questions')
    .insert({
      gap_id: id,
      requirement_id: gap.requirement_id,
      question_text: parsed.question_text,
      target_role: parsed.target_role,
      status: 'open',
    })
    .select('*')
    .single()

  if (error) return NextResponse.json({ error: 'Failed to save question' }, { status: 500 })

  await db.from('gaps').update({ question_generated: true }).eq('id', id)

  return NextResponse.json(question, { status: 201 })
}
