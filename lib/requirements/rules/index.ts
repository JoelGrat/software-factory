// lib/requirements/rules/index.ts
import type { ParsedItem } from '@/lib/requirements/parser'
import type { RequirementDomain } from '@/lib/supabase/types'

// Existing core rules (unchanged location)
import { hasActorsDefined }             from './has-actors-defined'
import { hasApprovalRole }              from './has-approval-role'
import { hasWorkflowStates }            from './has-workflow-states'
import { hasNonFunctionalRequirements } from './has-nfrs'
import { hasErrorHandling }             from './has-error-handling'
// New core rules
import { hasDataModelDefined }          from './core/has-data-model'
import { hasInputOutputContracts }      from './core/has-input-output-contracts'
import { hasEdgeCasesCovered }          from './core/has-edge-cases-covered'
import { hasPermissionsMatrix }         from './core/has-permissions-matrix'
import { hasExternalDependenciesDefined } from './core/has-external-dependencies'
// Domain packs
import { hasBillingDefined }            from './saas/has-billing-defined'
import { hasMultiTenancyAddressed }     from './saas/has-multi-tenancy-addressed'
import { hasAuthStrategyDefined }       from './saas/has-auth-strategy-defined'
import { hasComplianceRequirements }    from './fintech/has-compliance-requirements'
import { hasAuditTrailDefined }         from './fintech/has-audit-trail-defined'
import { hasReconciliationDefined }     from './fintech/has-reconciliation-defined'
import { hasRollbackDefined }           from './workflow/has-rollback-defined'
import { hasIdempotencyAddressed }      from './workflow/has-idempotency-addressed'
import { hasRetryStrategyDefined }      from './workflow/has-retry-strategy-defined'

export interface RuleCheck {
  id: string
  check: (items: ParsedItem[]) => boolean
  severity: 'critical' | 'major' | 'minor'
  category: 'missing'
  description: string
}

const CORE_RULES: RuleCheck[] = [
  { id: 'hasActorsDefined',             check: hasActorsDefined,             severity: 'critical', category: 'missing', description: 'No user roles or system actors are defined.' },
  { id: 'hasApprovalRole',              check: hasApprovalRole,              severity: 'critical', category: 'missing', description: 'No approval or sign-off role is defined.' },
  { id: 'hasWorkflowStates',            check: hasWorkflowStates,            severity: 'critical', category: 'missing', description: 'No system states or status transitions are defined.' },
  { id: 'hasNonFunctionalRequirements', check: hasNonFunctionalRequirements, severity: 'major',    category: 'missing', description: 'No non-functional requirements are specified.' },
  { id: 'hasErrorHandling',             check: hasErrorHandling,             severity: 'major',    category: 'missing', description: 'No error handling or failure scenarios are addressed.' },
  { id: 'hasDataModelDefined',          check: hasDataModelDefined,          severity: 'major',    category: 'missing', description: 'No data entities or data structures are defined.' },
  { id: 'hasInputOutputContracts',      check: hasInputOutputContracts,      severity: 'major',    category: 'missing', description: 'No inputs, outputs, or API contracts are defined.' },
  { id: 'hasEdgeCasesCovered',          check: hasEdgeCasesCovered,          severity: 'minor',    category: 'missing', description: 'No boundary or edge-case behaviour is addressed.' },
  { id: 'hasPermissionsMatrix',         check: hasPermissionsMatrix,         severity: 'major',    category: 'missing', description: 'No access control or permissions are defined.' },
  { id: 'hasExternalDependenciesDefined', check: hasExternalDependenciesDefined, severity: 'major', category: 'missing', description: 'External system mentioned without a defined contract.' },
]

const SAAS_RULES: RuleCheck[] = [
  { id: 'hasBillingDefined',        check: hasBillingDefined,        severity: 'critical', category: 'missing', description: 'No billing, pricing, or subscription items defined.' },
  { id: 'hasMultiTenancyAddressed', check: hasMultiTenancyAddressed, severity: 'major',    category: 'missing', description: 'Multi-tenancy or tenant isolation is not addressed.' },
  { id: 'hasAuthStrategyDefined',   check: hasAuthStrategyDefined,   severity: 'critical', category: 'missing', description: 'No authentication or session handling strategy defined.' },
]

const FINTECH_RULES: RuleCheck[] = [
  { id: 'hasComplianceRequirements', check: hasComplianceRequirements, severity: 'critical', category: 'missing', description: 'No regulatory or compliance requirements defined.' },
  { id: 'hasAuditTrailDefined',      check: hasAuditTrailDefined,      severity: 'critical', category: 'missing', description: 'No audit trail or transaction log defined.' },
  { id: 'hasReconciliationDefined',  check: hasReconciliationDefined,  severity: 'major',    category: 'missing', description: 'No reconciliation or balance check process defined.' },
]

const WORKFLOW_RULES: RuleCheck[] = [
  { id: 'hasRollbackDefined',       check: hasRollbackDefined,       severity: 'major', category: 'missing', description: 'No rollback or compensation defined for failed transitions.' },
  { id: 'hasIdempotencyAddressed',  check: hasIdempotencyAddressed,  severity: 'major', category: 'missing', description: 'No duplicate handling or idempotency strategy defined.' },
  { id: 'hasRetryStrategyDefined',  check: hasRetryStrategyDefined,  severity: 'major', category: 'missing', description: 'No retry behaviour defined for failures.' },
]

export function selectRulePack(domain: RequirementDomain | null): RuleCheck[] {
  switch (domain) {
    case 'saas':     return [...CORE_RULES, ...SAAS_RULES]
    case 'fintech':  return [...CORE_RULES, ...FINTECH_RULES]
    case 'workflow': return [...CORE_RULES, ...WORKFLOW_RULES]
    default:         return CORE_RULES
  }
}
