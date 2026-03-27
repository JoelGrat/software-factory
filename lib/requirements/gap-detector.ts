// lib/requirements/gap-detector.ts
import type { AIProvider } from '@/lib/ai/provider'
import { buildDetectGapsPrompt, DETECT_GAPS_SCHEMA } from '@/lib/ai/prompts/detect-gaps'
import type { ParsedItem } from '@/lib/requirements/parser'
import { selectRulePack } from '@/lib/requirements/rules/index'
import type { GapCategory, GapSeverity, GapSource, RequirementDomain } from '@/lib/supabase/types'

export interface DetectedGap {
  item_id: string | null
  severity: GapSeverity
  category: GapCategory
  description: string
  source: GapSource
  rule_id: string | null
  priority_score: number
  confidence: number
  validated: boolean   // rule + relation = true; ai = false
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

const IMPACT: Record<GapSeverity, number>      = { critical: 3, major: 2, minor: 1 }
const UNCERTAINTY: Record<GapCategory, number> = { missing: 3, ambiguous: 2, conflicting: 2, incomplete: 1 }

function priorityScore(severity: GapSeverity, category: GapCategory): number {
  return IMPACT[severity] * UNCERTAINTY[category]
}

function runRules(items: ParsedItem[], domain: RequirementDomain | null): DetectedGap[] {
  const pack = selectRulePack(domain)
  const gaps: DetectedGap[] = []
  for (const rule of pack) {
    if (!rule.check(items)) {
      gaps.push({
        item_id: null,
        severity: rule.severity,
        category: rule.category,
        description: rule.description,
        source: 'rule',
        rule_id: rule.id,
        priority_score: priorityScore(rule.severity, rule.category),
        confidence: 100,
        validated: true,   // deterministic check — auto-validated
        question_generated: false,
      })
    }
  }
  return gaps
}

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

export async function detectGaps(
  items: ParsedItem[],
  domain: RequirementDomain | null,
  ai: AIProvider
): Promise<GapDetectionResult> {
  const ruleGaps = runRules(items, domain)

  const itemsJson = JSON.stringify(items.map((item, i) => ({ id: `item-${i}`, ...item })))
  const prompt = buildDetectGapsPrompt(itemsJson)
  const result = await ai.complete(prompt, { responseSchema: DETECT_GAPS_SCHEMA })
  const parsed = JSON.parse(result.content) as { gaps: Array<{
    item_id?: string | null
    severity: GapSeverity
    category: GapCategory
    description: string
    confidence: number
  }> }

  const aiGaps: DetectedGap[] = parsed.gaps.map(g => ({
    item_id: g.item_id ?? null,
    severity: g.severity,
    category: g.category,
    description: g.description,
    source: 'ai' as GapSource,
    rule_id: null,
    priority_score: priorityScore(g.severity, g.category),
    confidence: g.confidence,
    validated: false,   // AI suggestion — requires human validation
    question_generated: false,
  }))

  const allGaps = [...ruleGaps, ...aiGaps].sort((a, b) => b.priority_score - a.priority_score)
  const mergedPairs = computeMerges(allGaps)

  return { gaps: allGaps, mergedPairs }
}
