// lib/agent/prompts/vision.ts
import type { ProjectVision } from '@/lib/supabase/types'

export function buildVisionPrompt(vision: ProjectVision): string {
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

Return ONLY a JSON array of requirement objects. No prose, no markdown, no explanation — just the JSON array. Each object must have exactly these fields:
- "type": one of "functional", "non-functional", "constraint", "assumption"
- "title": short title, max 10 words
- "description": 1-2 sentence explanation of the requirement
- "priority": one of "high", "medium", "low"

Generate 8-20 requirements covering functional features, non-functional quality attributes (performance, security, scalability), constraints, and key assumptions. Be specific and actionable.

PROJECT DESCRIPTION:
${content}`
}

export const VISION_SYSTEM_PROMPT =
  'You are a senior requirements analyst. Return only valid JSON arrays. No prose, no markdown.'
