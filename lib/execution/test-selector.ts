import type { SupabaseClient } from '@supabase/supabase-js'
import type { TestScope } from './types'

export async function selectTests(
  db: SupabaseClient,
  changedFileIds: string[],
  riskLevel: string
): Promise<TestScope> {
  if (changedFileIds.length === 0) {
    return { directTests: [], dependentTests: [], widened: false }
  }

  const { data } = await db
    .from('test_coverage_map')
    .select('test_path')
    .in('file_id', changedFileIds)

  const testPaths = [...new Set((data ?? []).map((r: { test_path: string }) => r.test_path))]
  const widened = riskLevel === 'high'

  return {
    directTests: testPaths,
    dependentTests: [],
    widened,
  }
}
