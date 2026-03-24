import type { AIProvider } from '@/lib/ai/provider'
import { parseStructuredResponse } from '@/lib/ai/provider'
import { buildDetectGapsPrompt, DETECT_GAPS_SCHEMA } from '@/lib/ai/prompts/detect-gaps'
import type { ParsedItem } from '@/lib/requirements/parser'
import { hasApprovalRole } from '@/lib/requirements/rules/has-approval-role'
import { hasWorkflowStates } from '@/lib/requirements/rules/has-workflow-states'
import { hasNonFunctionalRequirements } from '@/lib/requirements/rules/has-nfrs'
import { hasErrorHandling } from '@/lib/requirements/rules/has-error-handling'
import { hasActorsDefined } from '@/lib/requirements/rules/has-actors-defined'
import type { GapCategory, GapSeverity, GapSource } from '@/lib/supabase/types'

export interface DetectedGap {
  item_id: string | null
  severity: GapSeverity
  category: GapCategory
  description: string
  source: GapSource
  rule_id: string | null
  priority_score: number
  confidence: number
  question_generated: boolean
}

export interface MergedPair {
  survivorIndex: number
  mergedIndex: number
}

export interface GapDetectionResult {
  gaps: DetectedGap[]
  mergedPairs: MergedPair[]
}

const IMPACT: Record<GapSeverity, number> = { critical: 3, major: 2, minor: 1 }
const UNCERTAINTY: Record<GapCategory, number> = { missing: 3, ambiguous: 2, conflicting: 2, incomplete: 1 }

function priorityScore(severity: GapSeverity, category: GapCategory): number {
  return IMPACT[severity] * UNCERTAINTY[category]
}

function makeRuleGap(
  category: GapCategory,
  severity: GapSeverity,
  description: string,
  rule_id: string
): DetectedGap {
  return {
    item_id: null,
    severity,
    category,
    description,
    source: 'rule',
    rule_id,
    priority_score: priorityScore(severity, category),
    confidence: 100,
    question_generated: false,
  }
}

function runRules(items: ParsedItem[]): DetectedGap[] {
  const gaps: DetectedGap[] = []
  if (!hasActorsDefined(items)) {
    gaps.push(makeRuleGap('missing', 'critical', 'No user roles or system actors are defined.', 'hasActorsDefined'))
  }
  if (!hasApprovalRole(items)) {
    gaps.push(makeRuleGap('missing', 'critical', 'No approval or sign-off role is defined.', 'hasApprovalRole'))
  }
  if (!hasWorkflowStates(items)) {
    gaps.push(makeRuleGap('missing', 'critical', 'No system states or status transitions are defined.', 'hasWorkflowStates'))
  }
  if (!hasNonFunctionalRequirements(items)) {
    gaps.push(makeRuleGap('missing', 'major', 'No non-functional requirements are specified.', 'hasNonFunctionalRequirements'))
  }
  if (!hasErrorHandling(items)) {
    gaps.push(makeRuleGap('missing', 'major', 'No error handling or failure scenarios are addressed.', 'hasErrorHandling'))
  }
  return gaps
}

/** Group gaps by category+item_id. Within each group the highest-severity gap survives; others are recorded as merged. */
function computeMerges(gaps: DetectedGap[]): MergedPair[] {
  const groups = new Map<string, number[]>()
  gaps.forEach((gap, idx) => {
    const key = `${gap.category}::${gap.item_id ?? 'null'}`
    const existing = groups.get(key) ?? []
    existing.push(idx)
    groups.set(key, existing)
  })

  const pairs: MergedPair[] = []
  for (const indices of groups.values()) {
    if (indices.length < 2) continue
    const sorted = [...indices].sort((a, b) => IMPACT[gaps[b].severity] - IMPACT[gaps[a].severity])
    const survivorIndex = sorted[0]
    for (let i = 1; i < sorted.length; i++) {
      pairs.push({ survivorIndex, mergedIndex: sorted[i] })
    }
  }
  return pairs
}

export async function detectGaps(items: ParsedItem[], ai: AIProvider): Promise<GapDetectionResult> {
  const ruleGaps = runRules(items)

  const itemsJson = JSON.stringify(items.map((item, i) => ({ id: `item-${i}`, ...item })))
  const prompt = buildDetectGapsPrompt(itemsJson)
  const raw = await ai.complete(prompt, { responseSchema: DETECT_GAPS_SCHEMA })
  const parsed = parseStructuredResponse<{ gaps: Array<{
    item_id?: string | null
    severity: GapSeverity
    category: GapCategory
    description: string
    confidence: number
  }> }>(raw, DETECT_GAPS_SCHEMA)

  const aiGaps: DetectedGap[] = parsed.gaps.map(g => ({
    item_id: g.item_id ?? null,
    severity: g.severity,
    category: g.category,
    description: g.description,
    source: 'ai' as GapSource,
    rule_id: null,
    priority_score: priorityScore(g.severity, g.category),
    confidence: g.confidence,
    question_generated: false,
  }))

  const allGaps = [...ruleGaps, ...aiGaps].sort((a, b) => b.priority_score - a.priority_score)
  const mergedPairs = computeMerges(allGaps)

  return { gaps: allGaps, mergedPairs }
}
