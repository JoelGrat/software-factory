'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { LeftNav } from '@/components/app/left-nav'
import { ProfileAvatar } from '@/components/app/profile-avatar'

// ── Types ────────────────────────────────────────────────────────────────────

interface Project {
  id: string; name: string; repo_url: string | null; repo_token: string | null
  scan_status: string; created_at: string; project_settings: Record<string, any>
}

interface ModelHealth {
  componentCount: number; fileCount: number; assignedFileCount: number
  avgConfidence: number; lowConfCount: number
}

interface DangerStats {
  componentCount: number; changeCount: number; executionCount: number
}

type RiskAction = 'auto' | 'approval' | 'manual'
type ScanMode = 'incremental' | 'full'
type TestDefault = 'scoped_first' | 'full_suite'
type ExecMode = 'container' | 'ci' | 'hybrid'
type OnFailure = 'notify' | 'create_change' | 'nothing'

interface Settings {
  execution: { maxIterations: number; maxCostUsd: number; timeoutMinutes: number; maxAffectedFiles: number }
  riskPolicy: { low: RiskAction; medium: RiskAction; high: RiskAction }
  scan: { mode: ScanMode; dependencyDepth: number; autoRescan: boolean }
  testStrategy: { default: TestDefault; highRisk: 'full_suite' }
  executionMode: ExecMode
  onFailure: OnFailure
  automation: { autoCreateOnError: boolean; suggestOnDrift: boolean }
}

type SectionId =
  | 'general' | 'repository' | 'execution' | 'risk-policy'
  | 'scan-model' | 'test-strategy' | 'exec-environment'
  | 'notifications' | 'automation' | 'env-vars' | 'preview-config'
  | 'model-health' | 'danger-zone'

const SECTIONS: { id: SectionId; label: string }[] = [
  { id: 'general',          label: 'General' },
  { id: 'repository',       label: 'Repository' },
  { id: 'execution',        label: 'Execution' },
  { id: 'risk-policy',      label: 'Risk Policy' },
  { id: 'scan-model',       label: 'Scan & Model' },
  { id: 'test-strategy',    label: 'Test Strategy' },
  { id: 'exec-environment', label: 'Exec Environment' },
  { id: 'notifications',    label: 'Notifications' },
  { id: 'automation',       label: 'Automation' },
  { id: 'env-vars',         label: 'Env Vars' },
  { id: 'preview-config',   label: 'Preview' },
  { id: 'model-health',     label: 'Model Health' },
  { id: 'danger-zone',      label: 'Danger Zone' },
]

const DEFAULTS: Settings = {
  execution: { maxIterations: 10, maxCostUsd: 5, timeoutMinutes: 10, maxAffectedFiles: 20 },
  riskPolicy: { low: 'auto', medium: 'approval', high: 'manual' },
  scan: { mode: 'incremental', dependencyDepth: 3, autoRescan: false },
  testStrategy: { default: 'scoped_first', highRisk: 'full_suite' },
  executionMode: 'container',
  onFailure: 'notify',
  automation: { autoCreateOnError: false, suggestOnDrift: false },
}

function mergeSettings(raw: Record<string, any>): Settings {
  return {
    execution: { ...DEFAULTS.execution, ...(raw.execution ?? {}) },
    riskPolicy: { ...DEFAULTS.riskPolicy, ...(raw.riskPolicy ?? {}) },
    scan: { ...DEFAULTS.scan, ...(raw.scan ?? {}) },
    testStrategy: { ...DEFAULTS.testStrategy, ...(raw.testStrategy ?? {}) },
    executionMode: raw.executionMode ?? DEFAULTS.executionMode,
    onFailure: raw.onFailure ?? DEFAULTS.onFailure,
    automation: { ...DEFAULTS.automation, ...(raw.automation ?? {}) },
  }
}

// ── Sub-components ────────────────────────────────────────────────────────────

const sectionClass = "rounded-xl bg-[#131b2e] border border-white/5 p-6 space-y-5"
const labelClass = "text-xs font-bold uppercase tracking-widest text-slate-400 font-headline"
const inputClass = "rounded-lg px-3 py-2 text-sm outline-none transition-all bg-[#0f1929] border border-white/10 text-slate-200 focus:border-indigo-500 font-mono w-full"
const numberInputClass = "rounded-lg px-3 py-2 text-sm outline-none transition-all bg-[#0f1929] border border-white/10 text-slate-200 focus:border-indigo-500 font-mono w-24 text-right"

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="text-sm font-bold text-slate-200 font-headline">{children}</h2>
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6">
      <div className="min-w-0">
        <p className={labelClass}>{label}</p>
        {hint && <p className="text-[11px] text-slate-600 mt-0.5">{hint}</p>}
      </div>
      <div className="flex-shrink-0">{children}</div>
    </div>
  )
}

function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!value)}
      className={`relative w-10 h-5 rounded-full transition-colors ${value ? 'bg-indigo-500' : 'bg-slate-700'}`}
    >
      <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${value ? 'left-5.5' : 'left-0.5'}`}
        style={{ left: value ? '1.375rem' : '0.125rem' }}
      />
    </button>
  )
}

function SegmentedControl<T extends string>({
  value, onChange, options,
}: {
  value: T; onChange: (v: T) => void
  options: { value: T; label: string }[]
}) {
  return (
    <div className="flex rounded-lg overflow-hidden border border-white/10">
      {options.map((opt, i) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          className={`px-3 py-1.5 text-xs font-semibold transition-all ${
            i > 0 ? 'border-l border-white/10' : ''
          } ${value === opt.value
            ? 'bg-indigo-500/20 text-indigo-300'
            : 'bg-[#0f1929] text-slate-400 hover:text-slate-200 hover:bg-[#171f33]'
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}

const RISK_ACTION_LABELS: Record<RiskAction, string> = {
  auto: 'Auto-execute',
  approval: 'Require approval',
  manual: 'Manual only',
}

function behaviorSummary(s: Settings): string[] {
  const risk = `${RISK_ACTION_LABELS[s.riskPolicy.low].toLowerCase()} low-risk · approval for medium · manual for high`
  const scan = `${s.scan.mode} scans · depth ${s.scan.dependencyDepth}${s.scan.autoRescan ? ' · auto-rescan on' : ''}`
  const exec = `Max $${s.execution.maxCostUsd} budget · ${s.execution.maxIterations} iterations · ${s.execution.timeoutMinutes} min`
  const test = s.testStrategy.default === 'scoped_first' ? 'Scoped tests first · full suite on high risk' : 'Full test suite always'
  return [risk, scan, exec, test]
}

// ── Main component ────────────────────────────────────────────────────────────

export function ProjectSettingsView({
  project: initial, modelHealth, dangerStats, envVarKeys: initialEnvVarKeys, previewConfig: initialPreviewConfig,
}: {
  project: Project
  modelHealth: ModelHealth
  dangerStats: DangerStats
  envVarKeys: { id: string; key: string; updated_at: string }[]
  previewConfig: {
    install_command: string; start_command: string; work_dir: string
    health_path: string; health_text: string | null; port_internal: number
    expected_keys: string[]; max_memory_mb: number; max_cpu_shares: number
  }
}) {
  const router = useRouter()
  const [project, setProject] = useState(initial)
  const [name, setName] = useState(initial.name)
  const [repoUrl, setRepoUrl] = useState(initial.repo_url ?? '')
  const [repoToken, setRepoToken] = useState(initial.repo_token ?? '')
  const [showToken, setShowToken] = useState(false)
  const [settings, setSettings] = useState<Settings>(() => mergeSettings(initial.project_settings ?? {}))

  const [saving, setSaving] = useState(false)
  const [checkingAccess, setCheckingAccess] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saveSuccess, setSaveSuccess] = useState(false)

  const [deleting, setDeleting] = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState('')
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const [activeSection, setActiveSection] = useState<SectionId>('general')

  const [envVarKeys, setEnvVarKeys] = useState(initialEnvVarKeys)
  const [newVarKey, setNewVarKey] = useState('')
  const [newVarValue, setNewVarValue] = useState('')
  const [addingVar, setAddingVar] = useState(false)
  const [varError, setVarError] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)

  const [previewCfg, setPreviewCfg] = useState(initialPreviewConfig)
  const [savingPreview, setSavingPreview] = useState(false)
  const [previewSaveError, setPreviewSaveError] = useState<string | null>(null)
  const [previewSaveSuccess, setPreviewSaveSuccess] = useState(false)

  const saveBar = (
    <div className="flex items-center gap-3 pt-2">
      <button
        type="submit"
        disabled={saving || checkingAccess}
        className="px-5 py-2 rounded-lg text-sm font-semibold bg-indigo-600 hover:bg-indigo-500 text-white transition-all active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {checkingAccess ? 'Checking access…' : saving ? 'Saving…' : 'Save changes'}
      </button>
      {saveSuccess && <span className="text-xs text-emerald-400 font-medium">Saved</span>}
      {saveError && <span className="text-xs text-red-400">{saveError}</span>}
    </div>
  )

  function patchSettings<K extends keyof Settings>(key: K, val: Settings[K]) {
    setSettings(s => ({ ...s, [key]: val }))
  }

  async function checkGitHubAccess(url: string, token: string): Promise<string | null> {
    const match = url.trim().match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/.*)?$/)
    if (!match) return 'Could not parse GitHub repository URL'
    const [, owner, repo] = match
    try {
      const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
      })
      if (res.status === 401) return 'Access token is invalid or expired'
      if (res.status === 403) return 'Token does not have permission to access this repository'
      if (res.status === 404) return 'Repository not found — check the URL and token scope'
      if (!res.ok) return `GitHub returned ${res.status}`
      const data = await res.json()
      if (!data.permissions?.push) return 'Token needs read/write (push) access to this repository'
      return null
    } catch {
      return 'Could not reach GitHub to verify access'
    }
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    setSaveError(null)
    setSaveSuccess(false)

    if (activeSection === 'repository' && repoUrl.trim() && repoToken.trim()) {
      setCheckingAccess(true)
      try {
        const accessError = await checkGitHubAccess(repoUrl, repoToken)
        if (accessError) {
          setSaveError(accessError)
          return
        }
      } finally {
        setCheckingAccess(false)
      }
    }

    setSaving(true)
    try {
      const res = await fetch(`/api/projects/${project.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          repo_url: repoUrl.trim() || null,
          repo_token: repoToken.trim() || null,
          project_settings: settings,
        }),
      })
      if (!res.ok) {
        const data = await res.json()
        setSaveError(data.error ?? 'Save failed')
        return
      }
      const updated = await res.json()
      setProject(p => ({ ...p, ...updated }))
      setSaveSuccess(true)
      router.refresh()
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    if (deleteConfirm !== project.name) return
    setDeleting(true)
    setDeleteError(null)
    try {
      const res = await fetch(`/api/projects/${project.id}`, { method: 'DELETE' })
      if (!res.ok) { setDeleteError('Delete failed. Try again.'); return }
      router.push('/projects')
    } finally {
      setDeleting(false)
    }
  }

  const summary = behaviorSummary(settings)
  const completeness = modelHealth.fileCount > 0
    ? Math.round((modelHealth.assignedFileCount / modelHealth.fileCount) * 100)
    : 0

  return (
    <div className="flex flex-col h-screen bg-[#0b1326] text-on-surface overflow-hidden">
      <header className="w-full h-16 flex-shrink-0 flex items-center justify-between px-6 bg-[#0b1326] border-b border-white/5 z-50 font-headline antialiased tracking-tight">
        <div className="flex items-center gap-2 text-sm">
          <Link href="/projects" className="font-black text-indigo-400 tracking-tighter hover:text-indigo-300 transition-colors">FactoryOS</Link>
          <span className="text-slate-600">/</span>
          <Link href={`/projects/${project.id}`} className="text-slate-400 hover:text-slate-200 transition-colors font-medium truncate max-w-[180px]">{project.name}</Link>
          <span className="text-slate-600">/</span>
          <span className="text-slate-200 font-medium">Settings</span>
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
        <main className="flex-1 overflow-y-auto bg-[#0b1326]">
          <div className="max-w-4xl mx-auto p-10 space-y-8">
              <div>
                <p className="text-xs uppercase tracking-widest font-bold text-indigo-400 font-headline mb-1">Project</p>
                <h1 className="text-3xl font-extrabold font-headline tracking-tight text-on-surface">Settings</h1>
              </div>

              {/* System Behavior Summary */}
              <div className="rounded-xl bg-indigo-500/5 border border-indigo-500/20 p-5">
                <p className="text-xs font-bold uppercase tracking-widest text-indigo-400 font-headline mb-3">System Behavior</p>
                <ul className="space-y-1.5">
                  {summary.map((line, i) => (
                    <li key={i} className="flex items-start gap-2 text-sm text-slate-300">
                      <span className="text-indigo-500 mt-0.5 flex-shrink-0">→</span>
                      <span>{line}</span>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="flex gap-8 items-start">
              <nav className="w-44 flex-shrink-0 bg-[#131b2e] rounded-xl py-4 px-2 space-y-0.5">
                {SECTIONS.map(({ id, label }) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setActiveSection(id)}
                    className={`w-full text-left px-3 py-2 rounded-lg text-xs font-semibold font-headline tracking-wide transition-all ${
                      activeSection === id
                        ? 'bg-indigo-500/10 text-indigo-400 border-l-4 border-indigo-500'
                        : 'text-slate-400 hover:text-slate-200 hover:bg-[#171f33] border-l-4 border-transparent'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </nav>
              <div className="flex-1 min-w-0 space-y-6">
              <form onSubmit={handleSave} className="space-y-6">

                {/* Execution Behavior */}
                {activeSection === 'execution' && (
                  <>
                    <div className={sectionClass}>
                      <SectionTitle>Execution Behavior</SectionTitle>
                      <Row label="Max iterations" hint="Maximum fix-attempt loops per change">
                        <div className="flex items-center gap-2">
                          <input type="number" min={1} max={50} value={settings.execution.maxIterations}
                            onChange={e => patchSettings('execution', { ...settings.execution, maxIterations: Number(e.target.value) })}
                            className={numberInputClass} />
                          <span className="text-xs text-slate-500">iterations</span>
                        </div>
                      </Row>
                      <Row label="Max cost" hint="AI spend limit per execution">
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-slate-500">$</span>
                          <input type="number" min={0} max={100} step={0.5} value={settings.execution.maxCostUsd}
                            onChange={e => patchSettings('execution', { ...settings.execution, maxCostUsd: Number(e.target.value) })}
                            className={numberInputClass} />
                        </div>
                      </Row>
                      <Row label="Timeout" hint="Wall-clock limit per execution">
                        <div className="flex items-center gap-2">
                          <input type="number" min={1} max={60} value={settings.execution.timeoutMinutes}
                            onChange={e => patchSettings('execution', { ...settings.execution, timeoutMinutes: Number(e.target.value) })}
                            className={numberInputClass} />
                          <span className="text-xs text-slate-500">min</span>
                        </div>
                      </Row>
                      <Row label="Max affected files" hint="Files touched before execution is halted">
                        <div className="flex items-center gap-2">
                          <input type="number" min={1} max={100} value={settings.execution.maxAffectedFiles}
                            onChange={e => patchSettings('execution', { ...settings.execution, maxAffectedFiles: Number(e.target.value) })}
                            className={numberInputClass} />
                          <span className="text-xs text-slate-500">files</span>
                        </div>
                      </Row>
                    </div>
                    {saveBar}
                  </>
                )}

                {/* Risk Policy */}
                {activeSection === 'risk-policy' && (
                  <>
                    <div className={sectionClass}>
                      <div>
                        <SectionTitle>Risk Policy</SectionTitle>
                        <p className="text-xs text-slate-500 mt-1">Controls how changes are handled based on their computed risk level.</p>
                      </div>
                      {(['low', 'medium', 'high'] as const).map(level => (
                        <Row
                          key={level}
                          label={`${level.charAt(0).toUpperCase() + level.slice(1)} risk`}
                        >
                          <SegmentedControl<RiskAction>
                            value={settings.riskPolicy[level]}
                            onChange={v => patchSettings('riskPolicy', { ...settings.riskPolicy, [level]: v })}
                            options={[
                              { value: 'auto',     label: 'Auto-execute' },
                              { value: 'approval', label: 'Require approval' },
                              { value: 'manual',   label: 'Manual only' },
                            ]}
                          />
                        </Row>
                      ))}
                    </div>
                    {saveBar}
                  </>
                )}

                {/* Scan & Model */}
                {activeSection === 'scan-model' && (
                  <>
                    <div className={sectionClass}>
                      <SectionTitle>Scan &amp; Model</SectionTitle>
                      <Row label="Scan mode" hint="Incremental re-uses existing data; full re-scans everything">
                        <SegmentedControl<ScanMode>
                          value={settings.scan.mode}
                          onChange={v => patchSettings('scan', { ...settings.scan, mode: v })}
                          options={[
                            { value: 'incremental', label: 'Incremental' },
                            { value: 'full',        label: 'Full' },
                          ]}
                        />
                      </Row>
                      <Row label="Dependency depth" hint="BFS hops when resolving import chains">
                        <div className="flex items-center gap-2">
                          <input type="number" min={1} max={10} value={settings.scan.dependencyDepth}
                            onChange={e => patchSettings('scan', { ...settings.scan, dependencyDepth: Number(e.target.value) })}
                            className={numberInputClass} />
                          <span className="text-xs text-slate-500">hops</span>
                        </div>
                      </Row>
                      <Row label="Auto re-scan" hint="Re-scan automatically after each change is completed">
                        <Toggle value={settings.scan.autoRescan}
                          onChange={v => patchSettings('scan', { ...settings.scan, autoRescan: v })} />
                      </Row>
                    </div>
                    {saveBar}
                  </>
                )}

                {/* Test Strategy */}
                {activeSection === 'test-strategy' && (
                  <>
                    <div className={sectionClass}>
                      <SectionTitle>Test Strategy</SectionTitle>
                      <Row label="Default" hint="Test selection approach for normal executions">
                        <SegmentedControl<TestDefault>
                          value={settings.testStrategy.default}
                          onChange={v => patchSettings('testStrategy', { ...settings.testStrategy, default: v })}
                          options={[
                            { value: 'scoped_first', label: 'Scoped first' },
                            { value: 'full_suite',   label: 'Full suite' },
                          ]}
                        />
                      </Row>
                      <Row label="High risk" hint="High-risk changes always run the full suite">
                        <span className="text-xs font-mono text-slate-500 bg-[#0f1929] border border-white/10 px-3 py-1.5 rounded-lg">Always full suite</span>
                      </Row>
                    </div>
                    {saveBar}
                  </>
                )}

                {/* Execution Environment */}
                {activeSection === 'exec-environment' && (
                  <>
                    <div className={sectionClass}>
                      <SectionTitle>Execution Environment</SectionTitle>
                      <Row label="Mode" hint="Where code changes are applied and tested">
                        <SegmentedControl<ExecMode>
                          value={settings.executionMode}
                          onChange={v => patchSettings('executionMode', v)}
                          options={[
                            { value: 'container', label: 'Container' },
                            { value: 'ci',        label: 'CI only' },
                            { value: 'hybrid',    label: 'Hybrid' },
                          ]}
                        />
                      </Row>
                    </div>
                    {saveBar}
                  </>
                )}

                {/* Notifications */}
                {activeSection === 'notifications' && (
                  <>
                    <div className={sectionClass}>
                      <SectionTitle>Notifications</SectionTitle>
                      <Row label="On failure">
                        <SegmentedControl<OnFailure>
                          value={settings.onFailure}
                          onChange={v => patchSettings('onFailure', v)}
                          options={[
                            { value: 'notify',         label: 'Notify' },
                            { value: 'create_change',  label: 'Create change' },
                            { value: 'nothing',        label: 'Silent' },
                          ]}
                        />
                      </Row>
                    </div>
                    {saveBar}
                  </>
                )}

                {/* Automation */}
                {activeSection === 'automation' && (
                  <>
                    <div className={sectionClass}>
                      <SectionTitle>Automation</SectionTitle>
                      <Row label="Auto-create on production error" hint="Creates a change request when a production error is detected">
                        <Toggle value={settings.automation.autoCreateOnError}
                          onChange={v => patchSettings('automation', { ...settings.automation, autoCreateOnError: v })} />
                      </Row>
                      <Row label="Suggest refactor on drift" hint="Flags components when dependency patterns shift significantly">
                        <Toggle value={settings.automation.suggestOnDrift}
                          onChange={v => patchSettings('automation', { ...settings.automation, suggestOnDrift: v })} />
                      </Row>
                    </div>
                    {saveBar}
                  </>
                )}

                {/* Env Vars */}
                {activeSection === 'env-vars' && (
                  <>
                    <div className={sectionClass}>
                      <SectionTitle>Environment Variables</SectionTitle>
                      <p className="text-xs text-slate-500">Injected into preview containers. Values are encrypted at rest and never exposed to the browser.</p>

                      {/* Key list */}
                      {envVarKeys.length > 0 && (
                        <div className="divide-y divide-white/5 rounded-lg overflow-hidden border border-white/10">
                          {envVarKeys.map(v => (
                            <div key={v.id} className="flex items-center justify-between px-3 py-2.5 bg-[#0f1929]">
                              <span className="text-xs font-mono text-slate-300">{v.key}</span>
                              <button
                                type="button"
                                onClick={async () => {
                                  const res = await fetch(`/api/projects/${project.id}/env-vars`, {
                                    method: 'DELETE', headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ key: v.key }),
                                  })
                                  if (!res.ok) { setVarError((await res.json()).error ?? 'Delete failed'); return }
                                  setEnvVarKeys(ks => ks.filter(k => k.id !== v.id))
                                }}
                                className="text-slate-600 hover:text-red-400 transition-colors"
                              >
                                <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>delete</span>
                              </button>
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Add var form */}
                      <div className="flex gap-2 items-end">
                        <div className="flex-1">
                          <label className={`${labelClass} block mb-1`}>Key</label>
                          <input value={newVarKey} onChange={e => setNewVarKey(e.target.value)} placeholder="DATABASE_URL" className={inputClass} />
                        </div>
                        <div className="flex-1">
                          <label className={`${labelClass} block mb-1`}>Value</label>
                          <input type="password" value={newVarValue} onChange={e => setNewVarValue(e.target.value)} placeholder="••••••••" className={inputClass} />
                        </div>
                        <button
                          type="button"
                          disabled={!newVarKey.trim() || addingVar}
                          onClick={async () => {
                            setAddingVar(true)
                            setVarError(null)
                            try {
                              const res = await fetch(`/api/projects/${project.id}/env-vars`, {
                                method: 'POST', headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ key: newVarKey.trim(), value: newVarValue }),
                              })
                              if (!res.ok) { setVarError((await res.json()).error ?? 'Failed'); return }
                              setEnvVarKeys(ks => [...ks.filter(k => k.key !== newVarKey.trim()), { id: Date.now().toString(), key: newVarKey.trim(), updated_at: new Date().toISOString() }])
                              setNewVarKey(''); setNewVarValue('')
                            } finally { setAddingVar(false) }
                          }}
                          className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold transition-colors disabled:opacity-50 whitespace-nowrap"
                        >
                          {addingVar ? 'Adding…' : 'Add'}
                        </button>
                      </div>
                      {varError && <p className="text-xs text-red-400">{varError}</p>}

                      {/* Import from .env.local */}
                      <div className="pt-2 border-t border-white/5">
                        <button
                          type="button"
                          disabled={importing}
                          onClick={async () => {
                            setImporting(true)
                            try {
                              const res = await fetch(`/api/projects/${project.id}/env-vars/import`, { method: 'POST' })
                              if (!res.ok) { setVarError((await res.json()).error ?? 'Import failed'); return }
                              const { pairs } = await res.json()
                              for (const { key, value } of pairs) {
                                await fetch(`/api/projects/${project.id}/env-vars`, {
                                  method: 'POST', headers: { 'Content-Type': 'application/json' },
                                  body: JSON.stringify({ key, value }),
                                })
                              }
                              const listRes = await fetch(`/api/projects/${project.id}/env-vars`)
                              setEnvVarKeys(await listRes.json())
                            } finally { setImporting(false) }
                          }}
                          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-[#0f1929] border border-white/10 hover:border-white/20 text-slate-300 transition-colors disabled:opacity-50"
                        >
                          <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>upload_file</span>
                          {importing ? 'Importing…' : 'Import from .env.local'}
                        </button>
                        <p className="text-[11px] text-slate-600 mt-1.5">Reads your local .env.local and saves all key/value pairs above. Review before importing.</p>
                      </div>

                    </div>
                  </>
                )}

                {/* Preview Config */}
                {activeSection === 'preview-config' && (
                  <>
                    <div className={sectionClass}>
                      <SectionTitle>Preview Configuration</SectionTitle>
                      <p className="text-xs text-slate-500">Controls how preview containers are started. Use "auto" to detect from the repo.</p>

                      <Row label="Install command" hint="auto detects from lockfile (pnpm/yarn/bun/npm)">
                        <input value={previewCfg.install_command} onChange={e => setPreviewCfg(c => ({ ...c, install_command: e.target.value }))}
                          placeholder="auto" className={`${inputClass} w-56`} />
                      </Row>
                      <Row label="Start command" hint="auto detects from package.json scripts">
                        <input value={previewCfg.start_command} onChange={e => setPreviewCfg(c => ({ ...c, start_command: e.target.value }))}
                          placeholder="auto" className={`${inputClass} w-56`} />
                      </Row>
                      <Row label="Working directory" hint="Relative path for monorepos">
                        <input value={previewCfg.work_dir} onChange={e => setPreviewCfg(c => ({ ...c, work_dir: e.target.value }))}
                          placeholder="." className={`${inputClass} w-40`} />
                      </Row>
                      <Row label="Health check path" hint="URL path polled to detect when app is ready">
                        <input value={previewCfg.health_path} onChange={e => setPreviewCfg(c => ({ ...c, health_path: e.target.value }))}
                          placeholder="/" className={`${inputClass} w-40`} />
                      </Row>
                      <Row label="Health check text" hint="Optional: response body must contain this string">
                        <input value={previewCfg.health_text ?? ''} onChange={e => setPreviewCfg(c => ({ ...c, health_text: e.target.value || null }))}
                          placeholder="(any 200 response)" className={`${inputClass} w-56`} />
                      </Row>
                      <Row label="App port (inside container)">
                        <div className="flex items-center gap-2">
                          <input type="number" value={previewCfg.port_internal} onChange={e => setPreviewCfg(c => ({ ...c, port_internal: Number(e.target.value) }))}
                            className={numberInputClass} />
                        </div>
                      </Row>
                      <Row label="Max memory" hint="Container memory limit">
                        <div className="flex items-center gap-2">
                          <input type="number" min={256} max={8192} step={256} value={previewCfg.max_memory_mb}
                            onChange={e => setPreviewCfg(c => ({ ...c, max_memory_mb: Number(e.target.value) }))} className={numberInputClass} />
                          <span className="text-xs text-slate-500">MB</span>
                        </div>
                      </Row>
                      <Row label="CPU shares" hint="512 ≈ ½ core, 1024 ≈ 1 core">
                        <input type="number" min={128} max={4096} step={128} value={previewCfg.max_cpu_shares}
                          onChange={e => setPreviewCfg(c => ({ ...c, max_cpu_shares: Number(e.target.value) }))} className={numberInputClass} />
                      </Row>
                    </div>

                    <div className="flex items-center gap-3 pt-2">
                      <button
                        type="button"
                        disabled={savingPreview}
                        onClick={async () => {
                          setSavingPreview(true); setPreviewSaveError(null); setPreviewSaveSuccess(false)
                          try {
                            const res = await fetch(`/api/projects/${project.id}/preview-config`, {
                              method: 'PUT', headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify(previewCfg),
                            })
                            if (!res.ok) { setPreviewSaveError((await res.json()).error ?? 'Save failed'); return }
                            setPreviewSaveSuccess(true)
                          } finally { setSavingPreview(false) }
                        }}
                        className="px-5 py-2 rounded-lg text-sm font-semibold bg-indigo-600 hover:bg-indigo-500 text-white transition-all disabled:opacity-50"
                      >
                        {savingPreview ? 'Saving…' : 'Save preview config'}
                      </button>
                      {previewSaveSuccess && <span className="text-xs text-emerald-400 font-medium">Saved</span>}
                      {previewSaveError && <span className="text-xs text-red-400">{previewSaveError}</span>}
                    </div>
                  </>
                )}

                {/* Model Health — read-only */}
                {activeSection === 'model-health' && modelHealth.componentCount > 0 && (
                  <div className={sectionClass}>
                    <SectionTitle>Model Health</SectionTitle>
                    <div className="grid grid-cols-2 gap-3">
                      {[
                        { label: 'Components', value: modelHealth.componentCount },
                        { label: 'Files scanned', value: modelHealth.fileCount },
                        { label: 'Completeness', value: `${completeness}%` },
                        { label: 'Avg confidence', value: `${modelHealth.avgConfidence}%` },
                        { label: 'Low confidence', value: modelHealth.lowConfCount },
                        { label: 'Unassigned files', value: Math.max(0, modelHealth.fileCount - modelHealth.assignedFileCount) },
                      ].map(({ label, value }) => (
                        <div key={label} className="rounded-lg bg-[#0f1929] border border-white/5 px-3 py-2.5">
                          <p className="text-[10px] uppercase tracking-widest text-slate-500 font-headline">{label}</p>
                          <p className="text-sm font-mono font-semibold text-slate-200 mt-0.5">{value}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* General */}
                {activeSection === 'general' && (
                  <>
                    <div className={sectionClass}>
                      <SectionTitle>General</SectionTitle>
                      <div>
                        <label className={`${labelClass} block mb-1.5`}>Project name</label>
                        <input value={name} onChange={e => setName(e.target.value)} required className={inputClass} placeholder="My project" />
                      </div>
                      <div>
                        <p className={labelClass}>Created</p>
                        <p className="text-sm text-slate-500 font-mono mt-1">{new Date(project.created_at).toLocaleString('en-GB')}</p>
                      </div>
                    </div>
                    {saveBar}
                  </>
                )}

                {/* Repository */}
                {activeSection === 'repository' && (
                  <>
                    <div className={sectionClass}>
                      <div>
                        <SectionTitle>Repository</SectionTitle>
                        <p className="text-xs text-slate-500 mt-1">GitHub repository used for scanning and change execution.</p>
                      </div>
                      <div>
                        <label className={`${labelClass} block mb-1.5`}>Repository URL</label>
                        <input value={repoUrl} onChange={e => setRepoUrl(e.target.value)} required placeholder="https://github.com/org/repo" className={inputClass} />
                      </div>
                      <div>
                        <label className={`${labelClass} block mb-1.5`}>Access token</label>
                        <div className="relative">
                          <input
                            type={showToken ? 'text' : 'password'}
                            value={repoToken}
                            onChange={e => setRepoToken(e.target.value)}
                            required={!project.repo_token}
                            placeholder={project.repo_token ? '••••••••••••••••' : 'ghp_...'}
                            className={`${inputClass} pr-10`}
                          />
                          <button type="button" onClick={() => setShowToken(v => !v)}
                            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 transition-colors">
                            <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>{showToken ? 'visibility_off' : 'visibility'}</span>
                          </button>
                        </div>
                        <p className="text-[11px] text-slate-600 mt-1.5">
                          Needs <span className="font-mono text-slate-500">repo</span> scope.{' '}
                          {project.repo_token ? 'Leave blank to keep current token.' : ''}
                        </p>
                      </div>
                    </div>
                    {saveBar}
                  </>
                )}
              </form>

              {/* Danger Zone */}
              {activeSection === 'danger-zone' && (
                <section className="rounded-xl border border-red-500/20 p-6 space-y-4">
                  <h2 className="text-sm font-bold text-red-400 font-headline">Danger zone</h2>
                  <p className="text-sm text-slate-400">
                    Permanently delete <span className="font-semibold text-slate-200">{project.name}</span> and all its data. This cannot be undone.
                  </p>
                  <div className="flex items-center gap-4 text-xs font-mono text-slate-500">
                    <span>{dangerStats.componentCount} components</span>
                    <span className="text-slate-700">·</span>
                    <span>{dangerStats.changeCount} changes</span>
                    <span className="text-slate-700">·</span>
                    <span>{dangerStats.executionCount} executions</span>
                  </div>
                  <div className="space-y-2">
                    <label className={labelClass}>
                      Type <span className="font-mono text-slate-300 normal-case tracking-normal">{project.name}</span> to confirm
                    </label>
                    <input value={deleteConfirm} onChange={e => setDeleteConfirm(e.target.value)}
                      placeholder={project.name}
                      className="rounded-lg px-3 py-2 text-sm outline-none transition-all bg-[#0f1929] border border-white/10 text-slate-200 placeholder:text-slate-600 focus:border-red-500 font-mono w-full" />
                  </div>
                  {deleteError && <p className="text-xs text-red-400">{deleteError}</p>}
                  <button onClick={handleDelete} disabled={deleteConfirm !== project.name || deleting}
                    className="px-5 py-2 rounded-lg text-sm font-semibold bg-red-600/20 text-red-300 border border-red-500/30 hover:bg-red-600/30 transition-all disabled:opacity-40 disabled:cursor-not-allowed">
                    {deleting ? 'Deleting…' : 'Delete project'}
                  </button>
                </section>
              )}

              </div>
              </div>
          </div>
        </main>
      </div>
    </div>
  )
}
