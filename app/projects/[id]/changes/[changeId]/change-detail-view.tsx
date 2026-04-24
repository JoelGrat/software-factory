'use client'
import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { LeftNav } from '@/components/app/left-nav'
import { ProfileAvatar } from '@/components/app/profile-avatar'
import { ChangeStepBar } from '@/components/app/change-step-bar'

interface Project { id: string; name: string }

interface ImpactData {
  id: string
  risk_score: number | null
  blast_radius: number | null
  primary_risk_factor: string | null
  analysis_quality: string | null
  requires_migration: boolean | null
  requires_data_change: boolean | null
}

interface RiskFactor {
  factor: string
  weight: number
}

interface ImpactComponent {
  component_id: string
  impact_weight: number
  source: string
  source_detail: string | null
  system_components: { name: string; type: string } | null
}

interface PlanPhaseTask {
  id: string
  title: string
  type: string
  files: string[]
  expected_result: string
}

interface PlanPhase {
  id: string
  title: string
  tasks: PlanPhaseTask[]
}

interface PlanJson {
  goal: string
  phases: PlanPhase[]
}

interface PlanData {
  id: string
  status: string
  estimated_tasks: number | null
  branch_name: string | null
  plan_quality_score: number | null
  plan_json: PlanJson | null
  approved_at: string | null
}

interface PlanTask {
  id: string
  component_id: string | null
  description: string
  order_index: number
  status: string
  system_components: { name: string; type: string } | null
}

interface Change {
  id: string
  project_id: string
  title: string
  intent: string
  type: string
  priority: string
  status: string
  pipeline_status: string | null
  risk_level: string | null
  confidence_score: number | null
  analysis_quality: string | null
  failed_stage: string | null
  retryable: boolean | null
  failure_diagnostics: { summary: string; issues: string[] } | null
  tags: string[]
  created_at: string
  updated_at: string
}

const TYPE_COLORS: Record<string, string> = {
  bug: 'text-red-400 bg-red-400/10',
  feature: 'text-indigo-400 bg-indigo-400/10',
  refactor: 'text-amber-400 bg-amber-400/10',
  hotfix: 'text-orange-400 bg-orange-400/10',
}
const RISK_COLORS: Record<string, string> = {
  low: 'text-green-400 bg-green-400/10',
  medium: 'text-amber-400 bg-amber-400/10',
  high: 'text-red-400 bg-red-400/10',
}

/** Map pipeline_status → which tab should be auto-active during pipeline execution. */
function getPipelineAutoTab(status: string | null): 'spec' | 'plan' | 'tasks' | 'review' | null {
  if (!status) return null
  if (['validated', 'planning', 'spec_loading_context', 'spec_inferring_components',
       'spec_inferring_files', 'spec_generating_canonical', 'spec_validating'].includes(status)) return 'spec'
  if (['spec_generated', 'plan_generating', 'plan_creating_phases',
       'plan_validating', 'plan_finalizing'].includes(status)) return 'plan'
  if (['plan_generated', 'impact_analyzing', 'impact_analyzed', 'scoring'].includes(status)) return 'tasks'
  if (status === 'scored') return 'review'
  return null
}

function getAllPlanTasks(planJson: PlanJson | null | undefined): PlanPhaseTask[] {
  if (!planJson) return []
  return planJson.phases.flatMap(p => p.tasks)
}

const ANALYZING_STATUSES = ['analyzing', 'analyzing_mapping', 'analyzing_propagation', 'analyzing_scoring', 'planning']
const PIPELINE_IN_PROGRESS_STATUSES = [
  'validated', 'planning',
  'spec_generating', 'spec_loading_context', 'spec_inferring_components', 'spec_inferring_files',
  'spec_generating_canonical', 'spec_validating', 'spec_generated',
  'plan_generating', 'plan_creating_phases', 'plan_validating', 'plan_finalizing', 'plan_generated',
  'impact_analyzing', 'impact_analyzed',
  'scoring', 'scored',
]

interface PipelineSubstep {
  label: string
  status: string
}

interface PipelineStageConfig {
  label: string
  /** All pipeline_status values that mean this stage is active (including substeps). */
  activeStatuses: string[]
  /** The pipeline_status that means this stage just finished. */
  doneStatus: string
  substeps: PipelineSubstep[]
}

const PIPELINE_STAGES: PipelineStageConfig[] = [
  {
    label: 'Generating specification',
    activeStatuses: [
      'validated', 'planning',
      'spec_generating', 'spec_loading_context', 'spec_inferring_components',
      'spec_inferring_files', 'spec_generating_canonical', 'spec_validating',
    ],
    doneStatus: 'spec_generated',
    substeps: [
      { label: 'Load project context',       status: 'spec_loading_context' },
      { label: 'Infer candidate components', status: 'spec_inferring_components' },
      { label: 'Infer likely files',         status: 'spec_inferring_files' },
      { label: 'Generate canonical spec',    status: 'spec_generating_canonical' },
      { label: 'Validate output',            status: 'spec_validating' },
    ],
  },
  {
    label: 'Building execution plan',
    activeStatuses: ['plan_generating', 'plan_creating_phases', 'plan_validating', 'plan_finalizing'],
    doneStatus: 'plan_generated',
    substeps: [
      { label: 'Create phases and tasks',  status: 'plan_creating_phases' },
      { label: 'Validate dependencies',    status: 'plan_validating' },
      { label: 'Finalize plan',            status: 'plan_finalizing' },
    ],
  },
  {
    label: 'Analyzing impact',
    activeStatuses: ['impact_analyzing'],
    doneStatus: 'impact_analyzed',
    substeps: [
      { label: 'Map intent to components', status: 'impact_analyzing' },
    ],
  },
  {
    label: 'Scoring risk',
    activeStatuses: ['scoring'],
    doneStatus: 'scored',
    substeps: [
      { label: 'Compute risk score', status: 'scoring' },
    ],
  },
]

/**
 * Within an active stage, return the index of the currently running substep.
 * Returns -1 if the stage is active but no specific substep has been reached yet.
 */
function activeSubstepIndex(stageIndex: number, pipelineStatus: string | null): number {
  if (!pipelineStatus) return -1
  const stage = PIPELINE_STAGES[stageIndex]
  if (!stage) return -1
  return stage.substeps.findIndex(s => s.status === pipelineStatus)
}


function Badge({ label, colorClass }: { label: string; colorClass: string }) {
  return (
    <span className={`text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded font-mono ${colorClass}`}>
      {label}
    </span>
  )
}

export function ChangeDetailView({
  project,
  change: initial,
  impact: initialImpact,
  riskFactors: initialRiskFactors,
  impactComponents: initialImpactComponents,
  plan: initialPlan,
  planTasks: initialPlanTasks,
  componentFileMap: initialComponentFileMap = {},
  specMarkdown: initialSpecMarkdown = null,
}: {
  project: Project
  change: Change
  impact: ImpactData | null
  riskFactors: RiskFactor[]
  impactComponents: ImpactComponent[]
  plan: PlanData | null
  planTasks: PlanTask[]
  componentFileMap?: Record<string, string[]>
  specMarkdown?: string | null
}) {
  const router = useRouter()
  const [change, setChange] = useState(initial)
  const [impact, setImpact] = useState(initialImpact)
  const [riskFactors, setRiskFactors] = useState(initialRiskFactors)
  const [impactComponents, setImpactComponents] = useState(initialImpactComponents)
  const [plan, setPlan] = useState(initialPlan)
  const [planTasks, setPlanTasks] = useState(initialPlanTasks)
  const [componentFileMap] = useState(initialComponentFileMap)
  const [specMarkdown, setSpecMarkdown] = useState<string | null>(initialSpecMarkdown)
  const [planTab, setPlanTab] = useState<'spec' | 'plan' | 'tasks' | 'review'>(
    () => getPipelineAutoTab(initial.pipeline_status) ?? 'spec'
  )
  const [planView, setPlanView] = useState<'structured' | 'json'>('structured')
  const [visibleTaskCount, setVisibleTaskCount] = useState(() => getAllPlanTasks(initialPlan?.plan_json).length)
  const prevPlanIdRef = useRef(initialPlan?.id ?? null)
  const [approving, setApproving] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [addingTestTask, setAddingTestTask] = useState<string | null>(null)
  const [addedCoverageItems, setAddedCoverageItems] = useState<Set<string>>(new Set())
  const [addingRiskTask, setAddingRiskTask] = useState<string | null>(null)
  const [addedRiskItems, setAddedRiskItems] = useState<Set<string>>(new Set())
  const [toast, setToast] = useState<string | null>(null)
  const [generatingSpec, setGeneratingSpec] = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [pipelineStatus, setPipelineStatus] = useState(initial.pipeline_status)
  const isAnalyzing = ANALYZING_STATUSES.includes(change.status) || PIPELINE_IN_PROGRESS_STATUSES.includes(change.pipeline_status ?? '')
  const canDelete = change.status !== 'done'

  // Impact analysis derived display values
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const RISK_MAX = 40
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const impactScore = impact?.risk_score ?? 0
  const confidence = change.confidence_score ?? 0
  const aiUsed = impact?.analysis_quality === 'medium'
  const unknownDepsFactor = riskFactors.find(f => f.factor === 'unknown_deps')
  const lowConfFactor = riskFactors.find(f => f.factor === 'low_confidence')
  const confidenceReasons: string[] = []
  if (aiUsed) confidenceReasons.push('AI-assisted mapping (−10%)')
  if (unknownDepsFactor) confidenceReasons.push(`${unknownDepsFactor.weight / 2} component(s) with unresolved dependencies`)
  if (lowConfFactor) confidenceReasons.push('Low-confidence component matches detected')
  if (confidenceReasons.length === 0) confidenceReasons.push('All components matched by keyword search')
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const confBarColor = confidence >= 80 ? 'bg-green-500' : confidence >= 60 ? 'bg-amber-500' : 'bg-red-500'
  const confTextColor = confidence >= 80 ? 'text-green-400' : confidence >= 60 ? 'text-amber-400' : 'text-red-400'
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const FACTOR_META: Record<string, { label: string; desc: string }> = {
    blast_radius: { label: 'Blast radius', desc: 'Significantly impacted components (weight > 30%)' },
    unknown_deps: { label: 'Unknown dependencies', desc: 'Components with unresolved import chains' },
    low_confidence: { label: 'Low-confidence matches', desc: 'Components with < 60% mapping confidence' },
    auth_component: { label: 'Auth component touched', desc: 'Changes to authentication carry inherent risk' },
    data_component: { label: 'Data layer involved', desc: 'Database or repository component affected' },
    dynamic_imports: { label: 'Dynamic imports', desc: 'Lazy-loaded modules may cascade unpredictably' },
  }
  const directComponents = impactComponents.filter(ic => ic.source === 'directly_mapped')
  const propagatedComponents = impactComponents.filter(ic => ic.source === 'via_file')
  const confidenceLabel = confidence >= 80 ? 'HIGH' : confidence >= 60 ? 'MEDIUM' : 'LOW'
  const riskLabel = (change.risk_level ?? 'low').toUpperCase()
  const recommendation =
    change.risk_level === 'high' && confidence < 60 ? 'REVIEW BEFORE PLANNING' :
    change.risk_level === 'high' || change.risk_level === 'medium' ? 'PROCEED WITH CAUTION' :
    'SAFE TO PLAN'
  const recColor =
    recommendation === 'REVIEW BEFORE PLANNING' ? 'text-red-400' :
    recommendation === 'PROCEED WITH CAUTION' ? 'text-amber-400' :
    'text-green-400'
  const topDrivers = riskFactors.slice(0, 3)
  const CRITICAL_TYPES = ['auth', 'db', 'database', 'payment', 'security', 'session']

  // Descriptive driver text — uses actual component names where available
  const driverDescriptions: string[] = topDrivers.map(rf => {
    switch (rf.factor) {
      case 'blast_radius': {
        const topComp = directComponents[0]?.system_components?.name
        return topComp
          ? `${topComp} change propagates to ${impact?.blast_radius ?? '?'} upstream component(s)`
          : `${impact?.blast_radius ?? '?'} component(s) in blast radius`
      }
      case 'auth_component': {
        const auth = directComponents.find(ic => ic.system_components?.type === 'auth')
        return auth
          ? `${auth.system_components!.name} (auth) directly affected — high blast radius`
          : 'Auth component touched — carries inherent risk'
      }
      case 'data_component': {
        const data = directComponents.find(ic => ['db', 'database', 'repository'].includes(ic.system_components?.type ?? ''))
        return data
          ? `${data.system_components!.name} (${data.system_components!.type}) in scope — migration risk`
          : 'Data layer involved — migration risk'
      }
      case 'unknown_deps':
        return `${Math.ceil(rf.weight / 2)} component(s) with unresolved dependency chains`
      case 'dynamic_imports':
        return `${rf.weight} dynamic import(s) — lazy-loaded modules may cascade unpredictably`
      case 'low_confidence':
        return 'Some component matches have low confidence — plan may have gaps'
      default:
        return rf.factor.replace(/_/g, ' ')
    }
  })

  // Unknowns: specific components or patterns that could break planning
  const unknownItems: string[] = []
  if (riskFactors.find(f => f.factor === 'dynamic_imports')) {
    const dynComp = propagatedComponents.find(ic => ic.source_detail?.includes('dynamic'))
    unknownItems.push(dynComp
      ? `Dynamic import via ${dynComp.system_components?.name ?? 'unknown'} may hide dependencies`
      : 'Dynamic imports present — lazy-loaded modules not traversed in analysis')
  }
  for (const ic of propagatedComponents.filter(ic => CRITICAL_TYPES.includes(ic.system_components?.type ?? '') && ic.impact_weight < 0.5).slice(0, 2)) {
    unknownItems.push(`${ic.system_components?.name ?? 'Component'} inferred via file graph (${Math.round(ic.impact_weight * 100)}%) — no direct integration context`)
  }
  if (riskFactors.find(f => f.factor === 'low_confidence')) {
    const lowConf = directComponents.find(ic => ic.impact_weight < 0.6)
    if (lowConf) unknownItems.push(`${lowConf.system_components?.name ?? 'A component'} matched with low confidence — verify it's correct`)
  }

  // Plan Gaps: high-weight propagated components in critical domains not guaranteed to be planned
  const planGaps: string[] = []
  for (const ic of propagatedComponents.filter(ic => ic.impact_weight >= 0.5 && CRITICAL_TYPES.includes(ic.system_components?.type ?? '')).slice(0, 2)) {
    planGaps.push(`${ic.system_components?.name} propagated at ${Math.round(ic.impact_weight * 100)}% — verify plan explicitly covers it`)
  }
  if (impact?.requires_migration) planGaps.push('Schema migration required — ensure plan includes a migration step')
  if (impact?.requires_data_change) planGaps.push('Data migration required — plan must account for data transforms')

  const criticalDomains = [...new Set(
    impactComponents
      .filter(ic => ic.impact_weight >= 0.4)
      .map(ic => ic.system_components?.type)
      .filter(Boolean)
  )]

  // ── Post-plan review derived data ─────────────────────────────────────────
  const reviewAllFiles = [...new Set(planTasks.flatMap(t => componentFileMap[t.component_id ?? ''] ?? []))]
  const reviewNewFileCount = Math.max(0, (null ?? reviewAllFiles.length) - reviewAllFiles.length)

  // Reverse map: file → ImpactComponent
  const fileToImpact = new Map<string, ImpactComponent>()
  for (const task of planTasks) {
    const ic = impactComponents.find(c => c.component_id === task.component_id)
    if (ic) {
      for (const file of componentFileMap[task.component_id ?? ''] ?? []) {
        if (!fileToImpact.has(file)) fileToImpact.set(file, ic)
      }
    }
  }

  // Per-file risk: derive from path + component type + weight
  function fileRiskLevel(filePath: string, compType: string | undefined, weight: number): 'LOW' | 'MEDIUM' | 'HIGH' {
    const p = filePath.toLowerCase()
    if (p.includes('auth') || compType === 'auth') return 'HIGH'
    if (p.includes('route') || p.includes('router') || p.includes('nav') || p.includes('sidebar')) return 'MEDIUM'
    if (weight > 0.6) return 'MEDIUM'
    return 'LOW'
  }
  function fileRiskNote(filePath: string, compType: string | undefined, isNew: boolean): string {
    const p = filePath.toLowerCase()
    if (isNew) return 'No existing dependencies — isolated new code'
    if (p.includes('route') || p.includes('router')) return 'Route registration — param mismatches cause silent broken links'
    if (p.includes('sidebar') || p.includes('nav') || p.includes('menu')) return 'Navigation target change — active state logic may fail on nested routes'
    if (p.includes('auth') || compType === 'auth') return 'Auth-touching file — verify route guards on all new pages'
    if (p.includes('test') || p.includes('spec')) return 'Test file — no runtime impact'
    if (p.includes('page') || p.includes('view') || p.includes('screen')) return 'UI component — isolated, no backend impact'
    if (compType === 'db' || compType === 'database') return 'Data layer — verify schema compatibility'
    return 'Shared component — verify no unintended callers'
  }

  // Verdict notes — 2 contextual lines based on what's actually in scope
  const reviewCompTypes = [...new Set(impactComponents.map(ic => ic.system_components?.type).filter(Boolean))]
  const reviewVerdictNotes: string[] = []
  const hasRouting = reviewAllFiles.some(f => /route|router/i.test(f))
  const hasNav = reviewAllFiles.some(f => /sidebar|nav|menu/i.test(f))
  const hasAuthComp = reviewCompTypes.includes('auth')
  const hasDataComp = reviewCompTypes.some(t => ['db', 'database', 'repository'].includes(t ?? ''))
  const allUI = reviewCompTypes.length > 0 && reviewCompTypes.every(t => ['ui', 'page', 'component', 'view'].includes(t ?? ''))
  if (allUI && !hasAuthComp && !hasDataComp) reviewVerdictNotes.push('Changes isolated to UI layer — no backend or shared domain logic affected')
  if (hasRouting || hasNav) reviewVerdictNotes.push('Routing and navigation changes — risk is in param passing and active state, not data correctness')
  if (hasAuthComp) reviewVerdictNotes.push('Auth component in scope — ensure all new routes have appropriate guards')
  if (hasDataComp) reviewVerdictNotes.push('Data layer involved — verify schema compatibility')
  if (reviewVerdictNotes.length === 0) reviewVerdictNotes.push('Scope appears contained — verify no cross-domain dependencies were missed')

  // Hidden risks — specific, derived from actual file paths + task descriptions
  const hiddenRisks: string[] = []
  const taskDescs = planTasks.map(t => t.description.toLowerCase())
  if (hasRouting && (hasNav || taskDescs.some(d => /param|:id|props/i.test(d)))) {
    hiddenRisks.push('Route param mismatch — verify the correct param (e.g. :projectId) is passed through every route definition and consumed correctly')
  } else if (hasRouting) {
    hiddenRisks.push('Route registration may silently succeed but link to wrong component — test direct URL access, not just in-app navigation')
  }
  if (hasNav && hasRouting) {
    hiddenRisks.push('Sidebar/nav active state detection may fail for new nested routes — check active matching logic against the new route shape')
  }
  if (hasAuthComp || reviewAllFiles.some(f => /guard|middleware/i.test(f))) {
    hiddenRisks.push('Missing route guard on new page allows unauthenticated access — confirm guard is applied at route level, not just in the component')
  }
  if (impact?.requires_migration) {
    hiddenRisks.push('Schema migration required — if migration fails mid-deploy, new code runs against old schema and may crash silently')
  }
  if (riskFactors.find(f => f.factor === 'dynamic_imports')) {
    hiddenRisks.push('Dynamic imports in propagation graph — lazy-loaded modules not fully traversed, actual blast radius may be wider than reported')
  }

  // Coverage gaps — scan task descriptions for test coverage quality
  const testTasks = planTasks.filter(t => /test|spec/i.test(t.description))
  const coveredItems: string[] = []
  const missingItems: string[] = []
  if (testTasks.some(t => /render|mount|display|shows?/i.test(t.description))) coveredItems.push('Component rendering covered')
  if (testTasks.some(t => /navigat|click|link|route/i.test(t.description))) coveredItems.push('Navigation behavior covered')
  if (!testTasks.some(t => /invalid|not.?found|error|404|missing/i.test(t.description))) {
    missingItems.push(`Invalid ${hasRouting ? 'route param' : 'ID'} handling (e.g. missing or malformed ID)`)
  }
  if (!testTasks.some(t => /direct|url|bookmark|deep.?link/i.test(t.description))) {
    missingItems.push('Direct URL access without in-app navigation — state may not be initialized correctly')
  }

  // Plan quality — structural observations
  const qualityStrengths: string[] = []
  const qualityGaps: string[] = []
  const uniquePlanComponents = new Set(planTasks.map(t => t.component_id).filter(Boolean))
  if (uniquePlanComponents.size > 1) qualityStrengths.push('Good separation of concerns — tasks mapped to distinct components')
  if (planTasks.length <= 8 && (impact?.blast_radius ?? 0) <= 4) qualityStrengths.push('Contained scope — low blast radius, manageable task count')
  if (!reviewAllFiles.some((_, i) => i > reviewAllFiles.length * 0.8)) qualityStrengths.push('No unnecessary file spread — change is well-contained')
  if (impact?.requires_migration && !taskDescs.some(d => /migrat/i.test(d))) {
    qualityGaps.push('Migration flagged by analysis but no migration task in plan — either the flag is a false positive, or the plan has a gap')
  }
  if (!taskDescs.some(d => /error|empty|fallback|not.?found/i.test(d))) {
    qualityGaps.push('No explicit error or empty-state handling task — new pages/routes need graceful failure paths')
  }
  if (planTasks.length > 12) {
    qualityGaps.push(`${planTasks.length} tasks is high for this blast radius — check for over-splitting artificial steps`)
  }

  async function handleDelete() {
    setDeleting(true)
    try {
      const res = await fetch(`/api/change-requests/${change.id}`, { method: 'DELETE' })
      if (res.ok) {
        router.push(`/projects/${project.id}`)
        router.refresh()
      }
    } finally {
      setDeleting(false)
      setDeleteConfirm(false)
    }
  }

  useEffect(() => {
    if (!isAnalyzing) return
    const id = setInterval(async () => {
      const res = await fetch(`/api/change-requests/${change.id}`)
      if (!res.ok) return
      const updated = await res.json()
      setChange(updated)
      setPipelineStatus(updated.pipeline_status ?? null)
      // Pick up spec_markdown as soon as it arrives
      if (updated.spec_markdown) setSpecMarkdown(updated.spec_markdown)
      // Pick up plan_json for stagger animation even before pipeline finishes
      if (updated.plan) setPlan(updated.plan)

      if (!ANALYZING_STATUSES.includes(updated.status) && !PIPELINE_IN_PROGRESS_STATUSES.includes(updated.pipeline_status ?? '')) {
        clearInterval(id)
        setImpact(updated.impact ?? null)
        setRiskFactors(updated.risk_factors ?? [])
        setImpactComponents(updated.impact_components ?? [])
        setPlan(updated.plan ?? null)
        setPlanTasks(updated.plan_tasks ?? [])
        router.refresh()
      }
    }, 2000)
    return () => clearInterval(id)
  }, [change.id, isAnalyzing, router])

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 3000)
    return () => clearTimeout(t)
  }, [toast])

  // Auto-switch tab to match current pipeline stage
  useEffect(() => {
    if (!isAnalyzing) return
    const auto = getPipelineAutoTab(pipelineStatus)
    if (auto) setPlanTab(auto)
  }, [pipelineStatus, isAnalyzing])

  // Stagger tasks in when a new plan's plan_json first arrives
  useEffect(() => {
    if (!plan?.id || !plan?.plan_json) return
    if (plan.id === prevPlanIdRef.current) return   // same plan — already staggered or loaded on mount
    prevPlanIdRef.current = plan.id
    const allTasks = getAllPlanTasks(plan.plan_json)
    if (allTasks.length === 0) return
    setVisibleTaskCount(0)
    let count = 0
    const timer = setInterval(() => {
      count++
      setVisibleTaskCount(count)
      if (count >= allTasks.length) {
        clearInterval(timer)
        setTimeout(() => setPlanTab('review'), 800)
      }
    }, 120)
    return () => clearInterval(timer)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan?.id, plan?.plan_json])

  return (
    <div className="flex flex-col h-screen bg-[#0b1326] text-on-surface overflow-hidden">
      <header className="w-full h-16 flex-shrink-0 flex items-center justify-between px-6 bg-[#0b1326] border-b border-white/5 z-50 font-headline antialiased tracking-tight">
        <div className="flex items-center gap-2 text-sm">
          <Link href="/projects" className="font-black text-indigo-400 tracking-tighter hover:text-indigo-300 transition-colors">FactoryOS</Link>
          <span className="text-slate-600">/</span>
          <Link href={`/projects/${project.id}`} className="text-slate-400 hover:text-slate-200 transition-colors font-medium truncate max-w-[160px]">{project.name}</Link>
          <span className="text-slate-600">/</span>
          <span className="text-slate-200 font-medium truncate max-w-[200px]">{change.title}</span>
        </div>
        <div className="flex items-center gap-1">
          <Link href="/settings" className="p-2 text-slate-400 hover:text-slate-200 hover:bg-[#171f33] rounded-lg transition-all" title="Settings">
            <span className="material-symbols-outlined" style={{ fontSize: '20px' }}>settings</span>
          </Link>
          <div className="w-px h-5 bg-white/10 mx-1" />
          <ProfileAvatar />
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        <LeftNav />
        <main className="flex-1 overflow-y-auto bg-[#0b1326] p-10">
          <div className="max-w-3xl mx-auto space-y-8">
            <ChangeStepBar projectId={project.id} changeId={change.id} current="plan" changeStatus={change.status} />

            {/* Header */}
            <div className="space-y-1.5">
              {/* Title + badges */}
              <div className="flex items-start justify-between gap-4">
                <h1 className="text-2xl font-extrabold tracking-tight text-on-surface leading-snug">{change.title}</h1>
                <div className="flex items-center gap-2 flex-shrink-0 pt-0.5">
                  <Badge label={change.type} colorClass={TYPE_COLORS[change.type] ?? 'text-slate-400 bg-slate-400/10'} />
                  {change.risk_level && <Badge label={`${change.risk_level} risk`} colorClass={RISK_COLORS[change.risk_level] ?? 'text-slate-400 bg-slate-400/10'} />}
                  {canDelete && (
                    deleteConfirm ? (
                      <div className="flex items-center gap-2 ml-1">
                        <span className="text-xs text-slate-400">Delete?</span>
                        <button onClick={handleDelete} disabled={deleting} className="text-xs font-semibold text-red-400 hover:text-red-300 disabled:opacity-50 transition-colors">
                          {deleting ? 'Deleting…' : 'Yes'}
                        </button>
                        <button onClick={() => setDeleteConfirm(false)} className="text-xs text-slate-500 hover:text-slate-300 transition-colors">No</button>
                      </div>
                    ) : (
                      <button onClick={() => setDeleteConfirm(true)} className="p-1 text-slate-700 hover:text-red-400 hover:bg-red-400/10 rounded-lg transition-all" title="Delete change">
                        <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>delete</span>
                      </button>
                    )
                  )}
                </div>
              </div>
              {/* Summary */}
              <p className="text-xs text-slate-500 font-mono">
                {change.priority} priority · created {new Date(change.created_at).toLocaleDateString('en-GB')}
                {(change.tags?.length ?? 0) > 0 && ` · ${change.tags!.join(', ')}`}
              </p>
            </div>

            {/* Intent */}
            <div className="rounded-xl p-5 bg-[#131b2e] border border-white/5">
              <p className="text-xs font-bold uppercase tracking-widest text-slate-400 font-headline mb-2">Intent</p>
              <p className="text-sm text-slate-300 leading-relaxed whitespace-pre-wrap">{change.intent}</p>
            </div>

            {/* Pipeline block */}
            {change.status === 'failed' ? (
              <div className="rounded-xl bg-[#131b2e] border border-red-500/20 overflow-hidden">
                <div className="flex items-center justify-between px-5 py-4 border-b border-white/5">
                  <div className="flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full bg-red-400 flex-shrink-0" />
                    <p className="text-xs font-bold uppercase tracking-widest text-red-400 font-headline">
                      Planning failed{change.failed_stage ? ` · ${change.failed_stage}` : ''}
                    </p>
                  </div>
                  {change.retryable !== false && (
                    <button
                      onClick={async () => {
                        const res = await fetch(`/api/change-requests/${change.id}/analyze`, { method: 'POST' })
                        if (res.ok) {
                          setChange(c => ({ ...c, status: 'planning', pipeline_status: 'planning', failed_stage: null, retryable: null, failure_diagnostics: null }))
                          setPipelineStatus('planning')
                        } else {
                          const body = await res.json().catch(() => ({}))
                          setActionError(body.error ?? `Retry failed (${res.status})`)
                        }
                      }}
                      className="text-xs font-semibold text-indigo-400 hover:text-indigo-300 transition-colors"
                    >
                      Retry planning
                    </button>
                  )}
                </div>
                {change.failure_diagnostics && (
                  <div className="px-5 py-4 space-y-1">
                    <p className="text-xs text-slate-400">{change.failure_diagnostics.summary}</p>
                    {change.failure_diagnostics.issues.length > 0 && (
                      <ul className="mt-2 space-y-0.5">
                        {change.failure_diagnostics.issues.slice(0, 5).map((issue, i) => (
                          <li key={i} className="text-xs text-slate-500 font-mono before:content-['·_'] before:text-slate-700">{issue}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </div>
            ) : change.status === 'open' ? (
              <div className="rounded-xl p-6 bg-[#131b2e] border border-white/5 text-center">
                <span className="material-symbols-outlined text-slate-600 mb-3 block" style={{ fontSize: '28px' }}>analytics</span>
                <p className="text-sm text-slate-400 mb-4">Run impact analysis to see which components this change affects.</p>
                <button
                  onClick={async () => {
                    const res = await fetch(`/api/change-requests/${change.id}/analyze`, { method: 'POST' })
                    if (res.ok) {
                      setChange(c => ({ ...c, status: 'planning', pipeline_status: 'spec_generating' }))
                    }
                  }}
                  className="px-4 py-2 rounded-lg bg-indigo-500 hover:bg-indigo-400 text-white text-sm font-bold font-headline transition-colors"
                >
                  Run Analysis
                </button>
              </div>
            ) : change.status === 'analyzed' && !impact ? (
              <div className="rounded-xl p-6 bg-[#131b2e] border border-white/5 text-center">
                <span className="material-symbols-outlined text-slate-600 mb-3 block" style={{ fontSize: '28px' }}>analytics</span>
                <p className="text-sm text-slate-400 mb-4">Analysis completed but no impact data was recorded.</p>
                <button
                  onClick={async () => {
                    const res = await fetch(`/api/change-requests/${change.id}/analyze`, { method: 'POST' })
                    if (res.ok) setChange(c => ({ ...c, status: 'analyzing' }))
                  }}
                  className="px-4 py-2 rounded-lg bg-indigo-500 hover:bg-indigo-400 text-white text-sm font-bold font-headline transition-colors"
                >
                  Re-analyse
                </button>
              </div>
            ) : change.status === 'analyzed' && impact ? (
              <div className="rounded-xl bg-[#131b2e] border border-white/5 overflow-hidden">
                    {/* Header */}
                    <div className="flex items-center justify-between px-5 py-4 border-b border-white/5">
                      <p className="text-xs font-bold uppercase tracking-widest text-slate-400 font-headline">Impact Analysis</p>
                      <div className="flex items-center gap-2">
                        {impact.analysis_quality && (
                          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-800 text-slate-500 uppercase tracking-wider">
                            {impact.analysis_quality === 'high' ? 'keyword matched' : 'ai assisted'}
                          </span>
                        )}
                        <button
                          onClick={async () => {
                            const res = await fetch(`/api/change-requests/${change.id}/analyze`, { method: 'POST' })
                            if (res.ok) setChange(c => ({ ...c, status: 'analyzing' }))
                          }}
                          disabled={ANALYZING_STATUSES.includes(change.status)}
                          className="text-xs text-indigo-400 hover:text-indigo-300 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                        >
                          Re-analyse
                        </button>
                      </div>
                    </div>

                    {/* Go / No-Go Signal */}
                    <div className="px-5 py-5 border-b border-white/5">
                      <div className="flex items-center gap-6 mb-3">
                        <div>
                          <p className="text-[10px] uppercase tracking-widest text-slate-600 font-headline mb-1">Risk</p>
                          <p className={`text-sm font-extrabold font-mono ${
                            change.risk_level === 'high' ? 'text-red-400' :
                            change.risk_level === 'medium' ? 'text-amber-400' : 'text-green-400'
                          }`}>{riskLabel}</p>
                        </div>
                        <div className="w-px h-8 bg-white/5" />
                        <div>
                          <p className="text-[10px] uppercase tracking-widest text-slate-600 font-headline mb-1">Confidence</p>
                          <p className={`text-sm font-extrabold font-mono ${confTextColor}`}>{confidenceLabel}</p>
                        </div>
                        <div className="w-px h-8 bg-white/5" />
                        <div>
                          <p className="text-[10px] uppercase tracking-widest text-slate-600 font-headline mb-1">Recommendation</p>
                          <p className={`text-sm font-extrabold font-mono ${recColor}`}>{recommendation}</p>
                        </div>
                      </div>
                      <p className="text-[11px] text-slate-600 font-mono">{confidenceReasons.join(' · ')}</p>
                    </div>

                    {/* Key Drivers */}
                    {driverDescriptions.length > 0 && (
                      <div className="px-5 py-4 border-b border-white/5">
                        <p className="text-[10px] uppercase tracking-widest text-slate-500 font-headline mb-3">Why This Matters</p>
                        <ul className="space-y-1.5">
                          {driverDescriptions.map((desc, i) => (
                            <li key={i} className="flex items-start gap-2">
                              <span className="text-slate-600 mt-0.5 flex-shrink-0">–</span>
                              <span className="text-sm text-slate-300">{desc}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {/* Unknowns */}
                    {unknownItems.length > 0 && (
                      <div className="px-5 py-4 border-b border-white/5">
                        <p className="text-[10px] uppercase tracking-widest text-slate-500 font-headline mb-3">Unknowns That Could Break Planning</p>
                        <ul className="space-y-1.5">
                          {unknownItems.map((u, i) => (
                            <li key={i} className="flex items-start gap-2">
                              <span className="text-amber-500/80 mt-0.5 flex-shrink-0 text-xs">⚠</span>
                              <span className="text-sm text-slate-400">{u}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {/* Plan Gaps */}
                    {planGaps.length > 0 && (
                      <div className="px-5 py-4 border-b border-white/5">
                        <p className="text-[10px] uppercase tracking-widest text-slate-500 font-headline mb-3">Potential Plan Gaps</p>
                        <ul className="space-y-1.5">
                          {planGaps.map((g, i) => (
                            <li key={i} className="flex items-start gap-2">
                              <span className="text-indigo-400/60 mt-0.5 flex-shrink-0 text-xs">◦</span>
                              <span className="text-sm text-slate-400">{g}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {/* Scope Summary */}
                    <div className="px-5 py-4 border-b border-white/5">
                      <p className="text-[10px] uppercase tracking-widest text-slate-500 font-headline mb-3">Scope</p>
                      <div className="flex items-center gap-4 flex-wrap text-[11px] font-mono text-slate-400">
                        {impactComponents.length > 0 && (
                          <span>
                            <span className="text-on-surface font-bold">{impactComponents.length}</span> components
                          </span>
                        )}
                        {directComponents.length > 0 && propagatedComponents.length > 0 && (
                          <span className="text-slate-600">
                            {directComponents.length} direct · {propagatedComponents.length} propagated
                          </span>
                        )}
                        {(impact.blast_radius ?? 0) > 0 && (
                          <span>
                            <span className="text-on-surface font-bold">{impact.blast_radius}</span> files in blast radius
                          </span>
                        )}
                        {criticalDomains.length > 0 && (
                          <span>critical: <span className="text-slate-300">{criticalDomains.join(', ')}</span></span>
                        )}
                      </div>
                    </div>

                    {/* Generate Plan CTA */}
                    <div className="px-5 py-4 space-y-2">
                      {actionError && (
                        <div className="flex items-start gap-2 rounded-lg bg-red-950/40 border border-red-500/30 px-3 py-2">
                          <span className="material-symbols-outlined text-red-400 flex-shrink-0" style={{ fontSize: 15 }}>error</span>
                          <p className="text-xs text-red-400 leading-snug">{actionError}</p>
                        </div>
                      )}
                      <div className="flex items-center justify-between">
                        <p className="text-xs text-slate-600">
                          {recommendation === 'REVIEW BEFORE PLANNING'
                            ? 'High risk + low confidence — review carefully before generating a plan'
                            : 'Approving generates a task plan. Execution happens separately.'}
                        </p>
                        <button
                          onClick={async () => {
                            const confirmed = change.risk_level !== 'high' ||
                              window.confirm('This change carries high risk. Generate a plan anyway?')
                            if (!confirmed) return
                            setActionError(null)
                            try {
                              const res = await fetch(`/api/change-requests/${change.id}/plan`, { method: 'POST' })
                              if (res.ok) {
                                setChange(c => ({ ...c, status: 'planning' }))
                              } else {
                                const data = await res.json().catch(() => ({}))
                                setActionError(data.detail ?? data.error ?? 'Failed to generate plan')
                              }
                            } catch {
                              setActionError('Network error — could not reach the server')
                            }
                          }}
                          className="flex-shrink-0 px-4 py-2 rounded-lg bg-indigo-500 hover:bg-indigo-400 text-white text-sm font-bold font-headline transition-colors"
                        >
                          Generate Plan
                        </button>
                      </div>
                    </div>
              </div>
            ) : (isAnalyzing || plan) ? (
              <div className="rounded-xl bg-[#131b2e] border border-white/5 overflow-hidden">
                {/* Plan header */}
                {plan ? (() => {
                  const allFiles = [...new Set(planTasks.flatMap(t => componentFileMap[t.component_id ?? ''] ?? []))]
                  const mappedFileCount = allFiles.length
                  const estimatedFileCount = null ?? mappedFileCount
                  const newFileCount = Math.max(0, estimatedFileCount - mappedFileCount)
                  return (
                    <div className="flex items-center justify-between px-5 py-4 border-b border-white/5">
                      <p className="text-xs font-bold uppercase tracking-widest text-slate-400 font-headline">Implementation Plan</p>
                      <div className="flex items-center gap-3">
                        {plan.estimated_tasks !== null && (
                          <span className="text-[10px] font-mono text-slate-500">{plan.estimated_tasks} tasks</span>
                        )}
                        {mappedFileCount > 0 && (
                          <span className="text-[10px] font-mono text-slate-500">
                            {mappedFileCount} file{mappedFileCount !== 1 ? 's' : ''}
                            {newFileCount > 0 && <span className="text-indigo-400"> +{newFileCount} new</span>}
                          </span>
                        )}
                        <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded uppercase tracking-wider ${
                          plan.status === 'approved'
                            ? 'bg-green-400/10 text-green-400'
                            : 'bg-slate-700 text-slate-400'
                        }`}>
                          {plan.status}
                        </span>
                      </div>
                    </div>
                  )
                })() : (
                  <div className="flex items-center gap-3 px-5 py-4 border-b border-white/5">
                    <span className="relative flex h-2 w-2 flex-shrink-0">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-75" />
                      <span className="relative inline-flex rounded-full h-2 w-2 bg-indigo-400" />
                    </span>
                    <p className="text-xs font-bold uppercase tracking-widest text-slate-400 font-headline">Planning</p>
                  </div>
                )}

                {/* Tab bar */}
                <div className="flex border-b border-white/5">
                  {(['spec', 'plan', 'tasks', 'review'] as const).map(tab => (
                    <button
                      key={tab}
                      onClick={() => setPlanTab(tab)}
                      className={`px-5 py-2.5 text-xs font-bold uppercase tracking-widest font-headline transition-colors ${
                        planTab === tab
                          ? 'text-indigo-400 border-b-2 border-indigo-400'
                          : 'text-slate-500 hover:text-slate-300'
                      }`}
                    >
                      {tab}
                    </button>
                  ))}
                </div>

                {/* Review tab */}
                {planTab === 'review' && !plan && isAnalyzing && (
                  <p className="px-5 py-6 text-sm text-slate-600 text-center">Review will be available once planning is complete.</p>
                )}
                {planTab === 'review' && plan && (
                  <div className="divide-y divide-white/5">

                    {/* 1. Recommended Decision */}
                    <div className="px-5 py-5">
                      <div className="flex items-center gap-6 mb-3">
                        <div>
                          <p className="text-[10px] uppercase tracking-widest text-slate-600 font-headline mb-1">Risk</p>
                          <p className={`text-sm font-extrabold font-mono ${
                            change.risk_level === 'high' ? 'text-red-400' :
                            change.risk_level === 'medium' ? 'text-amber-400' : 'text-green-400'
                          }`}>{(change.risk_level ?? 'low').toUpperCase()}</p>
                        </div>
                        <div className="w-px h-8 bg-white/5" />
                        <div>
                          <p className="text-[10px] uppercase tracking-widest text-slate-600 font-headline mb-1">Confidence</p>
                          <p className={`text-sm font-extrabold font-mono ${confTextColor}`}>{confidenceLabel}</p>
                        </div>
                        <div className="w-px h-8 bg-white/5" />
                        <div>
                          <p className="text-[10px] uppercase tracking-widest text-slate-600 font-headline mb-1">Verdict</p>
                          <p className={`text-sm font-extrabold font-mono ${recColor}`}>{recommendation}</p>
                        </div>
                      </div>
                      <div className="space-y-1 mt-3">
                        {reviewVerdictNotes.map((note, i) => (
                          <p key={i} className="text-[11px] text-slate-500 font-mono">– {note}</p>
                        ))}
                      </div>
                    </div>

                    {/* 2. Likely Impacted Files */}
                    {(reviewAllFiles.length > 0 || reviewNewFileCount > 0) && (
                      <div className="px-5 py-4">
                        <p className="text-[10px] uppercase tracking-widest text-slate-500 font-headline mb-3">Likely Impacted Files</p>
                        <div className="space-y-1.5">
                          {reviewAllFiles.map(file => (
                            <div key={file} className="flex items-baseline gap-2">
                              <span className="text-[10px] font-mono text-amber-500/70 flex-shrink-0">~</span>
                              <span className="text-xs font-mono text-slate-300">{file}</span>
                            </div>
                          ))}
                          {reviewNewFileCount > 0 && (
                            <div className="flex items-baseline gap-2">
                              <span className="text-[10px] font-mono text-green-500/70 flex-shrink-0">+</span>
                              <span className="text-xs font-mono text-slate-500">{reviewNewFileCount} new file{reviewNewFileCount !== 1 ? 's' : ''} (from plan estimate)</span>
                            </div>
                          )}
                        </div>
                      </div>
                    )}

                    {/* 3. File-Level Impact */}
                    {reviewAllFiles.length > 0 && (
                      <div className="px-5 py-4">
                        <p className="text-[10px] uppercase tracking-widest text-slate-500 font-headline mb-3">File-Level Impact</p>
                        <div className="space-y-3">
                          {reviewAllFiles.map(file => {
                            const ic = fileToImpact.get(file)
                            const compType = ic?.system_components?.type
                            const weight = ic?.impact_weight ?? 0
                            const risk = fileRiskLevel(file, compType, weight)
                            const note = fileRiskNote(file, compType, false)
                            const riskColor = risk === 'HIGH' ? 'text-red-400' : risk === 'MEDIUM' ? 'text-amber-400' : 'text-green-500/70'
                            const shortName = file.split('/').pop() ?? file
                            return (
                              <div key={file}>
                                <div className="flex items-center gap-2 mb-0.5">
                                  <span className="text-xs font-mono text-slate-300">{shortName}</span>
                                  <span className={`text-[9px] font-bold uppercase tracking-wider font-mono ${riskColor}`}>{risk}</span>
                                </div>
                                <p className="text-[11px] text-slate-500 font-mono pl-0">{note}</p>
                              </div>
                            )
                          })}
                          {reviewNewFileCount > 0 && (
                            <div>
                              <div className="flex items-center gap-2 mb-0.5">
                                <span className="text-xs font-mono text-green-400/70">+{reviewNewFileCount} new</span>
                                <span className="text-[9px] font-bold uppercase tracking-wider font-mono text-green-500/70">LOW</span>
                              </div>
                              <p className="text-[11px] text-slate-500 font-mono">No existing dependencies — isolated new code</p>
                            </div>
                          )}
                        </div>
                      </div>
                    )}

                    {/* 4. Propagation */}
                    {(directComponents.length > 0 || propagatedComponents.length > 0) && (
                      <div className="px-5 py-4">
                        <p className="text-[10px] uppercase tracking-widest text-slate-500 font-headline mb-3">Propagation</p>
                        <div className="space-y-1 font-mono text-[11px]">
                          {directComponents.slice(0, 3).map(ic => (
                            <div key={ic.component_id} className="flex items-center gap-1.5">
                              <span className="text-slate-300">{ic.system_components?.name ?? ic.component_id}</span>
                              {propagatedComponents.filter(p => p.source_detail === ic.component_id).slice(0, 2).map(p => (
                                <span key={p.component_id} className="flex items-center gap-1.5">
                                  <span className="text-slate-700">→</span>
                                  <span className="text-slate-500">{p.system_components?.name ?? p.component_id}</span>
                                </span>
                              ))}
                            </div>
                          ))}
                          {propagatedComponents.filter(p => !directComponents.some(d => d.component_id === p.source_detail)).slice(0, 2).map(ic => (
                            <div key={ic.component_id} className="flex items-center gap-1.5">
                              <span className="text-slate-600 text-[10px]">via file graph</span>
                              <span className="text-slate-700">→</span>
                              <span className="text-slate-500">{ic.system_components?.name ?? ic.component_id}</span>
                            </div>
                          ))}
                          {propagatedComponents.length === 0 && directComponents.length > 0 && (
                            <p className="text-slate-600">No deep propagation — change stays within directly mapped components</p>
                          )}
                        </div>
                      </div>
                    )}

                    {/* 5. Potential Risks */}
                    {(hiddenRisks.length > 0) && (
                      <div className="px-5 py-4">
                        <p className="text-[10px] uppercase tracking-widest text-slate-500 font-headline mb-3">Potential Risks</p>
                        <div className="space-y-1.5">
                          {Array.from(addedRiskItems).map((risk, i) => (
                            <div key={i} className="flex items-start gap-2">
                              <span className="text-green-500/80 flex-shrink-0 text-xs mt-0.5">✓</span>
                              <span className="text-[11px] text-slate-400 font-mono leading-relaxed">{risk}</span>
                            </div>
                          ))}
                          {hiddenRisks.filter(r => !addedRiskItems.has(r)).map((risk, i) => (
                            <div key={i} className="flex items-start justify-between gap-2">
                              <div className="flex items-start gap-2 min-w-0">
                                <span className="text-amber-500/80 flex-shrink-0 text-xs mt-0.5">⚠</span>
                                <span className="text-[11px] text-slate-400 font-mono leading-relaxed">{risk}</span>
                              </div>
                              {plan && plan.status !== 'approved' && (
                                <button
                                  disabled={addingRiskTask === risk}
                                  onClick={async () => {
                                    if (!plan) return
                                    setAddingRiskTask(risk)
                                    try {
                                      const description = `Mitigate: ${risk.split(' — ')[0]}`
                                      const res = await fetch(`/api/change-requests/${change.id}/plan/tasks`, {
                                        method: 'POST',
                                        headers: { 'Content-Type': 'application/json' },
                                        body: JSON.stringify({ description }),
                                      })
                                      if (res.ok) {
                                        const task = await res.json()
                                        setPlanTasks(prev => [...prev, task])
                                        setAddedRiskItems(prev => new Set(prev).add(risk))
                                        setToast(`Task added: ${description}`)
                                      }
                                    } finally {
                                      setAddingRiskTask(null)
                                    }
                                  }}
                                  className="flex-shrink-0 text-[10px] text-amber-500/60 hover:text-amber-400 disabled:opacity-40 transition-colors whitespace-nowrap"
                                >
                                  {addingRiskTask === risk ? 'Adding…' : '+ Add'}
                                </button>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* 6. Coverage Gaps */}
                    {(coveredItems.length > 0 || missingItems.length > 0) && (
                      <div className="px-5 py-4">
                        <p className="text-[10px] uppercase tracking-widest text-slate-500 font-headline mb-3">Test Coverage</p>
                        <div className="space-y-1.5">
                          {[...coveredItems, ...Array.from(addedCoverageItems)].map((item, i) => (
                            <div key={i} className="flex items-start gap-2">
                              <span className="text-green-500/80 flex-shrink-0 text-xs mt-0.5">✓</span>
                              <span className="text-[11px] text-slate-400 font-mono">{item}</span>
                            </div>
                          ))}
                          {missingItems.filter(item => !addedCoverageItems.has(item)).map((item, i) => (
                            <div key={i} className="flex items-start justify-between gap-2">
                              <div className="flex items-start gap-2 min-w-0">
                                <span className="text-amber-500/80 flex-shrink-0 text-xs mt-0.5">⚠</span>
                                <span className="text-[11px] text-slate-400 font-mono">Missing: {item}</span>
                              </div>
                              {plan && plan.status !== 'approved' && (
                                <button
                                  disabled={addingTestTask === item}
                                  onClick={async () => {
                                    if (!plan) return
                                    setAddingTestTask(item)
                                    try {
                                      const description = `Write test: ${item.split(' — ')[0]}`
                                      const res = await fetch(`/api/change-requests/${change.id}/plan/tasks`, {
                                        method: 'POST',
                                        headers: { 'Content-Type': 'application/json' },
                                        body: JSON.stringify({ description }),
                                      })
                                      if (res.ok) {
                                        const task = await res.json()
                                        setPlanTasks(prev => [...prev, task])
                                        setAddedCoverageItems(prev => new Set(prev).add(item))
                                        setToast(`Task added: ${description}`)
                                      }
                                    } finally {
                                      setAddingTestTask(null)
                                    }
                                  }}
                                  className="flex-shrink-0 text-[10px] text-amber-500/60 hover:text-amber-400 disabled:opacity-40 transition-colors whitespace-nowrap"
                                >
                                  {addingTestTask === item ? 'Adding…' : '+ Add'}
                                </button>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* 7. Plan Quality */}
                    {(qualityStrengths.length > 0 || qualityGaps.length > 0) && (
                      <div className="px-5 py-4">
                        <p className="text-[10px] uppercase tracking-widest text-slate-500 font-headline mb-3">Plan Quality</p>
                        <div className="space-y-1.5">
                          {qualityStrengths.map((s, i) => (
                            <div key={i} className="flex items-start gap-2">
                              <span className="text-indigo-400/60 flex-shrink-0 text-xs mt-0.5">◦</span>
                              <span className="text-[11px] text-slate-400 font-mono">{s}</span>
                            </div>
                          ))}
                          {qualityGaps.map((g, i) => (
                            <div key={i} className="flex items-start gap-2">
                              <span className="text-slate-600 flex-shrink-0 text-xs mt-0.5">◦</span>
                              <span className="text-[11px] text-slate-500 font-mono">{g}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                  </div>
                )}

                {/* Tasks tab */}
                {planTab === 'tasks' && (() => {
                  const allTasks = getAllPlanTasks(plan?.plan_json)
                  const visibleTasks = allTasks.slice(0, visibleTaskCount)
                  return (
                    <div className="divide-y divide-white/5">
                      {allTasks.length === 0 ? (
                        isAnalyzing ? (
                          <p className="px-5 py-6 text-sm text-slate-600 text-center">Tasks will appear here once the plan is generated.</p>
                        ) : (
                          <p className="px-5 py-6 text-sm text-slate-500 text-center">No tasks generated.</p>
                        )
                      ) : (
                        <>
                          {visibleTasks.map((task, idx) => (
                            <div
                              key={task.id}
                              className="px-5 py-3 flex items-start gap-3 animate-in fade-in slide-in-from-bottom-1 duration-200"
                              style={{ animationDelay: `${idx * 20}ms` }}
                            >
                              <span className="mt-1 h-2 w-2 rounded-full flex-shrink-0 bg-slate-600" />
                              <div className="flex-1 min-w-0">
                                <p className="text-sm text-slate-300 font-medium leading-snug">{task.title}</p>
                                {task.files.length > 0 && (
                                  <div className="flex flex-wrap gap-x-2 gap-y-0.5 mt-1.5">
                                    {task.files.map(f => (
                                      <span key={f} className="text-[10px] font-mono text-indigo-400/60">{f}</span>
                                    ))}
                                  </div>
                                )}
                              </div>
                              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-800 text-slate-500 uppercase flex-shrink-0">{task.type}</span>
                            </div>
                          ))}
                          {visibleTaskCount < allTasks.length && (
                            <div className="px-5 py-3 flex items-center gap-3">
                              <span className="relative flex h-2 w-2 flex-shrink-0">
                                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-75" />
                                <span className="relative inline-flex rounded-full h-2 w-2 bg-indigo-400" />
                              </span>
                              <span className="text-xs text-slate-600 font-mono">{allTasks.length - visibleTaskCount} more…</span>
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  )
                })()}

                {/* Plan tab */}
                {planTab === 'plan' && (() => {
                  const planStage = PIPELINE_STAGES[1]
                  const isPlanActive = planStage.activeStatuses.includes(pipelineStatus ?? '') ||
                    pipelineStatus === 'spec_generated'
                  const planSubstepIdx = activeSubstepIndex(1, pipelineStatus)
                  const hasPlanJson = !!plan?.plan_json
                  return (
                    <div>
                      {/* View toggle — only when plan data exists */}
                      {hasPlanJson && (
                        <div className="flex items-center gap-1 px-5 py-2.5 border-b border-white/5">
                          <button
                            onClick={() => setPlanView('structured')}
                            className={`text-[10px] font-mono px-2 py-1 rounded transition-colors ${planView === 'structured' ? 'bg-slate-700 text-slate-200' : 'text-slate-600 hover:text-slate-400'}`}
                          >
                            structured
                          </button>
                          <button
                            onClick={() => setPlanView('json')}
                            className={`text-[10px] font-mono px-2 py-1 rounded transition-colors ${planView === 'json' ? 'bg-slate-700 text-slate-200' : 'text-slate-600 hover:text-slate-400'}`}
                          >
                            json
                          </button>
                        </div>
                      )}
                      <div className="divide-y divide-white/5">
                        {isPlanActive ? (
                          <div className="px-5 py-4 space-y-2">
                            <div className="flex items-center gap-3 mb-4">
                              <span className="relative flex h-2 w-2 flex-shrink-0">
                                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-75" />
                                <span className="relative inline-flex rounded-full h-2 w-2 bg-indigo-400" />
                              </span>
                              <p className="text-sm font-medium text-slate-300">Building execution plan…</p>
                            </div>
                            <div className="ml-5 pl-3 border-l border-white/5 space-y-1.5">
                              {planStage.substeps.map((sub, si) => {
                                const subDone = planSubstepIdx !== -1 && si < planSubstepIdx
                                const subActive = planSubstepIdx !== -1 && si === planSubstepIdx
                                return (
                                  <div key={sub.status} className="flex items-center gap-2">
                                    <span className={`text-xs w-3 flex-shrink-0 font-mono ${subDone ? 'text-green-400' : subActive ? 'text-indigo-300' : 'text-slate-700'}`}>
                                      {subDone ? '✓' : subActive ? '•' : '○'}
                                    </span>
                                    <span className={`text-xs ${subDone ? 'text-slate-500' : subActive ? 'text-slate-300' : 'text-slate-600'}`}>
                                      {sub.label}
                                    </span>
                                  </div>
                                )
                              })}
                            </div>
                          </div>
                        ) : plan?.plan_json ? (
                          planView === 'json' ? (
                            <div className="px-5 py-4">
                              <pre className="text-[11px] text-slate-400 font-mono whitespace-pre-wrap leading-relaxed overflow-x-auto">
                                {JSON.stringify(plan.plan_json, null, 2)}
                              </pre>
                            </div>
                          ) : (
                            plan.plan_json.phases.map((phase, pi) => (
                              <div key={phase.id} className="px-5 py-4">
                                <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500 font-headline mb-3">
                                  Phase {pi + 1} — {phase.title}
                                </p>
                                <div className="space-y-3">
                                  {phase.tasks.map((task) => (
                                    <div key={task.id} className="rounded-lg bg-[#0f172a] border border-white/5 p-3">
                                      <div className="flex items-start justify-between gap-3 mb-1.5">
                                        <span className="text-sm text-slate-200 font-medium leading-snug">{task.title}</span>
                                        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-800 text-slate-500 uppercase flex-shrink-0">{task.type}</span>
                                      </div>
                                      {task.files.length > 0 && (
                                        <div className="flex flex-wrap gap-1.5 mt-2">
                                          {task.files.map(f => (
                                            <span key={f} className="text-[10px] font-mono text-indigo-400/70 bg-indigo-400/5 px-1.5 py-0.5 rounded">{f}</span>
                                          ))}
                                        </div>
                                      )}
                                      {task.expected_result && (
                                        <p className="text-xs text-slate-500 mt-2 leading-relaxed">{task.expected_result}</p>
                                      )}
                                    </div>
                                  ))}
                                </div>
                              </div>
                            ))
                          )
                        ) : isAnalyzing ? (
                          <p className="px-5 py-6 text-sm text-slate-600 text-center">Plan will appear here once generated.</p>
                        ) : (
                          <p className="px-5 py-6 text-sm text-slate-500 text-center">No plan data available.</p>
                        )}
                      </div>
                    </div>
                  )
                })()}

                {/* Spec tab */}
                {planTab === 'spec' && (() => {
                  const specStage = PIPELINE_STAGES[0]
                  const isSpecActive = specStage.activeStatuses.includes(pipelineStatus ?? '')
                  const specSubstepIdx = activeSubstepIndex(0, pipelineStatus)
                  return (
                    <div className="px-5 py-4">
                      {isSpecActive ? (
                        <div className="space-y-2 py-2">
                          <div className="flex items-center gap-3 mb-4">
                            <span className="relative flex h-2 w-2 flex-shrink-0">
                              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-75" />
                              <span className="relative inline-flex rounded-full h-2 w-2 bg-indigo-400" />
                            </span>
                            <p className="text-sm font-medium text-slate-300">Generating specification…</p>
                          </div>
                          <div className="ml-5 pl-3 border-l border-white/5 space-y-1.5">
                            {specStage.substeps.map((sub, si) => {
                              const subDone = specSubstepIdx !== -1 && si < specSubstepIdx
                              const subActive = specSubstepIdx !== -1 && si === specSubstepIdx
                              return (
                                <div key={sub.status} className="flex items-center gap-2">
                                  <span className={`text-xs w-3 flex-shrink-0 font-mono ${subDone ? 'text-green-400' : subActive ? 'text-indigo-300' : 'text-slate-700'}`}>
                                    {subDone ? '✓' : subActive ? '•' : '○'}
                                  </span>
                                  <span className={`text-xs ${subDone ? 'text-slate-500' : subActive ? 'text-slate-300' : 'text-slate-600'}`}>
                                    {sub.label}
                                  </span>
                                </div>
                              )
                            })}
                          </div>
                        </div>
                      ) : specMarkdown ? (
                        <pre className="text-xs text-slate-400 font-mono whitespace-pre-wrap leading-relaxed">
                          {specMarkdown}
                        </pre>
                      ) : isAnalyzing ? (
                        <p className="text-sm text-slate-600 text-center py-8">Spec will appear here once generated.</p>
                      ) : (
                        <div className="text-center py-8">
                          <p className="text-sm text-slate-500 mb-4">Spec was not generated.</p>
                          <button
                            disabled={generatingSpec}
                            onClick={async () => {
                              setGeneratingSpec(true)
                              try {
                                const res = await fetch(`/api/change-requests/${change.id}/spec`, { method: 'POST' })
                                if (res.ok) {
                                  const data = await res.json()
                                  setSpecMarkdown(data.spec_markdown ?? null)
                                }
                              } finally {
                                setGeneratingSpec(false)
                              }
                            }}
                            className="px-4 py-2 rounded-lg bg-indigo-500 hover:bg-indigo-400 disabled:opacity-50 text-white text-sm font-bold font-headline transition-colors"
                          >
                            {generatingSpec ? 'Generating…' : 'Generate Spec'}
                          </button>
                        </div>
                      )}
                    </div>
                  )
                })()}

                {/* Execute footer (approved) */}
                {plan?.status === 'approved' && (
                  <div className="px-5 py-4 border-t border-white/5 flex items-center justify-between">
                    <p className="text-xs text-slate-500">
                      {change.status === 'failed' ? 'Previous execution failed — retry when ready'
                        : change.status === 'review' || change.status === 'done' ? 'Execution complete — re-run to apply changes again'
                        : 'Plan approved — ready to execute'}
                    </p>
                    <Link
                      href={`/projects/${project.id}/changes/${change.id}/execution`}
                      className="px-4 py-2 rounded-lg bg-green-500 hover:bg-green-400 text-white text-sm font-bold font-headline transition-colors"
                    >
                      {change.status === 'review' || change.status === 'done' ? 'Re-run' : 'Execute'}
                    </Link>
                  </div>
                )}

                {/* Approve footer */}
                {plan && plan.status !== 'approved' && (
                  <div className="px-5 py-4 border-t border-white/5 space-y-3">
                  {actionError && (
                    <div className="flex items-start gap-2 rounded-lg bg-red-950/40 border border-red-500/30 px-3 py-2">
                      <span className="material-symbols-outlined text-red-400 flex-shrink-0" style={{ fontSize: 15 }}>error</span>
                      <p className="text-xs text-red-400 leading-snug">{actionError}</p>
                    </div>
                  )}
                  <div className="flex items-center justify-end gap-3">
                    <button
                      onClick={async () => {
                        setActionError(null)
                        try {
                          const res = await fetch(`/api/change-requests/${change.id}/plan`, { method: 'POST' })
                          if (res.ok) {
                            setChange(c => ({ ...c, status: 'planning' }))
                          } else {
                            const data = await res.json().catch(() => ({}))
                            setActionError(data.error ?? `Failed to regenerate plan (${res.status})`)
                          }
                        } catch {
                          setActionError('Network error — could not regenerate plan')
                        }
                      }}
                      className="px-3 py-1.5 rounded-lg border border-white/10 text-slate-400 hover:text-slate-200 text-xs font-bold font-headline transition-colors"
                    >
                      Regenerate
                    </button>
                    {change.status === 'awaiting_approval' ? (
                      <button
                        disabled={approving || isAnalyzing}
                        onClick={async () => {
                          setApproving(true)
                          setActionError(null)
                          try {
                            const res = await fetch(`/api/change-requests/${change.id}/approve-execution`, { method: 'POST' })
                            if (!res.ok) {
                              const data = await res.json().catch(() => ({}))
                              setActionError(data.detail ?? data.error ?? 'Something went wrong')
                              return
                            }
                            router.push(`/projects/${project.id}/changes/${change.id}/execution`)
                          } catch {
                            setActionError('Network error — could not reach the server')
                          } finally {
                            setApproving(false)
                          }
                        }}
                        className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-bold font-headline transition-colors"
                      >
                        {approving ? 'Starting…' : 'Approve & Execute'}
                      </button>
                    ) : (
                      <button
                        disabled={approving || isAnalyzing}
                        onClick={async () => {
                          setApproving(true)
                          setActionError(null)
                          try {
                            const res = await fetch(`/api/change-requests/${change.id}/plan`, {
                              method: 'PATCH',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({ action: 'approve' }),
                            })
                            if (res.ok) {
                              setPlan(p => p ? { ...p, status: 'approved' } : p)
                            } else {
                              const data = await res.json().catch(() => ({}))
                              setActionError(data.detail ?? data.error ?? 'Something went wrong')
                            }
                          } catch {
                            setActionError('Network error — could not reach the server')
                          } finally {
                            setApproving(false)
                          }
                        }}
                        className="px-4 py-2 rounded-lg bg-green-500 hover:bg-green-400 disabled:opacity-50 text-white text-sm font-bold font-headline transition-colors"
                      >
                        {approving ? 'Approving…' : 'Approve Plan'}
                      </button>
                    )}
                  </div>
                  </div>
                )}
              </div>
            ) : null}

          </div>
        </main>
      </div>

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-6 right-6 z-50 flex items-center gap-2.5 px-4 py-3 rounded-xl bg-[#1a2540] border border-white/10 shadow-xl text-sm text-slate-200 font-mono animate-in fade-in slide-in-from-bottom-2 duration-200">
          <span className="text-green-400 text-xs">✓</span>
          {toast}
        </div>
      )}
    </div>
  )
}
