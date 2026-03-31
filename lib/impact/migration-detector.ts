import type { AIProvider } from '@/lib/ai/provider'

const DB_MIGRATION_PATTERNS = [
  /\bschema\b/i,
  /\btable\b/i,
  /\bcolumn\b/i,
  /\bmigration\b/i,
  /\badd.*field\b/i,
  /\bremove.*field\b/i,
  /\brename.*column\b/i,
  /\bdrop.*table\b/i,
  /\bcreate.*table\b/i,
]

const DATA_CHANGE_PATTERNS = [
  /\bbackfill\b/i,
  /\bdata\s+migration\b/i,
  /\bexisting.*data\b/i,
  /\bupdate.*all.*records\b/i,
  /\bpopulate.*records\b/i,
]

export function detectMigrationRequirements(intent: string): {
  requiresMigration: boolean
  requiresDataChange: boolean
  confidence: 'high' | 'low'
} {
  const migrationMatches = DB_MIGRATION_PATTERNS.filter(p => p.test(intent)).length
  const dataMatches = DATA_CHANGE_PATTERNS.filter(p => p.test(intent)).length
  const requiresMigration = migrationMatches >= 2
  const requiresDataChange = dataMatches >= 1
  const confidence = (requiresMigration || requiresDataChange) ? 'high' : 'low'
  return { requiresMigration, requiresDataChange, confidence }
}

export async function detectMigrationWithAIFallback(
  intent: string,
  componentTypes: string[],
  ai: AIProvider
): Promise<{ requiresMigration: boolean; requiresDataChange: boolean }> {
  const deterministic = detectMigrationRequirements(intent)
  if (deterministic.confidence === 'high') {
    return {
      requiresMigration: deterministic.requiresMigration,
      requiresDataChange: deterministic.requiresDataChange,
    }
  }

  const hasDataComponent = componentTypes.some(t => t === 'database' || t === 'repository')
  if (!hasDataComponent) return { requiresMigration: false, requiresDataChange: false }

  const result = await ai.complete(
    `Does this software change require a database schema migration or data migration?\n\nIntent: ${intent}\n\nRespond with JSON: {"requires_migration": boolean, "requires_data_change": boolean}`,
    {
      responseSchema: {
        type: 'object',
        properties: {
          requires_migration: { type: 'boolean' },
          requires_data_change: { type: 'boolean' },
        },
        required: ['requires_migration', 'requires_data_change'],
      },
      maxTokens: 100,
    }
  )

  try {
    const parsed = JSON.parse(result.content)
    return {
      requiresMigration: !!parsed.requires_migration,
      requiresDataChange: !!parsed.requires_data_change,
    }
  } catch {
    return { requiresMigration: false, requiresDataChange: false }
  }
}
