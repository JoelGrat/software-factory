// lib/agent/prompts/vision.ts
// TODO: replaced in Plan 2/3/4 — old types removed in migration 006
/* eslint-disable @typescript-eslint/no-explicit-any */
// import type { ProjectVision } from '@/lib/supabase/types' // removed in migration 006

export function buildVisionPrompt(vision: any): string {
  const content = vision.mode === 'free_form'
    ? vision.free_form_text
    : [
        vision.goal         && `Goal: ${vision.goal}`,
        vision.tech_stack   && `Tech Stack: ${vision.tech_stack}`,
        vision.target_users && `Target Users: ${vision.target_users}`,
        vision.key_features && `Key Features:\n${vision.key_features}`,
        vision.constraints  && `Constraints: ${vision.constraints}`,
      ].filter(Boolean).join('\n\n')

  return `You are a senior requirements analyst. Analyse the following project description and generate a comprehensive, structured list of software requirements.

Output each requirement as a separate JSON object on its own line (NDJSON — one object per line, no array wrapper, no commas between objects). Each object must have exactly these fields:
- "type": one of "functional", "non-functional", "constraint", "assumption"
- "title": short title, max 10 words
- "description": 1-2 sentence explanation of the requirement
- "priority": one of "high", "medium", "low"

No prose, no markdown, no explanation — only the NDJSON lines. Generate 8-20 requirements covering functional features, non-functional quality attributes (performance, security, scalability), constraints, and key assumptions.

PROJECT DESCRIPTION:
${content}`
}

export const VISION_SYSTEM_PROMPT =
  'You are a senior requirements analyst. Output one JSON object per line (NDJSON). No prose, no markdown, no array wrapper.'
