// lib/planning/risk-scorer.ts
import type { DetailedPlan } from './types'

export interface PlanRiskSignals {
  taskCount: number
  substepCount: number
  hasMigration: boolean
  driftRatio: number
  criticalSystemCount: number
  validationDensity: number
}

export interface PlanRiskScore {
  score: number
  riskLevel: 'low' | 'medium' | 'high'
  primarySignal: string
  signals: PlanRiskSignals
}

const CRITICAL_TASK_TYPES = new Set(['database', 'infra'])
const MIGRATION_COMMAND_PREFIXES = ['supabase db push', 'prisma migrate', 'knex migrate']
const MIGRATION_PATH = /(?:migrations?\/|\.sql$)/i

/**
 * Scores plan complexity and drift against the component graph.
 * driftRatio = indirect_impact_count / direct_seed_count from change_impacts.
 */
export function scoreFromPlan(plan: DetailedPlan, driftRatio: number): PlanRiskScore {
  const allTasks = plan.phases.flatMap(p => p.tasks)
  const taskCount = allTasks.length
  const substepCount = allTasks.reduce((sum, t) => sum + (t.substeps?.length ?? 0), 0)
  const validationCount = allTasks.reduce((sum, t) => sum + (t.validation?.length ?? 0), 0)
  const validationDensity = taskCount > 0 ? validationCount / taskCount : 0
  const criticalSystemCount = allTasks.filter(t => CRITICAL_TASK_TYPES.has(t.type)).length

  const hasMigration = allTasks.some(t =>
    t.substeps?.some(s => s.command && MIGRATION_COMMAND_PREFIXES.some(p => s.command!.startsWith(p))) ||
    t.files?.some(f => MIGRATION_PATH.test(f))
  )

  let score = 0
  let primarySignal = 'none'
  let primaryScore = 0

  function addSignal(name: string, points: number) {
    score += points
    if (points > primaryScore) { primaryScore = points; primarySignal = name }
  }

  if (taskCount > 10) addSignal('high_task_count', Math.min((taskCount - 10) * 2, 10))
  if (substepCount > 30) addSignal('high_substep_count', Math.min(substepCount - 30, 8))
  if (hasMigration) addSignal('migration', 6)
  if (criticalSystemCount > 0) addSignal('critical_systems', criticalSystemCount * 3)
  if (driftRatio > 5) addSignal('high_drift', Math.min(Math.floor(driftRatio), 10))
  if (validationDensity < 1) addSignal('weak_validation', 4)

  const riskLevel: 'low' | 'medium' | 'high' = score < 10 ? 'low' : score < 20 ? 'medium' : 'high'

  return {
    score,
    riskLevel,
    primarySignal,
    signals: { taskCount, substepCount, hasMigration, driftRatio, criticalSystemCount, validationDensity },
  }
}
