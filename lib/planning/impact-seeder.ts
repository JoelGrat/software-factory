// lib/planning/impact-seeder.ts
import type { DetailedPlan, PlanSeeds } from './types'

const MIGRATION_COMMANDS = ['supabase db push', 'supabase migration', 'prisma migrate', 'knex migrate']
const MIGRATION_PATH = /(?:migrations?\/|\.sql$)/i

export function extractPlanSeeds(plan: DetailedPlan): PlanSeeds {
  const filePathSet = new Set<string>()
  const componentHintSet = new Set<string>()
  const commandSet = new Set<string>()
  let hasMigration = false

  for (const phase of plan.phases) {
    for (const task of phase.tasks) {
      // Explicit file paths from task.files
      for (const f of task.files ?? []) {
        filePathSet.add(f)
        if (MIGRATION_PATH.test(f)) hasMigration = true
      }

      // Task type as component hint
      componentHintSet.add(task.type)

      // Substep targets and commands
      for (const step of task.substeps ?? []) {
        if (step.target) {
          filePathSet.add(step.target)
          if (MIGRATION_PATH.test(step.target)) hasMigration = true
        }
        if (step.command) {
          commandSet.add(step.command)
          if (MIGRATION_COMMANDS.some(c => step.command!.startsWith(c))) hasMigration = true
        }
      }

      // Validation commands
      for (const v of task.validation ?? []) {
        if (v.type === 'command') commandSet.add(v.command)
      }
    }
  }

  return {
    filePaths: Array.from(filePathSet),
    componentHints: Array.from(componentHintSet),
    hasMigration,
    commands: Array.from(commandSet),
  }
}
