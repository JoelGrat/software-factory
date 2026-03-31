import { describe, it, expect, vi } from 'vitest'
import { detectMigrationRequirements, detectMigrationWithAIFallback } from '@/lib/impact/migration-detector'
import { MockAIProvider } from '@/lib/ai/adapters/mock'

describe('detectMigrationRequirements', () => {
  it('detects schema migration from multiple keyword matches', () => {
    const result = detectMigrationRequirements('Add a new column to the users table for last login')
    expect(result.requiresMigration).toBe(true)
    expect(result.confidence).toBe('high')
  })

  it('does not trigger on single keyword match', () => {
    const result = detectMigrationRequirements('Update the table component styling')
    expect(result.requiresMigration).toBe(false)
  })

  it('detects data migration from backfill keyword', () => {
    const result = detectMigrationRequirements('Backfill the new status field for all existing records')
    expect(result.requiresDataChange).toBe(true)
    expect(result.confidence).toBe('high')
  })

  it('returns low confidence with no matches', () => {
    const result = detectMigrationRequirements('Improve button hover animation')
    expect(result.requiresMigration).toBe(false)
    expect(result.requiresDataChange).toBe(false)
    expect(result.confidence).toBe('low')
  })

  it('detects rename column', () => {
    const result = detectMigrationRequirements('Rename the column email to email_address in users table')
    expect(result.requiresMigration).toBe(true)
  })
})

describe('detectMigrationWithAIFallback', () => {
  it('uses deterministic result when confidence is high', async () => {
    const ai = new MockAIProvider()
    const spy = vi.spyOn(ai, 'complete')
    const result = await detectMigrationWithAIFallback(
      'Add a column to the users table for last login',
      ['database'],
      ai
    )
    expect(result.requiresMigration).toBe(true)
    expect(spy).not.toHaveBeenCalled()
  })

  it('skips AI when no database component is involved', async () => {
    const ai = new MockAIProvider()
    const spy = vi.spyOn(ai, 'complete')
    const result = await detectMigrationWithAIFallback(
      'Improve button animation timing',
      ['ui', 'service'],
      ai
    )
    expect(result.requiresMigration).toBe(false)
    expect(spy).not.toHaveBeenCalled()
  })

  it('calls AI for ambiguous intent with database component', async () => {
    const ai = new MockAIProvider()
    ai.setResponse('requires_migration', JSON.stringify({ requires_migration: true, requires_data_change: false }))
    const result = await detectMigrationWithAIFallback(
      'Improve the user profile page performance',
      ['database'],
      ai
    )
    expect(ai.callCount).toBe(1)
    expect(result.requiresMigration).toBe(true)
    expect(result.requiresDataChange).toBe(false)
  })

  it('returns false if AI response cannot be parsed', async () => {
    const ai = new MockAIProvider()
    ai.setDefaultResponse('not valid json')
    const result = await detectMigrationWithAIFallback(
      'Do something with data',
      ['database'],
      ai
    )
    expect(result.requiresMigration).toBe(false)
    expect(result.requiresDataChange).toBe(false)
  })
})
