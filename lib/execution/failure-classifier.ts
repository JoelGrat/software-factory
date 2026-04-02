import type { FailureType } from './types'

export const FAILURE_PRIORITY: Record<FailureType, number> = {
  syntax:  1,
  type:    2,
  runtime: 3,
  test:    4,
  timeout: 0,
}

const CLASSIFIERS: Array<{ pattern: RegExp; type: FailureType }> = [
  { pattern: /timed out/i,                                          type: 'timeout' },
  { pattern: /error TS1\d{3}:/,                                     type: 'syntax'  },
  { pattern: /error TS[2-9]\d{3}:/,                                 type: 'type'    },
  { pattern: /\bFAIL\b.*\.test\.|● .+ ›|\bAssertionError\b/,       type: 'test'    },
]

export function classifyFailure(output: string): FailureType {
  for (const { pattern, type } of CLASSIFIERS) {
    if (pattern.test(output)) return type
  }
  return 'runtime'
}

export function highestPriority(types: FailureType[]): FailureType {
  if (types.length === 0) return 'runtime'
  return types.reduce((a, b) =>
    FAILURE_PRIORITY[a] <= FAILURE_PRIORITY[b] ? a : b
  )
}
