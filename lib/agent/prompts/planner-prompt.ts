import type { ParsedItem } from '@/lib/requirements/parser'

export const FILE_REQUEST_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    requested_files: { type: 'array', items: { type: 'string' } },
  },
  required: ['requested_files'],
}

export const PLANNER_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          description: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
          dependencies: { type: 'array', items: { type: 'string' } },
        },
        required: ['id', 'title', 'description', 'files', 'dependencies'],
      },
    },
    files_to_create: { type: 'array', items: { type: 'string' } },
    files_to_modify: { type: 'array', items: { type: 'string' } },
    test_approach: { type: 'string' },
    branch_name: { type: 'string' },
  },
  required: ['tasks', 'files_to_create', 'files_to_modify', 'test_approach', 'branch_name'],
}

export function buildFileRequestPrompt(requirements: ParsedItem[], fileTree: string[]): string {
  return `You are a software architect. You will plan implementation tasks for the requirements below.

First, identify which files from the project you need to read to make a good plan.
Return ONLY a JSON object with a "requested_files" array (relative paths). Max 20 files.

--- REQUIREMENTS ---
${requirements.map(r => `[${r.type.toUpperCase()}] ${r.title}: ${r.description}`).join('\n')}
--- END ---

--- FILE TREE ---
${fileTree.slice(0, 200).join('\n')}
--- END ---`
}

export function buildPlannerPrompt(requirements: ParsedItem[], fileTree: string[], fileContents: Record<string, string>): string {
  const filesSection = Object.entries(fileContents)
    .map(([fp, content]) => `=== ${fp} ===\n${content.slice(0, 2000)}`)
    .join('\n\n')

  return `You are a software architect. Create a detailed implementation plan for the requirements below.

Rules:
- tasks: ordered list of implementation tasks (each with unique id like "task-1")
- files_to_create: new files that will be created
- files_to_modify: existing files that will be changed
- test_approach: how tests will be written (one sentence per task type)
- branch_name: git branch name in format "sf/<6-char-req-id>-<short-slug>" e.g. "sf/abc123-add-auth"
- For every file created or modified, include a corresponding test file
- tasks must be ordered so dependencies come before dependents

Return ONLY valid JSON. No commentary.

--- REQUIREMENTS ---
${requirements.map(r => `[${r.type.toUpperCase()}] [${r.priority}] ${r.title}: ${r.description}`).join('\n')}
--- END ---

--- PROJECT TREE ---
${fileTree.slice(0, 200).join('\n')}
--- END ---

--- FILE CONTENTS ---
${filesSection}
--- END ---`
}
