# Core Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the analysis pipeline that ingests raw requirements text, extracts structured items, detects gaps (rules + AI + patterns), prioritizes and merges gaps, generates clarifying questions, creates investigation tasks, scores completeness, exposes API routes for triggering analysis/answering questions/partial re-evaluation, and asynchronously builds the knowledge layer (gap patterns, resolution patterns, domain templates).

**Architecture:** Six sequential pipeline steps run in `lib/requirements/pipeline.ts`, orchestrated by `POST /api/requirements/[id]/analyze`. Each step is independently committed to Supabase so partial failures don't lose earlier work. Partial re-evaluation (triggered by question answers or task resolution) is deterministic — no AI involved. Knowledge layer extraction is async (triggered post-resolution, never blocks the pipeline). All AI calls go through the `AIProvider` interface from `lib/ai/provider.ts`; tests use `MockAIProvider` exclusively.

**Tech Stack:** Next.js 14 App Router, TypeScript, Supabase (Postgres), Vitest, `@anthropic-ai/sdk` via existing `lib/ai` layer

---

## File Map

**New files — prompts:**
- `lib/ai/prompts/parse-requirements.ts` — structured extraction prompt + response schema
- `lib/ai/prompts/detect-gaps.ts` — AI gap detection prompt + response schema
- `lib/ai/prompts/generate-question.ts` — question generation prompt + response schema
- `lib/ai/prompts/evaluate-answer.ts` — answer evaluation prompt + response schema
- `lib/ai/prompts/classify-domain.ts` — domain classification prompt + response schema

**New files — pipeline steps:**
- `lib/requirements/parser.ts` — step 1: AI extracts ParsedItem[] from raw text
- `lib/requirements/rules/has-approval-role.ts` — rule: approval role defined?
- `lib/requirements/rules/has-workflow-states.ts` — rule: status/state transitions defined?
- `lib/requirements/rules/has-nfrs.ts` — rule: at least one non-functional item?
- `lib/requirements/rules/has-error-handling.ts` — rule: failure/error handling addressed?
- `lib/requirements/rules/has-actors-defined.ts` — rule: user roles or system actors named?
- `lib/requirements/gap-detector.ts` — step 2–3: run all rules + AI, return gaps + merge pairs
- `lib/requirements/question-generator.ts` — step 4: parallel AI calls for top-10 gaps
- `lib/requirements/task-creator.ts` — step 5: create investigation tasks for critical/major gaps
- `lib/requirements/scorer.ts` — step 6: completeness, NFR, overall, confidence scores
- `lib/requirements/re-evaluator.ts` — post-answer / post-task recalculation (no AI)
- `lib/requirements/pipeline.ts` — orchestrator: runs steps 1–6, writes audit log, handles partial failures
- `lib/requirements/knowledge/pattern-extractor.ts` — async: distil resolved gap → gap_pattern
- `lib/requirements/knowledge/resolution-extractor.ts` — async: distil decision → resolution_pattern
- `lib/requirements/knowledge/domain-classifier.ts` — domain classification (1 AI call, runs at analysis start)

**New files — API routes:**
- `app/api/requirements/[id]/analyze/route.ts` — POST: triggers pipeline
- `app/api/requirements/[id]/status/route.ts` — PATCH: status gate transitions
- `app/api/requirements/[id]/summary/route.ts` — GET: summary panel data
- `app/api/questions/[id]/route.ts` — PATCH: answer question → partial re-eval
- `app/api/investigation-tasks/[id]/route.ts` — PATCH: resolve/dismiss task → partial re-eval

**New files — tests:**
- `tests/lib/requirements/parser.test.ts`
- `tests/lib/requirements/rules/has-approval-role.test.ts`
- `tests/lib/requirements/rules/has-workflow-states.test.ts`
- `tests/lib/requirements/rules/has-nfrs.test.ts`
- `tests/lib/requirements/rules/has-error-handling.test.ts`
- `tests/lib/requirements/rules/has-actors-defined.test.ts`
- `tests/lib/requirements/gap-detector.test.ts`
- `tests/lib/requirements/scorer.test.ts`
- `tests/lib/requirements/question-generator.test.ts`
- `tests/lib/requirements/task-creator.test.ts`
- `tests/lib/requirements/re-evaluator.test.ts`
- `tests/lib/requirements/pipeline.test.ts`
- `tests/api/requirements/status.test.ts`

---

## Task 1: AI Prompt Templates

**Files:**
- Create: `lib/ai/prompts/parse-requirements.ts`
- Create: `lib/ai/prompts/detect-gaps.ts`
- Create: `lib/ai/prompts/generate-question.ts`
- Create: `lib/ai/prompts/evaluate-answer.ts`
- Create: `lib/ai/prompts/classify-domain.ts`

Schemas are typed as `Record<string, unknown>` (not `as const`) so they are directly assignable to `CompletionOptions.responseSchema` and `parseStructuredResponse`'s second parameter.

- [ ] **Step 1: Create parse-requirements prompt**

Create `lib/ai/prompts/parse-requirements.ts`:
```typescript
export const PARSE_REQUIREMENTS_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['functional', 'non-functional', 'constraint', 'assumption'] },
          title: { type: 'string' },
          description: { type: 'string' },
          priority: { type: 'string', enum: ['high', 'medium', 'low'] },
          source_text: { type: 'string' },
          nfr_category: { type: 'string', enum: ['security', 'performance', 'auditability'], nullable: true },
        },
        required: ['type', 'title', 'description', 'priority', 'source_text'],
      },
    },
  },
  required: ['items'],
}

export function buildParsePrompt(rawInput: string): string {
  return `You are a requirements analyst. Extract all discrete requirement items from the text below.

For each item:
- type: "functional" (feature/behaviour), "non-functional" (quality/constraint), "constraint" (hard limit), or "assumption" (assumed but not stated)
- title: 5-10 word summary
- description: full detail in one or two sentences
- priority: "high" (blocking/critical), "medium" (important), or "low" (nice-to-have)
- source_text: the exact sentence or phrase this item came from
- nfr_category: only for non-functional items — "security", "performance", or "auditability". Omit for all other types.

Return ONLY valid JSON matching the schema. Do not add commentary.

--- REQUIREMENTS TEXT ---
${rawInput}
--- END ---`
}
```

- [ ] **Step 2: Create detect-gaps prompt**

Create `lib/ai/prompts/detect-gaps.ts`:
```typescript
export const DETECT_GAPS_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    gaps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          item_id: { type: 'string', nullable: true },
          severity: { type: 'string', enum: ['critical', 'major', 'minor'] },
          category: { type: 'string', enum: ['missing', 'ambiguous', 'conflicting', 'incomplete'] },
          description: { type: 'string' },
          confidence: { type: 'number', minimum: 0, maximum: 100 },
        },
        required: ['severity', 'category', 'description', 'confidence'],
      },
    },
  },
  required: ['gaps'],
}

export function buildDetectGapsPrompt(itemsJson: string): string {
  return `You are a senior requirements analyst performing a gap analysis.

Review the structured requirement items below. Identify gaps that require reasoning — ambiguity, implicit conflicts, domain-specific omissions, incomplete specifications.

For each gap:
- item_id: the item ID this gap relates to, or null for document-level gaps
- severity: "critical" (blocks development), "major" (significant risk), or "minor" (worth noting)
- category: "missing" (not mentioned), "ambiguous" (unclear meaning), "conflicting" (contradicts another item), or "incomplete" (mentioned but not fully specified)
- description: 1-2 sentences explaining the gap
- confidence: 0-100 — how certain are you this is a real gap? (100 = definitely a gap)

Only report genuine gaps. Do not duplicate gaps already reported by deterministic rules. Return ONLY valid JSON.

--- REQUIREMENT ITEMS ---
${itemsJson}
--- END ---`
}
```

- [ ] **Step 3: Create generate-question prompt**

Create `lib/ai/prompts/generate-question.ts`:
```typescript
export const GENERATE_QUESTION_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    question_text: { type: 'string' },
    target_role: { type: 'string', enum: ['ba', 'architect', 'po', 'dev'] },
  },
  required: ['question_text', 'target_role'],
}

export function buildGenerateQuestionPrompt(
  gapDescription: string,
  gapCategory: string,
  itemDescription: string | null
): string {
  const itemContext = itemDescription
    ? `\nRelated requirement item: ${itemDescription}`
    : '\n(Document-level gap — not tied to a specific item)'

  return `You are a requirements analyst. Generate one concise clarifying question for the gap below.

Gap category: ${gapCategory}
Gap description: ${gapDescription}${itemContext}

Target role assignment rules:
- "ambiguous" gaps → target_role: "ba"
- "missing"/"incomplete" with product/business decision → target_role: "po"
- "missing"/"incomplete" with process/detail/technical → target_role: "ba"
- "conflicting" with technical concern → target_role: "architect"
- "conflicting" with business rules → target_role: "po"

The question must be specific enough that the answer would resolve the gap. Not more than two sentences.

Return ONLY valid JSON.`
}
```

- [ ] **Step 4: Create evaluate-answer prompt**

Create `lib/ai/prompts/evaluate-answer.ts`:
```typescript
export const EVALUATE_ANSWER_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    resolved: { type: 'boolean' },
    rationale: { type: 'string' },
  },
  required: ['resolved', 'rationale'],
}

export function buildEvaluateAnswerPrompt(
  gapDescription: string,
  questionText: string,
  answer: string
): string {
  return `You are a requirements analyst evaluating whether a stakeholder's answer resolves a gap.

Gap: ${gapDescription}
Question asked: ${questionText}
Answer provided: ${answer}

Does this answer resolve the gap?
- resolved: true if the answer provides enough information to eliminate the ambiguity or fill the missing detail
- rationale: 1-2 sentences explaining why it does or does not resolve the gap

Return ONLY valid JSON.`
}
```

- [ ] **Step 5: Create classify-domain prompt**

Create `lib/ai/prompts/classify-domain.ts`:
```typescript
export const CLASSIFY_DOMAIN_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    domain: { type: 'string' },
    confidence: { type: 'number', minimum: 0, maximum: 100 },
  },
  required: ['domain', 'confidence'],
}

export function buildClassifyDomainPrompt(rawInput: string): string {
  return `You are a business analyst. Classify the domain of the requirements below.

Common domains: e-commerce, healthcare, fintech, saas, logistics, hr-management, content-management, iot, gaming, other.

Return:
- domain: the single best-matching domain string (lowercase, hyphenated)
- confidence: 0-100 how confident you are

Return ONLY valid JSON.

--- REQUIREMENTS ---
${rawInput.slice(0, 1000)}
--- END ---`
}
```

- [ ] **Step 6: Commit**

```bash
git add lib/ai/prompts/
git commit -m "feat: add AI prompt templates for pipeline steps"
```

---

## Task 2: Requirements Parser

**Files:**
- Create: `lib/requirements/parser.ts`
- Create: `tests/lib/requirements/parser.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/lib/requirements/parser.test.ts`:
```typescript
import { describe, it, expect } from 'vitest'
import { parseRequirements } from '@/lib/requirements/parser'
import { MockAIProvider } from '@/lib/ai/adapters/mock'

describe('parseRequirements', () => {
  it('extracts items from raw text', async () => {
    const mock = new MockAIProvider()
    mock.setDefaultResponse(JSON.stringify({
      items: [
        {
          type: 'functional',
          title: 'User login',
          description: 'Users must be able to log in with email and password.',
          priority: 'high',
          source_text: 'Users must be able to log in',
          nfr_category: null,
        },
        {
          type: 'non-functional',
          title: 'Response time under 200ms',
          description: 'All API responses must complete within 200ms.',
          priority: 'medium',
          source_text: 'response time under 200ms',
          nfr_category: 'performance',
        },
      ],
    }))

    const result = await parseRequirements('Users must be able to log in. Response time under 200ms.', mock)
    expect(result).toHaveLength(2)
    expect(result[0].type).toBe('functional')
    expect(result[1].nfr_category).toBe('performance')
  })

  it('throws if AI returns invalid JSON', async () => {
    const mock = new MockAIProvider()
    mock.setDefaultResponse('not json at all')
    await expect(parseRequirements('some text', mock)).rejects.toThrow('invalid JSON')
  })

  it('returns empty array when AI returns empty items list', async () => {
    const mock = new MockAIProvider()
    mock.setDefaultResponse(JSON.stringify({ items: [] }))
    const result = await parseRequirements('', mock)
    expect(result).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/lib/requirements/parser.test.ts
```
Expected: FAIL — `Cannot find module '@/lib/requirements/parser'`

- [ ] **Step 3: Implement parser**

Create `lib/requirements/parser.ts`:
```typescript
import type { AIProvider } from '@/lib/ai/provider'
import { parseStructuredResponse } from '@/lib/ai/provider'
import { buildParsePrompt, PARSE_REQUIREMENTS_SCHEMA } from '@/lib/ai/prompts/parse-requirements'
import type { ItemType, NfrCategory } from '@/lib/supabase/types'

export interface ParsedItem {
  type: ItemType
  title: string
  description: string
  priority: 'high' | 'medium' | 'low'
  source_text: string
  nfr_category: NfrCategory | null
}

export async function parseRequirements(rawInput: string, ai: AIProvider): Promise<ParsedItem[]> {
  const prompt = buildParsePrompt(rawInput)
  const raw = await ai.complete(prompt, { responseSchema: PARSE_REQUIREMENTS_SCHEMA })
  const parsed = parseStructuredResponse<{ items: ParsedItem[] }>(raw, PARSE_REQUIREMENTS_SCHEMA)
  return parsed.items
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/lib/requirements/parser.test.ts
```
Expected: 3 tests PASS

- [ ] **Step 5: Commit**

```bash
git add lib/requirements/parser.ts tests/lib/requirements/parser.test.ts lib/ai/prompts/parse-requirements.ts
git commit -m "feat: add requirements parser (step 1 of pipeline)"
```

---

## Task 3: Gap Detection Rules

**Files:**
- Create: `lib/requirements/rules/has-approval-role.ts`
- Create: `lib/requirements/rules/has-workflow-states.ts`
- Create: `lib/requirements/rules/has-nfrs.ts`
- Create: `lib/requirements/rules/has-error-handling.ts`
- Create: `lib/requirements/rules/has-actors-defined.ts`
- Create: `tests/lib/requirements/rules/has-approval-role.test.ts`
- Create: `tests/lib/requirements/rules/has-workflow-states.test.ts`
- Create: `tests/lib/requirements/rules/has-nfrs.test.ts`
- Create: `tests/lib/requirements/rules/has-error-handling.test.ts`
- Create: `tests/lib/requirements/rules/has-actors-defined.test.ts`

Each rule is a pure function: `(items: ParsedItem[]) => boolean`. No AI, no I/O.

- [ ] **Step 1: Write failing tests for all 5 rules**

Create `tests/lib/requirements/rules/has-approval-role.test.ts`:
```typescript
import { describe, it, expect } from 'vitest'
import { hasApprovalRole } from '@/lib/requirements/rules/has-approval-role'
import type { ParsedItem } from '@/lib/requirements/parser'

const base: ParsedItem = {
  type: 'functional', title: 'x', description: 'x', priority: 'low', source_text: 'x', nfr_category: null,
}

describe('hasApprovalRole', () => {
  it('returns false when no items mention approval', () => {
    expect(hasApprovalRole([{ ...base, description: 'User can submit a form.' }])).toBe(false)
  })
  it('returns true when an item mentions approval', () => {
    expect(hasApprovalRole([{ ...base, description: 'A manager must approve all requests.' }])).toBe(true)
  })
  it('returns true for sign-off keyword', () => {
    expect(hasApprovalRole([{ ...base, title: 'Sign-off by finance lead' }])).toBe(true)
  })
  it('returns false for empty items array', () => {
    expect(hasApprovalRole([])).toBe(false)
  })
})
```

Create `tests/lib/requirements/rules/has-workflow-states.test.ts`:
```typescript
import { describe, it, expect } from 'vitest'
import { hasWorkflowStates } from '@/lib/requirements/rules/has-workflow-states'
import type { ParsedItem } from '@/lib/requirements/parser'

const base: ParsedItem = {
  type: 'functional', title: 'x', description: 'x', priority: 'low', source_text: 'x', nfr_category: null,
}

describe('hasWorkflowStates', () => {
  it('returns false when no state/status language exists', () => {
    expect(hasWorkflowStates([{ ...base, description: 'User submits a form.' }])).toBe(false)
  })
  it('returns true when an item defines a state transition', () => {
    expect(hasWorkflowStates([{ ...base, description: 'Order transitions from pending to confirmed.' }])).toBe(true)
  })
  it('returns true for status keyword', () => {
    expect(hasWorkflowStates([{ ...base, title: 'Order status management' }])).toBe(true)
  })
})
```

Create `tests/lib/requirements/rules/has-nfrs.test.ts`:
```typescript
import { describe, it, expect } from 'vitest'
import { hasNonFunctionalRequirements } from '@/lib/requirements/rules/has-nfrs'
import type { ParsedItem } from '@/lib/requirements/parser'

const base: ParsedItem = {
  type: 'functional', title: 'x', description: 'x', priority: 'low', source_text: 'x', nfr_category: null,
}

describe('hasNonFunctionalRequirements', () => {
  it('returns false when all items are functional', () => {
    expect(hasNonFunctionalRequirements([base])).toBe(false)
  })
  it('returns true when at least one non-functional item exists', () => {
    const nfr: ParsedItem = { ...base, type: 'non-functional', nfr_category: 'performance' }
    expect(hasNonFunctionalRequirements([base, nfr])).toBe(true)
  })
})
```

Create `tests/lib/requirements/rules/has-error-handling.test.ts`:
```typescript
import { describe, it, expect } from 'vitest'
import { hasErrorHandling } from '@/lib/requirements/rules/has-error-handling'
import type { ParsedItem } from '@/lib/requirements/parser'

const base: ParsedItem = {
  type: 'functional', title: 'x', description: 'x', priority: 'low', source_text: 'x', nfr_category: null,
}

describe('hasErrorHandling', () => {
  it('returns false when no error handling mentioned', () => {
    expect(hasErrorHandling([{ ...base, description: 'User logs in successfully.' }])).toBe(false)
  })
  it('returns true when failure scenario is described', () => {
    expect(hasErrorHandling([{ ...base, description: 'If login fails, show error message.' }])).toBe(true)
  })
  it('returns true for exception keyword', () => {
    expect(hasErrorHandling([{ ...base, title: 'Handle timeout exceptions' }])).toBe(true)
  })
})
```

Create `tests/lib/requirements/rules/has-actors-defined.test.ts`:
```typescript
import { describe, it, expect } from 'vitest'
import { hasActorsDefined } from '@/lib/requirements/rules/has-actors-defined'
import type { ParsedItem } from '@/lib/requirements/parser'

const base: ParsedItem = {
  type: 'functional', title: 'x', description: 'x', priority: 'low', source_text: 'x', nfr_category: null,
}

describe('hasActorsDefined', () => {
  it('returns false when no actor is named', () => {
    expect(hasActorsDefined([{ ...base, description: 'The system processes the request.' }])).toBe(false)
  })
  it('returns true when a user role is mentioned', () => {
    expect(hasActorsDefined([{ ...base, description: 'Admin can manage all accounts.' }])).toBe(true)
  })
  it('returns true when a named system actor is referenced', () => {
    expect(hasActorsDefined([{ ...base, description: 'The payment gateway validates the card.' }])).toBe(true)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/lib/requirements/rules/
```
Expected: All FAIL — modules not found

- [ ] **Step 3: Implement the 5 rules**

Create `lib/requirements/rules/has-approval-role.ts`:
```typescript
import type { ParsedItem } from '@/lib/requirements/parser'

const APPROVAL_KEYWORDS = ['approv', 'sign-off', 'signoff', 'sign off', 'authorize', 'authorise', 'endorse', 'ratif', 'clearance']

export function hasApprovalRole(items: ParsedItem[]): boolean {
  return items.some(item =>
    APPROVAL_KEYWORDS.some(kw =>
      item.title.toLowerCase().includes(kw) || item.description.toLowerCase().includes(kw)
    )
  )
}
```

Create `lib/requirements/rules/has-workflow-states.ts`:
```typescript
import type { ParsedItem } from '@/lib/requirements/parser'

const STATE_KEYWORDS = ['status', 'state', 'transition', 'workflow', 'pending', 'active', 'inactive', 'approved', 'rejected', 'draft', 'published', 'closed', 'in progress', 'complete']

export function hasWorkflowStates(items: ParsedItem[]): boolean {
  return items.some(item =>
    STATE_KEYWORDS.some(kw =>
      item.title.toLowerCase().includes(kw) || item.description.toLowerCase().includes(kw)
    )
  )
}
```

Create `lib/requirements/rules/has-nfrs.ts`:
```typescript
import type { ParsedItem } from '@/lib/requirements/parser'

export function hasNonFunctionalRequirements(items: ParsedItem[]): boolean {
  return items.some(item => item.type === 'non-functional')
}
```

Create `lib/requirements/rules/has-error-handling.ts`:
```typescript
import type { ParsedItem } from '@/lib/requirements/parser'

const ERROR_KEYWORDS = ['error', 'fail', 'failure', 'exception', 'invalid', 'timeout', 'retry', 'fallback', 'handle', 'catch', 'unavailable', 'downtime']

export function hasErrorHandling(items: ParsedItem[]): boolean {
  return items.some(item =>
    ERROR_KEYWORDS.some(kw =>
      item.title.toLowerCase().includes(kw) || item.description.toLowerCase().includes(kw)
    )
  )
}
```

Create `lib/requirements/rules/has-actors-defined.ts`:
```typescript
import type { ParsedItem } from '@/lib/requirements/parser'

const ACTOR_KEYWORDS = ['admin', 'user', 'customer', 'manager', 'operator', 'reviewer', 'approver', 'system', 'service', 'api', 'gateway', 'client', 'vendor', 'staff', 'role', 'actor', 'stakeholder']

export function hasActorsDefined(items: ParsedItem[]): boolean {
  return items.some(item =>
    ACTOR_KEYWORDS.some(kw =>
      item.title.toLowerCase().includes(kw) || item.description.toLowerCase().includes(kw)
    )
  )
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/lib/requirements/rules/
```
Expected: All 14 tests PASS

- [ ] **Step 5: Commit**

```bash
git add lib/requirements/rules/ tests/lib/requirements/rules/
git commit -m "feat: add gap detection rules (5 deterministic checks)"
```

---

## Task 4: Gap Detector Orchestrator

**Files:**
- Create: `lib/requirements/gap-detector.ts`
- Create: `tests/lib/requirements/gap-detector.test.ts`

Runs rules (Layer A) + AI (Layer B), returns gaps and a separate `mergedPairs` array so the pipeline can update `merged_into` with real DB UUIDs after insertion.

- [ ] **Step 1: Write failing tests**

Create `tests/lib/requirements/gap-detector.test.ts`:
```typescript
import { describe, it, expect } from 'vitest'
import { detectGaps } from '@/lib/requirements/gap-detector'
import { MockAIProvider } from '@/lib/ai/adapters/mock'
import type { ParsedItem } from '@/lib/requirements/parser'

const minimalItems: ParsedItem[] = [
  {
    type: 'functional',
    title: 'User login',
    description: 'Users log in with email.',
    priority: 'high',
    source_text: 'Users log in with email.',
    nfr_category: null,
  },
]

describe('detectGaps', () => {
  it('fires rule gaps when rules fail', async () => {
    const mock = new MockAIProvider()
    mock.setDefaultResponse(JSON.stringify({ gaps: [] }))
    const { gaps } = await detectGaps(minimalItems, mock)
    // minimalItems has no actors, no approval role, no workflow states, no NFR, no error handling
    const ruleGaps = gaps.filter(g => g.source === 'rule')
    expect(ruleGaps.length).toBeGreaterThanOrEqual(4)
    expect(ruleGaps.every(g => g.confidence === 100)).toBe(true)
  })

  it('includes AI gaps tagged source=ai', async () => {
    const mock = new MockAIProvider()
    mock.setDefaultResponse(JSON.stringify({
      gaps: [{
        item_id: null,
        severity: 'major',
        category: 'missing',
        description: 'No data retention policy specified.',
        confidence: 85,
      }],
    }))
    const { gaps } = await detectGaps(minimalItems, mock)
    const aiGaps = gaps.filter(g => g.source === 'ai')
    expect(aiGaps).toHaveLength(1)
    expect(aiGaps[0].confidence).toBe(85)
  })

  it('computes priority_score as impact × uncertainty', async () => {
    const mock = new MockAIProvider()
    mock.setDefaultResponse(JSON.stringify({ gaps: [] }))
    const { gaps } = await detectGaps(minimalItems, mock)
    const criticalMissing = gaps.find(g => g.severity === 'critical' && g.category === 'missing')
    if (criticalMissing) {
      expect(criticalMissing.priority_score).toBe(9) // 3 × 3
    }
  })

  it('returns mergedPairs when duplicate gaps exist', async () => {
    const mock = new MockAIProvider()
    mock.setDefaultResponse(JSON.stringify({
      gaps: [
        { item_id: 'item-0', severity: 'minor', category: 'missing', description: 'Gap A', confidence: 70 },
        { item_id: 'item-0', severity: 'major', category: 'missing', description: 'Gap B', confidence: 80 },
      ],
    }))
    const { mergedPairs } = await detectGaps(minimalItems, mock)
    expect(mergedPairs.length).toBeGreaterThanOrEqual(1)
    // survivorIndex is the higher-severity gap (major)
    const pair = mergedPairs[0]
    expect(typeof pair.survivorIndex).toBe('number')
    expect(typeof pair.mergedIndex).toBe('number')
  })

  it('all gaps have question_generated false by default', async () => {
    const mock = new MockAIProvider()
    mock.setDefaultResponse(JSON.stringify({ gaps: [] }))
    const { gaps } = await detectGaps(minimalItems, mock)
    expect(gaps.every(g => g.question_generated === false)).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/lib/requirements/gap-detector.test.ts
```
Expected: FAIL — module not found

- [ ] **Step 3: Implement gap-detector**

Create `lib/requirements/gap-detector.ts`:
```typescript
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
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/lib/requirements/gap-detector.test.ts
```
Expected: All 5 tests PASS

- [ ] **Step 5: Commit**

```bash
git add lib/requirements/gap-detector.ts tests/lib/requirements/gap-detector.test.ts lib/ai/prompts/detect-gaps.ts
git commit -m "feat: add gap detector (rules + AI, merge tracking, priority scoring)"
```

---

## Task 5: Completeness Scorer

**Files:**
- Create: `lib/requirements/scorer.ts`
- Create: `tests/lib/requirements/scorer.test.ts`

Pure function — no AI, no I/O. Note: minor gaps alone do NOT block `ready_for_dev` per spec.

- [ ] **Step 1: Write failing tests**

Create `tests/lib/requirements/scorer.test.ts`:
```typescript
import { describe, it, expect } from 'vitest'
import { computeScore } from '@/lib/requirements/scorer'
import type { DetectedGap } from '@/lib/requirements/gap-detector'
import type { ParsedItem } from '@/lib/requirements/parser'

const nfrItem: ParsedItem = {
  type: 'non-functional', title: 'Perf', description: 'Response under 200ms', priority: 'high', source_text: 'x', nfr_category: 'performance',
}
const secItem: ParsedItem = {
  type: 'non-functional', title: 'Auth', description: 'Auth via OAuth', priority: 'high', source_text: 'x', nfr_category: 'security',
}
const auditItem: ParsedItem = {
  type: 'non-functional', title: 'Audit', description: 'All actions audited', priority: 'medium', source_text: 'x', nfr_category: 'auditability',
}

const noGaps: DetectedGap[] = []
const noMergedPairs = new Set<number>()

describe('computeScore', () => {
  it('returns 100 completeness and 100 nfr when no gaps and all NFR categories covered', () => {
    const result = computeScore(noGaps, noMergedPairs, [nfrItem, secItem, auditItem])
    expect(result.completeness).toBe(100)
    expect(result.nfr_score).toBe(100)
    expect(result.overall_score).toBe(100)
  })

  it('deducts 20 per critical gap', () => {
    const critGap: DetectedGap = {
      item_id: null, severity: 'critical', category: 'missing', description: 'x',
      source: 'rule', rule_id: 'x', priority_score: 9, confidence: 100, question_generated: false,
    }
    const result = computeScore([critGap], noMergedPairs, [nfrItem, secItem, auditItem])
    expect(result.completeness).toBe(80)
  })

  it('deducts 10 per major gap and 3 per minor gap', () => {
    const majorGap: DetectedGap = {
      item_id: null, severity: 'major', category: 'missing', description: 'x',
      source: 'ai', rule_id: null, priority_score: 6, confidence: 80, question_generated: false,
    }
    const minorGap: DetectedGap = {
      item_id: null, severity: 'minor', category: 'incomplete', description: 'x',
      source: 'ai', rule_id: null, priority_score: 1, confidence: 60, question_generated: false,
    }
    const result = computeScore([majorGap, minorGap], noMergedPairs, [])
    expect(result.completeness).toBe(87) // 100 - 10 - 3
  })

  it('skips merged gaps in scoring', () => {
    const critGap: DetectedGap = {
      item_id: null, severity: 'critical', category: 'missing', description: 'x',
      source: 'rule', rule_id: 'x', priority_score: 9, confidence: 100, question_generated: false,
    }
    // Index 0 is merged — should not count
    const mergedIndices = new Set([0])
    const result = computeScore([critGap], mergedIndices, [])
    expect(result.completeness).toBe(100) // merged gap excluded
  })

  it('clamps completeness at 0', () => {
    const critGaps = Array.from({ length: 6 }, (_, i): DetectedGap => ({
      item_id: null, severity: 'critical', category: 'missing', description: `gap ${i}`,
      source: 'rule', rule_id: 'x', priority_score: 9, confidence: 100, question_generated: false,
    }))
    const result = computeScore(critGaps, noMergedPairs, [])
    expect(result.completeness).toBe(0)
  })

  it('computes nfr_score as partial coverage', () => {
    const result = computeScore(noGaps, noMergedPairs, [nfrItem]) // only performance
    expect(result.nfr_score).toBe(33)
  })

  it('computes overall_score as 70% completeness + 30% nfr', () => {
    const result = computeScore(noGaps, noMergedPairs, [nfrItem, secItem]) // 67 nfr, 100 completeness
    expect(result.overall_score).toBe(Math.round(100 * 0.7 + 67 * 0.3))
  })

  it('computes confidence as average of AI-sourced gap confidences', () => {
    const aiGap1: DetectedGap = {
      item_id: null, severity: 'minor', category: 'incomplete', description: 'x',
      source: 'ai', rule_id: null, priority_score: 1, confidence: 80, question_generated: false,
    }
    const aiGap2: DetectedGap = {
      item_id: null, severity: 'minor', category: 'ambiguous', description: 'x',
      source: 'ai', rule_id: null, priority_score: 2, confidence: 60, question_generated: false,
    }
    const result = computeScore([aiGap1, aiGap2], noMergedPairs, [])
    expect(result.confidence).toBe(70) // (80+60)/2
  })

  it('returns confidence 100 when all gaps are rule-sourced', () => {
    const ruleGap: DetectedGap = {
      item_id: null, severity: 'critical', category: 'missing', description: 'x',
      source: 'rule', rule_id: 'x', priority_score: 9, confidence: 100, question_generated: false,
    }
    const result = computeScore([ruleGap], noMergedPairs, [])
    expect(result.confidence).toBe(100)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/lib/requirements/scorer.test.ts
```
Expected: FAIL — module not found

- [ ] **Step 3: Implement scorer**

Create `lib/requirements/scorer.ts`:
```typescript
import type { DetectedGap } from '@/lib/requirements/gap-detector'
import type { ParsedItem } from '@/lib/requirements/parser'
import type { ScoreBreakdown } from '@/lib/supabase/types'

export interface ComputedScore {
  completeness: number
  nfr_score: number
  overall_score: number
  confidence: number
  breakdown: ScoreBreakdown
}

const NFR_WEIGHTS: Record<'security' | 'performance' | 'auditability', number> = {
  security: 34,
  performance: 33,
  auditability: 33,
}

/**
 * @param gaps - all detected gaps (sorted by priority)
 * @param mergedIndices - set of gap array indices that were merged (excluded from scoring)
 * @param items - parsed requirement items (for NFR coverage)
 */
export function computeScore(
  gaps: DetectedGap[],
  mergedIndices: Set<number>,
  items: ParsedItem[]
): ComputedScore {
  const activeGaps = gaps.filter((_, i) => !mergedIndices.has(i))

  const criticalCount = activeGaps.filter(g => g.severity === 'critical').length
  const majorCount = activeGaps.filter(g => g.severity === 'major').length
  const minorCount = activeGaps.filter(g => g.severity === 'minor').length

  const completeness = Math.max(0, 100 - criticalCount * 20 - majorCount * 10 - minorCount * 3)

  const nfrCoverage = {
    security: items.some(i => i.type === 'non-functional' && i.nfr_category === 'security'),
    performance: items.some(i => i.type === 'non-functional' && i.nfr_category === 'performance'),
    auditability: items.some(i => i.type === 'non-functional' && i.nfr_category === 'auditability'),
  }

  const nfr_score =
    (nfrCoverage.security ? NFR_WEIGHTS.security : 0) +
    (nfrCoverage.performance ? NFR_WEIGHTS.performance : 0) +
    (nfrCoverage.auditability ? NFR_WEIGHTS.auditability : 0)

  const overall_score = Math.round(completeness * 0.7 + nfr_score * 0.3)

  const aiGaps = activeGaps.filter(g => g.source === 'ai')
  const confidence =
    aiGaps.length === 0
      ? 100
      : Math.round(aiGaps.reduce((sum, g) => sum + g.confidence, 0) / aiGaps.length)

  const breakdown: ScoreBreakdown = {
    completeness,
    nfr_score,
    overall: overall_score,
    confidence,
    gap_counts: { critical: criticalCount, major: majorCount, minor: minorCount },
    nfr_coverage: nfrCoverage,
  }

  return { completeness, nfr_score, overall_score, confidence, breakdown }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/lib/requirements/scorer.test.ts
```
Expected: All 9 tests PASS

- [ ] **Step 5: Commit**

```bash
git add lib/requirements/scorer.ts tests/lib/requirements/scorer.test.ts
git commit -m "feat: add completeness scorer (deterministic, no AI)"
```

---

## Task 6: Question Generator

**Files:**
- Create: `lib/requirements/question-generator.ts`
- Create: `tests/lib/requirements/question-generator.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/lib/requirements/question-generator.test.ts`:
```typescript
import { describe, it, expect } from 'vitest'
import { generateQuestions } from '@/lib/requirements/question-generator'
import { MockAIProvider } from '@/lib/ai/adapters/mock'
import type { DetectedGap } from '@/lib/requirements/gap-detector'

const makeGap = (i: number, severity: 'critical' | 'major' | 'minor' = 'critical'): DetectedGap => ({
  item_id: null,
  severity,
  category: 'missing',
  description: `Gap ${i}`,
  source: 'rule',
  rule_id: 'x',
  priority_score: severity === 'critical' ? 9 : severity === 'major' ? 6 : 1,
  confidence: 100,
  question_generated: false,
})

describe('generateQuestions', () => {
  it('generates one question per top-10 non-merged gaps', async () => {
    const mock = new MockAIProvider()
    mock.setDefaultResponse(JSON.stringify({ question_text: 'Who approves?', target_role: 'po' }))
    const gaps = Array.from({ length: 12 }, (_, i) => makeGap(i))
    const mergedIndices = new Set<number>()
    const result = await generateQuestions(gaps, mergedIndices, [], mock)
    expect(result).toHaveLength(10)
  })

  it('skips merged gap indices', async () => {
    const mock = new MockAIProvider()
    mock.setDefaultResponse(JSON.stringify({ question_text: 'Who approves?', target_role: 'po' }))
    const gaps: DetectedGap[] = [makeGap(0), makeGap(1)]
    const mergedIndices = new Set([1]) // gap at index 1 is merged
    const result = await generateQuestions(gaps, mergedIndices, [], mock)
    expect(result).toHaveLength(1)
  })

  it('returns question with correct shape', async () => {
    const mock = new MockAIProvider()
    mock.setDefaultResponse(JSON.stringify({ question_text: 'Who approves requests?', target_role: 'ba' }))
    const result = await generateQuestions([makeGap(0)], new Set(), [], mock)
    expect(result[0]).toMatchObject({
      question_text: 'Who approves requests?',
      target_role: 'ba',
      gap_index: 0,
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/lib/requirements/question-generator.test.ts
```
Expected: FAIL — module not found

- [ ] **Step 3: Implement question-generator**

Create `lib/requirements/question-generator.ts`:
```typescript
import type { AIProvider } from '@/lib/ai/provider'
import { parseStructuredResponse } from '@/lib/ai/provider'
import { buildGenerateQuestionPrompt, GENERATE_QUESTION_SCHEMA } from '@/lib/ai/prompts/generate-question'
import type { DetectedGap } from '@/lib/requirements/gap-detector'
import type { ParsedItem } from '@/lib/requirements/parser'
import type { TargetRole } from '@/lib/supabase/types'

export interface GeneratedQuestion {
  gap_index: number
  question_text: string
  target_role: TargetRole
}

const TOP_N = 10

export async function generateQuestions(
  gaps: DetectedGap[],
  mergedIndices: Set<number>,
  items: ParsedItem[],
  ai: AIProvider
): Promise<GeneratedQuestion[]> {
  const eligible = gaps
    .map((gap, idx) => ({ gap, idx }))
    .filter(({ idx }) => !mergedIndices.has(idx))
    .slice(0, TOP_N)

  const results = await Promise.all(
    eligible.map(async ({ gap, idx }) => {
      const relatedItem = gap.item_id
        ? items.find((_item, i) => `item-${i}` === gap.item_id) ?? null
        : null
      const prompt = buildGenerateQuestionPrompt(gap.description, gap.category, relatedItem?.description ?? null)
      const raw = await ai.complete(prompt, { responseSchema: GENERATE_QUESTION_SCHEMA })
      const parsed = parseStructuredResponse<{ question_text: string; target_role: TargetRole }>(
        raw,
        GENERATE_QUESTION_SCHEMA
      )
      return { gap_index: idx, question_text: parsed.question_text, target_role: parsed.target_role }
    })
  )

  return results
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/lib/requirements/question-generator.test.ts
```
Expected: All 3 tests PASS

- [ ] **Step 5: Commit**

```bash
git add lib/requirements/question-generator.ts tests/lib/requirements/question-generator.test.ts lib/ai/prompts/generate-question.ts
git commit -m "feat: add question generator (parallel AI calls for top-10 gaps)"
```

---

## Task 7: Task Creator

**Files:**
- Create: `lib/requirements/task-creator.ts`
- Create: `tests/lib/requirements/task-creator.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/lib/requirements/task-creator.test.ts`:
```typescript
import { describe, it, expect } from 'vitest'
import { createTasks } from '@/lib/requirements/task-creator'
import type { DetectedGap } from '@/lib/requirements/gap-detector'

const makeGap = (severity: 'critical' | 'major' | 'minor', idx: number): DetectedGap => ({
  item_id: null,
  severity,
  category: 'missing',
  description: `Gap ${idx} — needs investigation`,
  source: 'rule',
  rule_id: 'x',
  priority_score: 9,
  confidence: 100,
  question_generated: false,
})

describe('createTasks', () => {
  it('creates tasks for critical and major gaps only', () => {
    const gaps = [makeGap('critical', 0), makeGap('major', 1), makeGap('minor', 2)]
    const result = createTasks(gaps, new Set())
    expect(result).toHaveLength(2)
  })

  it('skips merged gaps', () => {
    const gaps = [makeGap('critical', 0), makeGap('critical', 1)]
    const mergedIndices = new Set([1])
    const result = createTasks(gaps, mergedIndices)
    expect(result).toHaveLength(1)
  })

  it('sets priority high for critical, medium for major', () => {
    const gaps = [makeGap('critical', 0), makeGap('major', 1)]
    const result = createTasks(gaps, new Set())
    expect(result[0].priority).toBe('high')
    expect(result[1].priority).toBe('medium')
  })

  it('includes gap_index to link back to inserted gap', () => {
    const gaps = [makeGap('critical', 0)]
    const result = createTasks(gaps, new Set())
    expect(result[0].gap_index).toBe(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/lib/requirements/task-creator.test.ts
```
Expected: FAIL — module not found

- [ ] **Step 3: Implement task-creator**

Create `lib/requirements/task-creator.ts`:
```typescript
import type { DetectedGap } from '@/lib/requirements/gap-detector'

export interface TaskToCreate {
  gap_index: number
  title: string
  description: string
  priority: 'high' | 'medium' | 'low'
}

export function createTasks(gaps: DetectedGap[], mergedIndices: Set<number>): TaskToCreate[] {
  return gaps
    .map((gap, idx) => ({ gap, idx }))
    .filter(({ gap, idx }) => !mergedIndices.has(idx) && (gap.severity === 'critical' || gap.severity === 'major'))
    .map(({ gap, idx }) => ({
      gap_index: idx,
      title: `Investigate: ${gap.description.slice(0, 80)}`,
      description: `Gap detected by ${gap.source === 'rule' ? `rule ${gap.rule_id}` : 'AI analysis'}: ${gap.description}`,
      priority: gap.severity === 'critical' ? 'high' as const : 'medium' as const,
    }))
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/lib/requirements/task-creator.test.ts
```
Expected: All 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add lib/requirements/task-creator.ts tests/lib/requirements/task-creator.test.ts
git commit -m "feat: add task creator (auto-generates investigation tasks for critical/major gaps)"
```

---

## Task 8: Re-evaluator

**Files:**
- Create: `lib/requirements/re-evaluator.ts`
- Create: `tests/lib/requirements/re-evaluator.test.ts`

**Spec rule for status computation:**
- `incomplete` — any unresolved critical gap
- `review_required` — no critical, but unresolved major gaps remain
- `ready_for_dev` — no unresolved critical or major gaps (minor gaps alone do NOT block)

- [ ] **Step 1: Write failing tests**

Create `tests/lib/requirements/re-evaluator.test.ts`:
```typescript
import { describe, it, expect } from 'vitest'
import { computeStatusFromScore, resolveGap } from '@/lib/requirements/re-evaluator'
import type { Gap } from '@/lib/supabase/types'

const makeGap = (overrides: Partial<Gap> = {}): Gap => ({
  id: 'g1',
  requirement_id: 'r1',
  item_id: null,
  severity: 'critical',
  category: 'missing',
  description: 'x',
  source: 'rule',
  rule_id: 'x',
  priority_score: 9,
  confidence: 100,
  question_generated: false,
  merged_into: null,
  resolved_at: null,
  resolution_source: null,
  created_at: '2026-01-01T00:00:00Z',
  ...overrides,
})

describe('resolveGap', () => {
  it('returns gap with resolved_at set', () => {
    const resolved = resolveGap(makeGap(), 'question_answered')
    expect(resolved.resolved_at).not.toBeNull()
    expect(resolved.resolution_source).toBe('question_answered')
  })
})

describe('computeStatusFromScore', () => {
  it('returns incomplete when critical gaps remain unresolved', () => {
    const status = computeStatusFromScore([makeGap({ severity: 'critical', resolved_at: null })])
    expect(status).toBe('incomplete')
  })

  it('returns review_required when only major gaps remain unresolved', () => {
    const status = computeStatusFromScore([makeGap({ severity: 'major', resolved_at: null })])
    expect(status).toBe('review_required')
  })

  it('returns ready_for_dev when only minor gaps remain (minor does not block)', () => {
    const status = computeStatusFromScore([makeGap({ severity: 'minor', resolved_at: null })])
    expect(status).toBe('ready_for_dev')
  })

  it('returns ready_for_dev when all gaps are resolved', () => {
    const status = computeStatusFromScore([makeGap({ resolved_at: '2026-01-02T00:00:00Z' })])
    expect(status).toBe('ready_for_dev')
  })

  it('returns ready_for_dev when no gaps at all', () => {
    expect(computeStatusFromScore([])).toBe('ready_for_dev')
  })

  it('ignores merged gaps when computing status', () => {
    // A critical gap that is merged should not count
    const status = computeStatusFromScore([makeGap({ severity: 'critical', merged_into: 'other-gap-id' })])
    expect(status).toBe('ready_for_dev')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/lib/requirements/re-evaluator.test.ts
```
Expected: FAIL — module not found

- [ ] **Step 3: Implement re-evaluator**

Create `lib/requirements/re-evaluator.ts`:
```typescript
import type { Gap, RequirementStatus } from '@/lib/supabase/types'

export function resolveGap(
  gap: Gap,
  source: 'question_answered' | 'task_resolved' | 'decision_recorded'
): Gap {
  return {
    ...gap,
    resolved_at: new Date().toISOString(),
    resolution_source: source,
  }
}

/**
 * Compute requirement status from current gap state.
 * - incomplete: any unresolved critical gap (merged gaps are excluded)
 * - review_required: no critical, but unresolved major gaps
 * - ready_for_dev: no unresolved critical or major gaps (minor alone does not block)
 */
export function computeStatusFromScore(allGaps: Gap[]): RequirementStatus {
  const unresolved = allGaps.filter(g => g.resolved_at === null && g.merged_into === null)
  if (unresolved.some(g => g.severity === 'critical')) return 'incomplete'
  if (unresolved.some(g => g.severity === 'major')) return 'review_required'
  return 'ready_for_dev'
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/lib/requirements/re-evaluator.test.ts
```
Expected: All 6 tests PASS

- [ ] **Step 5: Commit**

```bash
git add lib/requirements/re-evaluator.ts tests/lib/requirements/re-evaluator.test.ts
git commit -m "feat: add re-evaluator (deterministic score + status recalculation)"
```

---

## Task 9: Pipeline Orchestrator

**Files:**
- Create: `lib/requirements/pipeline.ts`
- Create: `tests/lib/requirements/pipeline.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/lib/requirements/pipeline.test.ts`:
```typescript
import { describe, it, expect, vi } from 'vitest'
import { runPipeline } from '@/lib/requirements/pipeline'
import { MockAIProvider } from '@/lib/ai/adapters/mock'

/** Minimal Supabase client stub. Tracks inserts/updates for assertions. */
function makeDbStub() {
  const inserts: Record<string, unknown[]> = {}
  const updates: Record<string, unknown> = {}
  let statusValue = 'draft'

  const chainable = (table: string) => ({
    insert: (data: unknown) => {
      inserts[table] = inserts[table] ?? []
      ;(inserts[table] as unknown[]).push(data)
      return { select: () => ({ data: [{ id: 'fake-id' }], error: null }), data: [{ id: 'fake-id' }], error: null }
    },
    update: (data: unknown) => {
      updates[table] = data
      if (table === 'requirements' && typeof data === 'object' && data !== null && 'status' in data) {
        statusValue = (data as { status: string }).status
      }
      return {
        eq: () => ({ data: null, error: null }),
        in: () => ({ data: null, error: null }),
      }
    },
    delete: () => ({ eq: () => ({ data: null, error: null }) }),
    select: () => ({
      eq: () => ({
        single: () => ({ data: { raw_input: 'some text' }, error: null }),
        data: [],
        error: null,
      }),
      data: [],
      error: null,
    }),
  })

  const db = {
    from: (table: string) => chainable(table),
    auth: { getUser: async () => ({ data: { user: { id: 'user-1' } } }) },
    _inserts: inserts,
    _updates: updates,
    _getStatus: () => statusValue,
  }
  return db
}

describe('runPipeline', () => {
  it('returns success when all steps pass', async () => {
    const mock = new MockAIProvider()
    mock.setDefaultResponse(JSON.stringify({ items: [] }))
    const db = makeDbStub() as unknown as Parameters<typeof runPipeline>[3]
    const result = await runPipeline('req-1', 'some input', 'user-1', db, mock)
    expect(result.success).toBe(true)
    expect(result.steps.parse).toBe('ok')
  })

  it('returns failure when parse step throws', async () => {
    const mock = new MockAIProvider()
    mock.setDefaultResponse('not valid json at all')
    const db = makeDbStub() as unknown as Parameters<typeof runPipeline>[3]
    const result = await runPipeline('req-1', 'some input', 'user-1', db, mock)
    expect(result.success).toBe(false)
    expect(result.steps.parse).toBe('error')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/lib/requirements/pipeline.test.ts
```
Expected: FAIL — module not found

- [ ] **Step 3: Implement pipeline.ts**

Create `lib/requirements/pipeline.ts`:
```typescript
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
    parse: 'ok' | 'error'
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
  await db.from('audit_log').insert({ entity_type: entityType, entity_id: entityId, action, actor_id: actorId, diff })
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
  let allGaps: ReturnType<typeof computeScore> extends infer _ ? Awaited<ReturnType<typeof detectGaps>>['gaps'] : never
  let mergedPairs: Awaited<ReturnType<typeof detectGaps>>['mergedPairs']
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

      insertedGapIds = (inserted ?? []).map(g => g.id)

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
    allGaps = []
    mergedPairs = []
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
    // Continue — question failure does not abort scoring
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

    // Fetch fresh gaps from DB to compute status (includes resolved_at / merged_into from DB)
    const { data: freshGaps } = await db.from('gaps').select('*').eq('requirement_id', requirementId)
    const newStatus = computeStatusFromScore(freshGaps ?? [])
    await db.from('requirements').update({ status: newStatus, updated_at: new Date().toISOString() }).eq('id', requirementId)
    await writeAudit(db, 'requirements', requirementId, 'scored', actorId, { score: score.overall_score, status: newStatus })
    steps.score = 'ok'
  } catch (err) {
    await writeAudit(db, 'requirements', requirementId, 'updated', actorId, { step: 'score', error: String(err) })
    steps.score = 'error'
    return { success: false, steps, error: `Score failed: ${String(err)}` }
  }

  return { success: true, steps }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/lib/requirements/pipeline.test.ts
```
Expected: Both tests PASS

- [ ] **Step 5: Commit**

```bash
git add lib/requirements/pipeline.ts tests/lib/requirements/pipeline.test.ts
git commit -m "feat: add pipeline orchestrator (steps 1-6, merge resolution, partial failure handling)"
```

---

## Task 10: API Routes

**Files:**
- Create: `app/api/requirements/[id]/analyze/route.ts`
- Create: `app/api/requirements/[id]/status/route.ts`
- Create: `app/api/requirements/[id]/summary/route.ts`
- Create: `app/api/questions/[id]/route.ts`
- Create: `app/api/investigation-tasks/[id]/route.ts`
- Create: `tests/api/requirements/status.test.ts`

**Status gate rules (from spec):**
- `draft → analyzing` always allowed
- `analyzing → incomplete | review_required | ready_for_dev` (set by pipeline only)
- `incomplete → review_required | ready_for_dev | blocked`
- `review_required → ready_for_dev | blocked`
- `ready_for_dev → blocked`
- `blocked → any non-blocked state` (MVP: no ownership check required)
- `ready_for_dev` transition is blocked server-side if any unresolved critical **or major** gaps exist

- [ ] **Step 1: Write failing tests for status route**

Create `tests/api/requirements/status.test.ts`:
```typescript
import { describe, it, expect } from 'vitest'
import { validateStatusTransition, checkReadyForDevGate } from '@/lib/requirements/status-validator'

describe('validateStatusTransition', () => {
  it('allows draft → analyzing', () => {
    expect(validateStatusTransition('draft', 'analyzing')).toBe(true)
  })
  it('blocks draft → ready_for_dev', () => {
    expect(validateStatusTransition('draft', 'ready_for_dev')).toBe(false)
  })
  it('allows incomplete → review_required', () => {
    expect(validateStatusTransition('incomplete', 'review_required')).toBe(true)
  })
  it('allows incomplete → ready_for_dev', () => {
    expect(validateStatusTransition('incomplete', 'ready_for_dev')).toBe(true)
  })
  it('blocks draft → blocked', () => {
    // draft can only go to analyzing first
    expect(validateStatusTransition('draft', 'blocked')).toBe(false)
  })
  it('allows blocked → incomplete', () => {
    expect(validateStatusTransition('blocked', 'incomplete')).toBe(true)
  })
})

describe('checkReadyForDevGate', () => {
  it('blocks if critical gaps unresolved', () => {
    const gaps = [{ severity: 'critical', resolved_at: null, merged_into: null }]
    expect(checkReadyForDevGate(gaps)).toEqual({ blocked: true, reason: expect.stringContaining('critical') })
  })
  it('blocks if major gaps unresolved', () => {
    const gaps = [{ severity: 'major', resolved_at: null, merged_into: null }]
    expect(checkReadyForDevGate(gaps)).toEqual({ blocked: true, reason: expect.stringContaining('major') })
  })
  it('allows if only minor gaps unresolved', () => {
    const gaps = [{ severity: 'minor', resolved_at: null, merged_into: null }]
    expect(checkReadyForDevGate(gaps)).toEqual({ blocked: false })
  })
  it('allows if all gaps resolved', () => {
    const gaps = [{ severity: 'critical', resolved_at: '2026-01-01', merged_into: null }]
    expect(checkReadyForDevGate(gaps)).toEqual({ blocked: false })
  })
  it('ignores merged gaps', () => {
    const gaps = [{ severity: 'critical', resolved_at: null, merged_into: 'other-id' }]
    expect(checkReadyForDevGate(gaps)).toEqual({ blocked: false })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/api/requirements/status.test.ts
```
Expected: FAIL — module not found

- [ ] **Step 3: Implement status-validator (extracted for testability)**

Create `lib/requirements/status-validator.ts`:
```typescript
import type { RequirementStatus } from '@/lib/supabase/types'

const VALID_TRANSITIONS: Record<RequirementStatus, RequirementStatus[]> = {
  draft: ['analyzing'],
  analyzing: ['incomplete', 'review_required', 'ready_for_dev'],
  incomplete: ['review_required', 'ready_for_dev', 'blocked'],
  review_required: ['ready_for_dev', 'blocked'],
  ready_for_dev: ['blocked'],
  blocked: ['draft', 'analyzing', 'incomplete', 'review_required', 'ready_for_dev'],
}

export function validateStatusTransition(from: RequirementStatus, to: RequirementStatus): boolean {
  return (VALID_TRANSITIONS[from] ?? []).includes(to)
}

interface GapGateRow {
  severity: string
  resolved_at: string | null
  merged_into: string | null
}

export function checkReadyForDevGate(gaps: GapGateRow[]): { blocked: boolean; reason?: string } {
  const active = gaps.filter(g => g.resolved_at === null && g.merged_into === null)
  const critCount = active.filter(g => g.severity === 'critical').length
  const majorCount = active.filter(g => g.severity === 'major').length
  if (critCount > 0) return { blocked: true, reason: `${critCount} unresolved critical gap(s)` }
  if (majorCount > 0) return { blocked: true, reason: `${majorCount} unresolved major gap(s)` }
  return { blocked: false }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/api/requirements/status.test.ts
```
Expected: All 11 tests PASS

- [ ] **Step 5: Create analyze route**

Create `app/api/requirements/[id]/analyze/route.ts`:
```typescript
import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { getProvider } from '@/lib/ai/registry'
import { runPipeline } from '@/lib/requirements/pipeline'

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const db = createServerSupabaseClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: req } = await db.from('requirements').select('raw_input').eq('id', params.id).single()
  if (!req) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const ai = getProvider()
  const result = await runPipeline(params.id, req.raw_input, user.id, db, ai)
  return NextResponse.json(result, { status: result.success ? 200 : 422 })
}
```

- [ ] **Step 6: Create status route**

Create `app/api/requirements/[id]/status/route.ts`:
```typescript
import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { validateStatusTransition, checkReadyForDevGate } from '@/lib/requirements/status-validator'
import type { RequirementStatus } from '@/lib/supabase/types'

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const db = createServerSupabaseClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json()
  const newStatus: RequirementStatus = body.status
  const blockedReason: string | null = body.blocked_reason ?? null

  const { data: current } = await db.from('requirements').select('status').eq('id', params.id).single()
  if (!current) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  if (!validateStatusTransition(current.status as RequirementStatus, newStatus)) {
    return NextResponse.json(
      { error: `Cannot transition from ${current.status} to ${newStatus}` },
      { status: 409 }
    )
  }

  if (newStatus === 'ready_for_dev') {
    const { data: gaps } = await db
      .from('gaps')
      .select('severity, resolved_at, merged_into')
      .eq('requirement_id', params.id)
    const gate = checkReadyForDevGate(gaps ?? [])
    if (gate.blocked) {
      return NextResponse.json({ error: `Cannot mark ready_for_dev: ${gate.reason}` }, { status: 409 })
    }
  }

  await db.from('requirements').update({
    status: newStatus,
    blocked_reason: newStatus === 'blocked' ? blockedReason : null,
    updated_at: new Date().toISOString(),
  }).eq('id', params.id)

  await db.from('audit_log').insert({
    entity_type: 'requirements',
    entity_id: params.id,
    action: 'updated',
    actor_id: user.id,
    diff: { status: { from: current.status, to: newStatus } },
  })

  return NextResponse.json({ status: newStatus })
}
```

- [ ] **Step 7: Create summary route**

Create `app/api/requirements/[id]/summary/route.ts`:
```typescript
import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import type { RequirementSummary } from '@/lib/supabase/types'

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const db = createServerSupabaseClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const [{ data: req }, { data: latestScore }, { data: gaps }] = await Promise.all([
    db.from('requirements').select('status, blocked_reason').eq('id', params.id).single(),
    db.from('completeness_scores')
      .select('overall_score, completeness, nfr_score, confidence')
      .eq('requirement_id', params.id)
      .order('scored_at', { ascending: false })
      .limit(1)
      .single(),
    db.from('gaps').select('severity, resolved_at, merged_into').eq('requirement_id', params.id),
  ])

  if (!req) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const activeGaps = (gaps ?? []).filter(g => !g.resolved_at && !g.merged_into)
  const summary: RequirementSummary = {
    critical_count: activeGaps.filter(g => g.severity === 'critical').length,
    major_count: activeGaps.filter(g => g.severity === 'major').length,
    minor_count: activeGaps.filter(g => g.severity === 'minor').length,
    completeness: latestScore?.completeness ?? 0,
    confidence: latestScore?.confidence ?? 0,
    overall_score: latestScore?.overall_score ?? 0,
    status: req.status,
    blocked_reason: req.blocked_reason,
  }

  return NextResponse.json(summary)
}
```

- [ ] **Step 8: Create questions route (with partial re-evaluation)**

Create `app/api/questions/[id]/route.ts`:
```typescript
import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { getProvider } from '@/lib/ai/registry'
import { parseStructuredResponse } from '@/lib/ai/provider'
import { buildEvaluateAnswerPrompt, EVALUATE_ANSWER_SCHEMA } from '@/lib/ai/prompts/evaluate-answer'
import { computeScore } from '@/lib/requirements/scorer'
import { computeStatusFromScore } from '@/lib/requirements/re-evaluator'

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const db = createServerSupabaseClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json()
  const answer: string = body.answer

  const { data: question } = await db
    .from('questions')
    .select('*, gaps(description)')
    .eq('id', params.id)
    .single()
  if (!question) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const ai = getProvider()
  const gapDescription = (question.gaps as { description: string } | null)?.description ?? ''
  const prompt = buildEvaluateAnswerPrompt(gapDescription, question.question_text, answer)
  const raw = await ai.complete(prompt, { responseSchema: EVALUATE_ANSWER_SCHEMA })
  const evaluation = parseStructuredResponse<{ resolved: boolean; rationale: string }>(raw, EVALUATE_ANSWER_SCHEMA)

  await db.from('questions').update({ answer, status: 'answered', answered_at: new Date().toISOString() }).eq('id', params.id)

  if (evaluation.resolved) {
    await db.from('gaps').update({ resolved_at: new Date().toISOString(), resolution_source: 'question_answered' }).eq('id', question.gap_id)
  }

  // Partial re-evaluation
  const [{ data: allGaps }, { data: allItems }] = await Promise.all([
    db.from('gaps').select('*').eq('requirement_id', question.requirement_id),
    db.from('requirement_items').select('*').eq('requirement_id', question.requirement_id),
  ])

  const gapsForScoring = (allGaps ?? []).map(g => ({
    item_id: g.item_id, severity: g.severity, category: g.category,
    description: g.description, source: g.source, rule_id: g.rule_id,
    priority_score: g.priority_score, confidence: g.confidence, question_generated: g.question_generated,
  }))

  // All merged gaps come from DB merged_into field — pass empty set (DB already has real UUIDs)
  const score = computeScore(gapsForScoring, new Set(), allItems ?? [])
  await db.from('completeness_scores').insert({
    requirement_id: question.requirement_id,
    overall_score: score.overall_score, completeness: score.completeness,
    nfr_score: score.nfr_score, confidence: score.confidence,
    breakdown: score.breakdown, scored_at: new Date().toISOString(),
  })

  const newStatus = computeStatusFromScore(allGaps ?? [])
  await db.from('requirements').update({ status: newStatus, updated_at: new Date().toISOString() }).eq('id', question.requirement_id)
  await db.from('audit_log').insert({
    entity_type: 'questions', entity_id: params.id, action: 'updated',
    actor_id: user.id, diff: { answered: true, gap_resolved: evaluation.resolved },
  })

  return NextResponse.json({ resolved: evaluation.resolved, rationale: evaluation.rationale, new_status: newStatus })
}
```

- [ ] **Step 9: Create investigation-tasks route (with partial re-evaluation)**

Create `app/api/investigation-tasks/[id]/route.ts`:
```typescript
import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { computeScore } from '@/lib/requirements/scorer'
import { computeStatusFromScore } from '@/lib/requirements/re-evaluator'
import type { TaskStatus } from '@/lib/supabase/types'

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const db = createServerSupabaseClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json()
  const newStatus: TaskStatus = body.status

  const { data: task } = await db.from('investigation_tasks').select('*').eq('id', params.id).single()
  if (!task) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  await db.from('investigation_tasks').update({ status: newStatus }).eq('id', params.id)

  if (newStatus === 'resolved' && task.linked_gap_id) {
    await db.from('gaps').update({ resolved_at: new Date().toISOString(), resolution_source: 'task_resolved' }).eq('id', task.linked_gap_id)
  }

  const [{ data: allGaps }, { data: allItems }] = await Promise.all([
    db.from('gaps').select('*').eq('requirement_id', task.requirement_id),
    db.from('requirement_items').select('*').eq('requirement_id', task.requirement_id),
  ])

  const gapsForScoring = (allGaps ?? []).map(g => ({
    item_id: g.item_id, severity: g.severity, category: g.category,
    description: g.description, source: g.source, rule_id: g.rule_id,
    priority_score: g.priority_score, confidence: g.confidence, question_generated: g.question_generated,
  }))

  const score = computeScore(gapsForScoring, new Set(), allItems ?? [])
  await db.from('completeness_scores').insert({
    requirement_id: task.requirement_id,
    overall_score: score.overall_score, completeness: score.completeness,
    nfr_score: score.nfr_score, confidence: score.confidence,
    breakdown: score.breakdown, scored_at: new Date().toISOString(),
  })

  const newReqStatus = computeStatusFromScore(allGaps ?? [])
  await db.from('requirements').update({ status: newReqStatus, updated_at: new Date().toISOString() }).eq('id', task.requirement_id)
  await db.from('audit_log').insert({
    entity_type: 'investigation_tasks', entity_id: params.id, action: 'updated',
    actor_id: user.id, diff: { status: newStatus, gap_resolved: newStatus === 'resolved' && !!task.linked_gap_id },
  })

  return NextResponse.json({ status: newStatus, new_requirement_status: newReqStatus })
}
```

- [ ] **Step 10: Commit**

```bash
git add app/api/ lib/requirements/status-validator.ts tests/api/ lib/ai/prompts/evaluate-answer.ts
git commit -m "feat: add API routes (analyze, status, summary, questions, investigation-tasks)"
```

---

## Task 11: Knowledge Layer

**Files:**
- Create: `lib/requirements/knowledge/domain-classifier.ts`
- Create: `lib/requirements/knowledge/pattern-extractor.ts`
- Create: `lib/requirements/knowledge/resolution-extractor.ts`

The knowledge layer is asynchronous — it never blocks the main pipeline. `domain-classifier` runs at the start of analysis and writes to `domain_templates` if a template doesn't already exist. `pattern-extractor` and `resolution-extractor` fire after a gap resolves (called from the questions/tasks routes).

- [ ] **Step 1: Implement domain-classifier**

Create `lib/requirements/knowledge/domain-classifier.ts`:
```typescript
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AIProvider } from '@/lib/ai/provider'
import { parseStructuredResponse } from '@/lib/ai/provider'
import { buildClassifyDomainPrompt, CLASSIFY_DOMAIN_SCHEMA } from '@/lib/ai/prompts/classify-domain'

export async function classifyAndSeedDomain(
  projectId: string,
  rawInput: string,
  db: SupabaseClient,
  ai: AIProvider
): Promise<void> {
  try {
    const prompt = buildClassifyDomainPrompt(rawInput)
    const raw = await ai.complete(prompt, { responseSchema: CLASSIFY_DOMAIN_SCHEMA })
    const { domain, confidence } = parseStructuredResponse<{ domain: string; confidence: number }>(raw, CLASSIFY_DOMAIN_SCHEMA)

    if (confidence < 50) return // not confident enough to seed a template

    // Check if a template already exists for this project+domain
    const { data: existing } = await db
      .from('domain_templates')
      .select('id')
      .eq('project_id', projectId)
      .eq('domain', domain)
      .limit(1)

    if (!existing || existing.length === 0) {
      await db.from('domain_templates').insert({
        project_id: projectId,
        domain,
        name: `${domain} baseline`,
        requirement_areas: { functional: [], nfr: ['security', 'performance', 'auditability'] },
      })
    }
  } catch {
    // Async enrichment — never throw, never block the pipeline
  }
}
```

- [ ] **Step 2: Implement pattern-extractor**

Create `lib/requirements/knowledge/pattern-extractor.ts`:
```typescript
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Gap } from '@/lib/supabase/types'

/**
 * When a gap is resolved, record its category/severity as a gap_pattern.
 * Increments occurrence_count if an identical pattern exists; creates one otherwise.
 * Fire-and-forget — never throws.
 */
export async function extractGapPattern(
  gap: Gap,
  projectId: string | null,
  db: SupabaseClient
): Promise<void> {
  try {
    const { data: existing } = await db
      .from('gap_patterns')
      .select('id, occurrence_count')
      .eq('category', gap.category)
      .eq('severity', gap.severity)
      .eq('description_template', gap.description)
      .or(`project_id.eq.${projectId},project_id.is.null`)
      .limit(1)

    if (existing && existing.length > 0) {
      await db.from('gap_patterns').update({
        occurrence_count: existing[0].occurrence_count + 1,
        last_seen_at: new Date().toISOString(),
      }).eq('id', existing[0].id)
    } else {
      await db.from('gap_patterns').insert({
        project_id: projectId,
        category: gap.category,
        severity: gap.severity,
        description_template: gap.description,
        occurrence_count: 1,
        last_seen_at: new Date().toISOString(),
      })
    }
  } catch {
    // async enrichment — never throw
  }
}
```

- [ ] **Step 3: Implement resolution-extractor**

Create `lib/requirements/knowledge/resolution-extractor.ts`:
```typescript
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Gap, DecisionLog } from '@/lib/supabase/types'

/**
 * When a decision is recorded, distil it into a resolution_pattern linked to the gap_pattern.
 * Fire-and-forget — never throws.
 */
export async function extractResolutionPattern(
  gap: Gap,
  decision: DecisionLog,
  projectId: string | null,
  db: SupabaseClient
): Promise<void> {
  try {
    // Find the matching gap_pattern
    const { data: patterns } = await db
      .from('gap_patterns')
      .select('id')
      .eq('category', gap.category)
      .eq('severity', gap.severity)
      .or(`project_id.eq.${projectId},project_id.is.null`)
      .limit(1)

    if (!patterns || patterns.length === 0) return

    await db.from('resolution_patterns').insert({
      gap_pattern_id: patterns[0].id,
      project_id: projectId,
      resolution_summary: decision.rationale,
      source_decision_id: decision.id,
      use_count: 0,
    })
  } catch {
    // async enrichment — never throw
  }
}
```

- [ ] **Step 4: Wire domain-classifier into the analyze route**

Modify `app/api/requirements/[id]/analyze/route.ts` — add the classifier call after pipeline runs (fire-and-forget):
```typescript
// After: const result = await runPipeline(...)
// Add:
if (result.success) {
  const { data: project } = await db.from('requirements').select('project_id').eq('id', params.id).single()
  if (project?.project_id) {
    void classifyAndSeedDomain(project.project_id, req.raw_input, db, ai)
  }
}
```

Import at top of the file:
```typescript
import { classifyAndSeedDomain } from '@/lib/requirements/knowledge/domain-classifier'
```

- [ ] **Step 5: Commit**

```bash
git add lib/requirements/knowledge/ lib/ai/prompts/classify-domain.ts app/api/requirements/
git commit -m "feat: add knowledge layer (domain classifier, gap pattern, resolution pattern extraction)"
```

---

## Task 12: Final Verification

- [ ] **Step 1: Run full test suite**

```bash
npx vitest run --reporter=verbose
```
Expected: All tests PASS, no failures

- [ ] **Step 2: TypeScript clean build check**

```bash
npx tsc --noEmit
```
Expected: 0 errors

- [ ] **Step 3: Dev server starts**

```bash
npm run dev
```
Expected: Server starts on http://localhost:3000, no errors in terminal

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "feat: complete Plan B — core analysis pipeline"
```
