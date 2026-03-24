import type { SupabaseClient } from '@supabase/supabase-js'
import type { AIProvider } from '@/lib/ai/provider'
import { parseRequirements } from '@/lib/requirements/parser'
import { detectGaps } from '@/lib/requirements/gap-detector'
import { generateQuestions } from '@/lib/requirements/question-generator'
import { createTasks } from '@/lib/requirements/task-creator'
import { computeScore } from '@/lib/requirements/scorer'
import { computeStatusFromScore } from '@/lib/requirements/re-evaluator'

export interface PipelineResult {
  success: boolean
  steps: {
    parse: 'ok' | 'error' | 'skipped'
    gaps: 'ok' | 'error' | 'skipped'
    questions: 'ok' | 'error' | 'skipped'
    tasks: 'ok' | 'error' | 'skipped'
    score: 'ok' | 'error' | 'skipped'
  }
  error?: string
}

async function writeAudit(
  db: SupabaseClient,
  entityType: string,
  entityId: string,
  action: string,
  actorId: string | null,
  diff: Record<string, unknown>
) {
  try {
    await db.from('audit_log').insert({ entity_type: entityType, entity_id: entityId, action, actor_id: actorId, diff })
  } catch {
    // audit failures must never abort the pipeline
  }
}

export async function runPipeline(
  requirementId: string,
  rawInput: string,
  actorId: string | null,
  db: SupabaseClient,
  ai: AIProvider
): Promise<PipelineResult> {
  const steps: PipelineResult['steps'] = {
    parse: 'error', gaps: 'skipped', questions: 'skipped', tasks: 'skipped', score: 'skipped',
  }

  await db.from('requirements').update({ status: 'analyzing', updated_at: new Date().toISOString() }).eq('id', requirementId)
  await writeAudit(db, 'requirements', requirementId, 'updated', actorId, { status: 'analyzing' })

  // Step 1: Parse
  let parsedItems
  try {
    parsedItems = await parseRequirements(rawInput, ai)
    await db.from('requirement_items').delete().eq('requirement_id', requirementId)
    if (parsedItems.length > 0) {
      await db.from('requirement_items').insert(
        parsedItems.map(item => ({ ...item, requirement_id: requirementId }))
      )
    }
    await writeAudit(db, 'requirements', requirementId, 'analyzed', actorId, { step: 'parse', item_count: parsedItems.length })
    steps.parse = 'ok'
  } catch (err) {
    await writeAudit(db, 'requirements', requirementId, 'updated', actorId, { step: 'parse', error: String(err) })
    await db.from('requirements').update({ status: 'draft', updated_at: new Date().toISOString() }).eq('id', requirementId)
    return { success: false, steps, error: `Parse failed: ${String(err)}` }
  }

  // Step 2–3: Detect gaps
  let allGaps: Awaited<ReturnType<typeof detectGaps>>['gaps'] = []
  let mergedPairs: Awaited<ReturnType<typeof detectGaps>>['mergedPairs'] = []
  let insertedGapIds: string[] = []

  try {
    const detection = await detectGaps(parsedItems, ai)
    allGaps = detection.gaps
    mergedPairs = detection.mergedPairs

    await db.from('gaps').delete().eq('requirement_id', requirementId)

    if (allGaps.length > 0) {
      const { data: inserted } = await db.from('gaps').insert(
        allGaps.map(g => ({
          requirement_id: requirementId,
          item_id: g.item_id,
          severity: g.severity,
          category: g.category,
          description: g.description,
          source: g.source,
          rule_id: g.rule_id,
          priority_score: g.priority_score,
          confidence: g.confidence,
          question_generated: false,
          merged_into: null,
        }))
      ).select('id')

      insertedGapIds = (inserted ?? []).map((g: { id: string }) => g.id)

      // Resolve merged_into with real UUIDs now that we have them
      for (const { survivorIndex, mergedIndex } of mergedPairs) {
        const survivorId = insertedGapIds[survivorIndex]
        const mergedId = insertedGapIds[mergedIndex]
        if (survivorId && mergedId) {
          await db.from('gaps').update({ merged_into: survivorId }).eq('id', mergedId)
        }
      }
    }

    await writeAudit(db, 'requirements', requirementId, 'analyzed', actorId, { step: 'gaps', gap_count: allGaps.length })
    steps.gaps = 'ok'
  } catch (err) {
    await writeAudit(db, 'requirements', requirementId, 'updated', actorId, { step: 'gaps', error: String(err) })
    steps.gaps = 'error'
  }

  const mergedIndices = new Set(mergedPairs.map(p => p.mergedIndex))

  // Step 4: Questions (top 10)
  try {
    const questions = await generateQuestions(allGaps, mergedIndices, parsedItems, ai)
    if (questions.length > 0 && insertedGapIds.length > 0) {
      await db.from('questions').insert(
        questions.map(q => ({
          gap_id: insertedGapIds[q.gap_index],
          requirement_id: requirementId,
          question_text: q.question_text,
          target_role: q.target_role,
          status: 'open',
        }))
      )
      const questionGapIds = questions.map(q => insertedGapIds[q.gap_index]).filter(Boolean)
      if (questionGapIds.length > 0) {
        await db.from('gaps').update({ question_generated: true }).in('id', questionGapIds)
      }
    }
    await writeAudit(db, 'requirements', requirementId, 'analyzed', actorId, { step: 'questions', count: questions.length })
    steps.questions = 'ok'
  } catch (err) {
    await writeAudit(db, 'requirements', requirementId, 'updated', actorId, { step: 'questions', error: String(err) })
    steps.questions = 'error'
  }

  // Step 5: Tasks
  try {
    const tasks = createTasks(allGaps, mergedIndices)
    await db.from('investigation_tasks').delete().eq('requirement_id', requirementId)
    if (tasks.length > 0 && insertedGapIds.length > 0) {
      await db.from('investigation_tasks').insert(
        tasks.map(t => ({
          requirement_id: requirementId,
          linked_gap_id: insertedGapIds[t.gap_index] ?? null,
          title: t.title,
          description: t.description,
          priority: t.priority,
          status: 'open',
        }))
      )
    }
    await writeAudit(db, 'requirements', requirementId, 'analyzed', actorId, { step: 'tasks', count: tasks.length })
    steps.tasks = 'ok'
  } catch (err) {
    await writeAudit(db, 'requirements', requirementId, 'updated', actorId, { step: 'tasks', error: String(err) })
    steps.tasks = 'error'
  }

  // Step 6: Score
  try {
    const score = computeScore(allGaps, mergedIndices, parsedItems)
    await db.from('completeness_scores').insert({
      requirement_id: requirementId,
      overall_score: score.overall_score,
      completeness: score.completeness,
      nfr_score: score.nfr_score,
      confidence: score.confidence,
      breakdown: score.breakdown,
      scored_at: new Date().toISOString(),
    })

    const { data: freshGaps } = await db.from('gaps').select('*').eq('requirement_id', requirementId)
    const newStatus = computeStatusFromScore(freshGaps ?? [])
    await db.from('requirements').update({ status: newStatus, updated_at: new Date().toISOString() }).eq('id', requirementId)
    await writeAudit(db, 'requirements', requirementId, 'scored', actorId, { score: score.overall_score, status: newStatus })
    steps.score = 'ok'
  } catch (err) {
    await writeAudit(db, 'requirements', requirementId, 'updated', actorId, { step: 'score', error: String(err) })
    steps.score = 'error'
    await db.from('requirements').update({ status: 'draft', updated_at: new Date().toISOString() }).eq('id', requirementId)
    return { success: false, steps, error: `Score failed: ${String(err)}` }
  }

  return { success: true, steps }
}
