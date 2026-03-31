import type { SupabaseClient } from '@supabase/supabase-js'
import type { AIProvider } from '@/lib/ai/provider'
import type { RiskFactors } from './types'
import { mapComponents } from './component-mapper'
import { runFileBFS } from './file-bfs'
import { aggregateComponents } from './component-aggregator'
import { computeRiskScore } from './risk-scorer'
import { detectMigrationWithAIFallback } from './migration-detector'

interface ComponentDetail {
  id: string
  name: string
  type: string
  has_unknown_dependencies: boolean
  avg_confidence: number | null
}

const MAX_IMPACT_COMPONENTS = 20

export async function runImpactAnalysis(
  changeId: string,
  db: SupabaseClient,
  ai: AIProvider
): Promise<void> {
  await db.from('change_requests').update({ status: 'analyzing_mapping' }).eq('id', changeId)

  try {
    // Load change
    const { data: change } = await db
      .from('change_requests')
      .select('id, project_id, title, intent, tags')
      .eq('id', changeId)
      .single()

    if (!change) throw new Error(`Change not found: ${changeId}`)

    // Phase 1: Component Mapping
    const mapResult = await mapComponents(changeId, change, db, ai)

    await db.from('change_requests').update({ status: 'analyzing_propagation' }).eq('id', changeId)

    // Phase 2a: Fetch file-level edges + assignments (skip if no seed files)
    const { data: edges } = mapResult.seedFileIds.length > 0
      ? await db
          .from('component_graph_edges')
          .select('from_file_id, to_file_id, edge_type')
          .eq('project_id', change.project_id)
      : { data: [] }

    const { data: assignments } = mapResult.seedFileIds.length > 0
      ? await db
          .from('component_assignment')
          .select('file_id, component_id')
          .eq('project_id', change.project_id)
      : { data: [] }

    // Phase 2b: File BFS
    const seeds = mapResult.seedFileIds.map(fileId => ({ fileId, reason: 'component_match' as const }))
    const bfsResult = runFileBFS(seeds, edges ?? [])

    // Phase 2c: Aggregate to components
    const componentWeights = aggregateComponents(bfsResult, assignments ?? [], mapResult.components)

    // Fetch component details for risk scoring
    const componentIds = componentWeights.map(c => c.componentId)
    const { data: componentDetails } = componentIds.length > 0
      ? await db
          .from('system_components')
          .select('id, name, type, has_unknown_dependencies, avg_confidence')
          .in('id', componentIds) as { data: ComponentDetail[] | null }
      : { data: [] as ComponentDetail[] }

    await db.from('change_requests').update({ status: 'analyzing_scoring' }).eq('id', changeId)

    // Phase 3: Risk Scoring
    const types = (componentDetails ?? []).map((c) => c.type)
    const riskFactors: RiskFactors = {
      blastRadius: componentWeights.filter(c => c.weight > 0.3).length,
      unknownDepsCount: (componentDetails ?? []).filter((c) => c.has_unknown_dependencies).length,
      hasLowConfidenceComponents: (componentDetails ?? []).some((c) => (c.avg_confidence ?? 100) < 60),
      componentTypes: types,
      dynamicImportCount: Object.values(bfsResult.dynamicImportCounts).reduce((a, b) => a + b, 0),
    }
    const riskResult = computeRiskScore(riskFactors, componentWeights)

    // Phase 4: Migration Detection
    const migrationResult = await detectMigrationWithAIFallback(change.intent, types, ai)

    // Write change_impacts
    const { data: impact, error: impactError } = await db
      .from('change_impacts')
      .insert({
        change_id: changeId,
        project_id: change.project_id,
        risk_score: riskResult.score,
        blast_radius: riskFactors.blastRadius,
        primary_risk_factor: riskResult.primaryRiskFactor,
        analysis_quality: mapResult.aiUsed ? 'ai_assisted' : 'heuristic',
        requires_migration: migrationResult.requiresMigration,
        requires_data_change: migrationResult.requiresDataChange,
      })
      .select('id')
      .single()

    if (impactError) throw impactError
    if (!impact) throw new Error('Failed to insert change_impacts')

    // Write risk factors
    const riskFactorRows = Object.entries(riskResult.confidenceBreakdown).map(([factor, weight]) => ({
      change_id: changeId,
      impact_id: impact.id,
      factor,
      weight,
    }))
    if (riskFactorRows.length > 0) {
      await db.from('change_risk_factors').insert(riskFactorRows)
    }

    // Write impact components (top MAX_IMPACT_COMPONENTS)
    const componentRows = componentWeights.slice(0, MAX_IMPACT_COMPONENTS).map(c => ({
      impact_id: impact.id,
      change_id: changeId,
      component_id: c.componentId,
      impact_weight: c.weight,
      source: c.source,
      source_detail: c.sourceDetail,
    }))
    if (componentRows.length > 0) {
      await db.from('change_impact_components').insert(componentRows)
    }

    // Final status update
    const unknownRatio = componentWeights.length > 0
      ? riskFactors.unknownDepsCount / componentWeights.length
      : 0
    const confidence_score = Math.max(Math.round(100 - unknownRatio * 40 - (mapResult.aiUsed ? 10 : 0)), 20)

    await db.from('change_requests').update({
      status: 'analyzed',
      risk_level: riskResult.riskLevel,
      confidence_score,
      confidence_breakdown: riskResult.confidenceBreakdown,
      analysis_quality: mapResult.aiUsed ? 'ai_assisted' : 'heuristic',
    }).eq('id', changeId)

  } catch (err) {
    await db.from('change_requests').update({ status: 'open' }).eq('id', changeId)
    throw err
  }
}
