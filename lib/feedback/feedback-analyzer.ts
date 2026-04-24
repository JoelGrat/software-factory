import type { AIProvider } from '@/lib/ai/provider'

export interface TaskInput {
  id: string
  order_index: number
  description: string
  dependencies: string[]
}

export interface TaskSuggestion {
  taskId: string
  confidence: 'high' | 'medium' | 'low'
  explanation: string
}

export interface AnalyzeFeedbackResult {
  suggestions: TaskSuggestion[]
  lowConfidence: boolean
}

const RESPONSE_SCHEMA = {
  type: 'object',
  required: ['suggestions', 'lowConfidence'],
  additionalProperties: false,
  properties: {
    suggestions: {
      type: 'array',
      items: {
        type: 'object',
        required: ['taskId', 'confidence', 'explanation'],
        additionalProperties: false,
        properties: {
          taskId:      { type: 'string' },
          confidence:  { type: 'string', enum: ['high', 'medium', 'low'] },
          explanation: { type: 'string' },
        },
      },
    },
    lowConfidence: { type: 'boolean' },
  },
}

export async function analyzeFeedback(
  feedback: string,
  tasks: TaskInput[],
  ai: AIProvider,
): Promise<AnalyzeFeedbackResult> {
  const taskList = tasks
    .map(t => `Task ${t.order_index + 1} [id: ${t.id}]: ${t.description}`)
    .join('\n')

  const prompt = `You are reviewing the output of an AI-driven code execution system.
A human reviewer has written feedback about what was implemented incorrectly.
Your job is to identify which tasks from the execution plan need to be re-run to address the feedback.

## Reviewer Feedback
${feedback}

## Executed Task List
${taskList}

## Instructions
- Read the feedback carefully and match it to the tasks that are responsible.
- Only select tasks that are directly implied by the feedback.
- Do NOT select tasks that are clearly unrelated (e.g. backend tasks when feedback is purely about UI copy).
- For each selected task provide:
  - taskId: the exact id string from the task list
  - confidence: "high" (clearly mentioned), "medium" (implied), or "low" (uncertain)
  - explanation: one sentence explaining why this task was selected
- If you cannot confidently map the feedback to any tasks, set lowConfidence: true and return an empty suggestions array.
- Return valid JSON matching the schema. Use only taskIds that appear in the task list above.`

  const result = await ai.complete(prompt, {
    responseSchema: RESPONSE_SCHEMA,
    temperature: 0,
    maxTokens: 1024,
  })

  const parsed = JSON.parse(result.content) as AnalyzeFeedbackResult
  const validIds = new Set(tasks.map(t => t.id))

  return {
    suggestions: parsed.suggestions.filter(s => validIds.has(s.taskId)),
    lowConfidence: parsed.lowConfidence ?? false,
  }
}
