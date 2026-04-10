// lib/planning/task-validator.ts

export interface ValidatableTask {
  componentId: string | null
  componentName: string
  newFilePath?: string | null
  description: string
  orderIndex: number
}

export interface ImpactedComponentForValidation {
  componentId: string
  weight: number
}

export interface ValidationResult {
  passed: boolean
  errors: string[]
  warnings: string[]
}

const ACTION_VERB_BUCKETS: Array<[RegExp, string]> = [
  [/\b(test|spec|assert)\b/i, 'test'],
  [/\b(verify|check|validate)\b/i, 'verify'],
  [/\b(create|scaffold|generate)\b/i, 'create'],
  [/\b(delete|remove|drop)\b/i, 'delete'],
]

function normalizeActionType(description: string): string {
  for (const [re, bucket] of ACTION_VERB_BUCKETS) {
    if (re.test(description)) return bucket
  }
  return 'implement'
}

function taskKey(task: ValidatableTask): string {
  const action = normalizeActionType(task.description)
  const comp = task.componentId ?? 'null'
  const file = task.newFilePath ?? 'null'
  return `${comp}:${action}:${file}`
}

export function validateTasks(
  tasks: ValidatableTask[],
  impactedComponents: ImpactedComponentForValidation[],
  _knownFileIds: Set<string>,
  plannedNewFilePaths: Set<string>
): ValidationResult {
  const errors: string[] = []
  const warnings: string[] = []

  if (tasks.length === 0) {
    return { passed: false, errors: ['Plan has no tasks — empty task list is not valid'], warnings: [] }
  }

  // Orphan tasks
  for (const task of tasks) {
    if (!task.componentId && !task.newFilePath) {
      errors.push(`Orphan task: "${task.description}" has no component or new file path`)
    }
  }

  // Deduplication by (componentId, actionType, newFilePath)
  const seen = new Set<string>()
  for (const task of tasks) {
    const key = taskKey(task)
    if (seen.has(key)) {
      errors.push(`Duplicate task: "${task.description}" (same component + action type + file)`)
    }
    seen.add(key)
  }

  // Coverage: top 3 or 80% of total weight
  if (impactedComponents.length > 0) {
    const totalWeight = impactedComponents.reduce((sum, c) => sum + c.weight, 0)
    const sorted = [...impactedComponents].sort((a, b) => b.weight - a.weight)
    const top3Ids = new Set(sorted.slice(0, 3).map(c => c.componentId))
    const taskCompIds = new Set(tasks.map(t => t.componentId).filter(Boolean) as string[])

    const coversTop3 = [...top3Ids].every(id => taskCompIds.has(id))

    let coveredWeight = 0
    for (const comp of impactedComponents) {
      if (taskCompIds.has(comp.componentId)) coveredWeight += comp.weight
    }
    const coveragePct = totalWeight > 0 ? coveredWeight / totalWeight : 1

    if (!coversTop3 && coveragePct < 0.8) {
      errors.push(
        `Insufficient coverage: tasks cover ${Math.round(coveragePct * 100)}% of impact weight. ` +
        `Must cover top 3 components or ≥80% of total weight.`
      )
    }
  }

  // Test task quality: must have componentId + file path matching spec/test pattern
  const TEST_FILE_RE = /spec|test|\.test\.|\.spec\./i
  const hasQualityTest = tasks.some(t => {
    if (normalizeActionType(t.description) !== 'test') return false
    if (!t.componentId) return false
    const filePath = t.newFilePath ?? t.description
    return TEST_FILE_RE.test(filePath)
  })
  if (!hasQualityTest) {
    errors.push('No valid test task found — must reference a component and a spec/test file (e.g. "Add tests for AuthService in auth.service.spec.ts")')
  }

  // Consistency: unknown component refs
  const validIds = new Set(impactedComponents.map(c => c.componentId))
  let unknownRefs = 0
  for (const task of tasks) {
    if (task.componentId && !validIds.has(task.componentId)) {
      unknownRefs++
      if (unknownRefs === 1) {
        warnings.push(`Task references component not in impact analysis: "${task.componentId}" — verify this is intentional`)
      }
    }
  }
  if (unknownRefs > 1) {
    errors.push(`${unknownRefs} tasks reference components not in impact analysis — likely hallucinated. Retry with explicit component list.`)
  }

  return { passed: errors.length === 0, errors, warnings }
}
