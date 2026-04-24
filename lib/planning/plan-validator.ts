import type { ChangeSpec, DetailedPlan, PlannerDiagnostics } from './types'

export interface ValidationResult {
  passed: boolean
  diagnostics: PlannerDiagnostics
}

export function validateSpecInput(spec: ChangeSpec): ValidationResult {
  const issues: string[] = []

  if (!spec.problem?.trim()) issues.push('spec.problem is empty')
  if (!Array.isArray(spec.goals) || spec.goals.length === 0) issues.push('spec.goals is empty')
  if (!spec.architecture?.trim()) issues.push('spec.architecture is empty')
  if (!Array.isArray(spec.out_of_scope)) issues.push('spec.out_of_scope must be an array')

  return buildResult(issues)
}

export function validatePlanOutput(plan: DetailedPlan): ValidationResult {
  const issues: string[] = []
  let moreThanCap = false

  if (!plan.phases || plan.phases.length === 0) {
    issues.push('plan has no phases')
    return buildResult(issues)
  }

  const allTaskIds = new Set<string>()
  for (const phase of plan.phases) {
    for (const task of phase.tasks) {
      allTaskIds.add(task.id)
    }
  }

  for (const phase of plan.phases) {
    if (!phase.tasks || phase.tasks.length === 0) {
      if (issues.length < 10) {
        issues.push(`phase "${phase.id}" has no tasks`)
      } else {
        moreThanCap = true
        break
      }
      continue
    }

    for (const task of phase.tasks) {
      if (!task.substeps || task.substeps.length === 0) {
        if (issues.length < 10) {
          issues.push(`task "${task.id}" has no substeps`)
        } else {
          moreThanCap = true
          break
        }
      }

      if (moreThanCap) break

      const hasFiles = task.files?.length > 0
      const hasSubstepTarget = task.substeps?.some(s => s.command || s.target)
      if (!hasFiles && !hasSubstepTarget) {
        if (issues.length < 10) {
          issues.push(`task "${task.id}" has no actionable target (no files and no substep command/target)`)
        } else {
          moreThanCap = true
          break
        }
      }

      if (moreThanCap) break

      if (!task.validation || task.validation.length === 0) {
        if (issues.length < 10) {
          issues.push(`task "${task.id}" has no validation`)
        } else {
          moreThanCap = true
          break
        }
      }

      if (moreThanCap) break

      if (!task.expected_result?.trim()) {
        if (issues.length < 10) {
          issues.push(`task "${task.id}" has no expected_result`)
        } else {
          moreThanCap = true
          break
        }
      }

      if (moreThanCap) break

      if (!task.playbook) {
        if (issues.length < 10) {
          issues.push(`task "${task.id}" has no playbook`)
        } else {
          moreThanCap = true
          break
        }
      } else {
        if (!task.playbook.commit?.trim()) {
          if (issues.length < 10) {
            issues.push(`task "${task.id}" playbook.commit is empty`)
          } else {
            moreThanCap = true
            break
          }
        }
      }

      if (moreThanCap) break

      for (const dep of task.depends_on ?? []) {
        if (!allTaskIds.has(dep)) {
          if (issues.length < 10) {
            issues.push(`task "${task.id}" depends_on unknown task id "${dep}"`)
          } else {
            moreThanCap = true
            break
          }
        }
      }
    }

    if (moreThanCap) break
  }

  // Circular dependency check (DFS) - only if we haven't hit cap
  if (!moreThanCap && issues.length < 10) {
    const depMap = new Map<string, string[]>()
    for (const phase of plan.phases) {
      for (const task of phase.tasks) {
        depMap.set(task.id, task.depends_on ?? [])
      }
    }

    const visited = new Set<string>()
    const stack = new Set<string>()

    function hasCycle(id: string): boolean {
      visited.add(id)
      stack.add(id)
      for (const dep of depMap.get(id) ?? []) {
        if (stack.has(dep)) return true
        if (!visited.has(dep) && hasCycle(dep)) return true
      }
      stack.delete(id)
      return false
    }

    for (const id of allTaskIds) {
      if (!visited.has(id) && hasCycle(id)) {
        issues.push(`circular dependency detected involving task "${id}"`)
        break
      }
    }
  }

  return buildResult(issues, moreThanCap)
}

function buildResult(rawIssues: string[], moreThanCap = false): ValidationResult {
  const capped = rawIssues.slice(0, 10)
  const totalCount = moreThanCap ? rawIssues.length + 1 : rawIssues.length
  return {
    passed: rawIssues.length === 0,
    diagnostics: {
      summary: rawIssues.length === 0 ? 'all checks passed' : `${totalCount} issue(s) found`,
      issues: capped,
      truncated: rawIssues.length > 10 || moreThanCap,
    },
  }
}
