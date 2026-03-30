import { describe, it, expect, expectTypeOf } from 'vitest'
import type {
  Project, ProjectFile, SystemComponent, ComponentAssignment,
  ChangeRequest, ChangeImpact, ChangeImpactComponent,
  ChangePlan, ExecutionSnapshot, ProductionEvent,
  ChangeType, ChangeStatus, RiskLevel, AnalysisQuality,
} from '@/lib/supabase/types'

describe('Project type', () => {
  it('has required fields', () => {
    const p: Project = {
      id: 'uuid', name: 'test', owner_id: 'uuid',
      repo_url: null, repo_token: null,
      scan_status: 'pending', scan_error: null,
      lock_version: 0, created_at: '',
    }
    expectTypeOf(p.scan_status).toMatchTypeOf<'pending' | 'scanning' | 'ready' | 'failed'>()
  })
})

describe('SystemComponent type', () => {
  it('has required fields including scan_count and is_anchored', () => {
    const sc: SystemComponent = {
      id: 'uuid', project_id: 'uuid', name: 'auth',
      type: 'service', exposed_interfaces: [],
      status: 'stable', is_anchored: false,
      scan_count: 0, last_updated: '', deleted_at: null,
    }
    expectTypeOf(sc.type).toMatchTypeOf<'service' | 'module' | 'api' | 'db' | 'ui'>()
    expectTypeOf(sc.status).toMatchTypeOf<'stable' | 'unstable'>()
  })
})

describe('ComponentAssignment type', () => {
  it('allows null component_id for unassigned files', () => {
    const a: ComponentAssignment = {
      file_id: 'uuid', component_id: null,
      confidence: 0, is_primary: true,
      status: 'unassigned', reassignment_count: 0,
      last_validated_at: '', last_moved_at: '',
    }
    expectTypeOf(a.component_id).toMatchTypeOf<string | null>()
  })
})

describe('ChangeRequest type', () => {
  it('covers all status values', () => {
    const statuses: ChangeStatus[] = [
      'open','analyzing','analyzing_mapping','analyzing_propagation',
      'analyzing_scoring','analyzed','planned','executing','review','done','failed',
    ]
    expect(statuses).toHaveLength(11)
  })

  it('covers all change types', () => {
    const types: ChangeType[] = ['bug','feature','refactor','hotfix']
    expect(types).toHaveLength(4)
  })
})

describe('ChangeImpact type', () => {
  it('has blast_radius and risk_score as numbers', () => {
    const ci: ChangeImpact = {
      id: 'uuid', change_id: 'uuid',
      risk_score: 12.5, blast_radius: 4.2,
      primary_risk_factor: 'touches_auth',
      analysis_quality: 'high',
      requires_migration: false, requires_data_change: false,
    }
    expectTypeOf(ci.analysis_quality).toMatchTypeOf<AnalysisQuality>()
    expectTypeOf(ci.risk_score).toBeNumber()
  })
})

describe('ChangeImpactComponent type', () => {
  it('has source field with correct values', () => {
    const c: ChangeImpactComponent = {
      impact_id: 'uuid', component_id: 'uuid',
      impact_weight: 0.7,
      source: 'via_dependency',
      source_detail: 'auth-service',
    }
    expectTypeOf(c.source).toMatchTypeOf<'directly_mapped' | 'via_dependency' | 'via_file'>()
  })
})

describe('ExecutionSnapshot type', () => {
  it('has termination_reason', () => {
    const s: ExecutionSnapshot = {
      id: 'uuid', change_id: 'uuid', iteration: 1,
      files_modified: [], tests_run: [],
      tests_passed: 3, tests_failed: 0,
      error_summary: null, diff_summary: null,
      duration_ms: 4200, retry_count: 0,
      ai_cost: 0.012, environment: 'local',
      termination_reason: 'passed',
    }
    expectTypeOf(s.termination_reason).toMatchTypeOf<
      'passed' | 'max_iterations' | 'cancelled' | 'error' | null
    >()
  })
})

describe('ProductionEvent type', () => {
  it('has severity field', () => {
    const e: ProductionEvent = {
      id: 'uuid', project_id: 'uuid',
      type: 'error', source: 'sentry',
      severity: 'critical', payload: {},
      created_at: '',
    }
    expectTypeOf(e.severity).toMatchTypeOf<'low' | 'high' | 'critical'>()
  })
})
