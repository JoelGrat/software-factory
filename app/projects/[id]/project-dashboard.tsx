'use client'
import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { LeftNav } from '@/components/app/left-nav'
import { ProfileAvatar } from '@/components/app/profile-avatar'
import { useAnalysisStream } from '@/hooks/use-analysis-stream'
import { ActiveChanges } from './components/active-changes'
import { RecentOutcomes } from './components/recent-outcomes'
import { RiskRadar } from './components/risk-radar'
import { NextBestActions } from './components/next-best-actions'
import { QuickStart } from './components/quick-start'
import { SystemSignals } from './components/system-signals'

interface Project {
  id: string; name: string; scan_status: string; scan_error: string | null
  scan_progress: number | null; repo_url: string | null; created_at: string
}
interface Stats {
  fileCount: number; componentCount: number; edgeCount: number
  lowConfidenceCount: number; unstableCount: number; avgConfidence: number
}
interface ComponentItem {
  id: string; name: string; type: string; status: string; is_anchored: boolean
  fileCount: number; confidence: number; incomingDeps: number; outgoingDeps: number
}
interface Change {
  id: string; title: string; type: string; priority: string
  status: string; risk_level: string | null; analysis_status: string; created_at: string; updated_at: string
}

const TYPE_COLORS: Record<string, string> = {
  api: 'text-indigo-400 bg-indigo-400/10', service: 'text-blue-400 bg-blue-400/10',
  db: 'text-emerald-400 bg-emerald-400/10', ui: 'text-purple-400 bg-purple-400/10',
  module: 'text-slate-400 bg-slate-400/10',
}
const RISK_COLORS: Record<string, string> = {
  low: 'text-green-400 bg-green-400/10', medium: 'text-amber-400 bg-amber-400/10', high: 'text-red-400 bg-red-400/10',
}
const STATUS_COLORS: Record<string, string> = {
  open: 'text-slate-400 bg-slate-400/10', analyzing: 'text-indigo-400 bg-indigo-400/10',
  analyzing_mapping: 'text-indigo-400 bg-indigo-400/10', analyzing_propagation: 'text-indigo-400 bg-indigo-400/10',
  analyzing_scoring: 'text-indigo-400 bg-indigo-400/10', analyzed: 'text-blue-400 bg-blue-400/10',
  planned: 'text-purple-400 bg-purple-400/10', executing: 'text-amber-400 bg-amber-400/10',
  review: 'text-orange-400 bg-orange-400/10', done: 'text-green-400 bg-green-400/10',
  failed: 'text-red-400 bg-red-400/10',
}
const CHANGE_TYPE_COLORS: Record<string, string> = {
  bug: 'text-red-400 bg-red-400/10', feature: 'text-indigo-400 bg-indigo-400/10',
  refactor: 'text-amber-400 bg-amber-400/10', hotfix: 'text-orange-400 bg-orange-400/10',
}

function Badge({ label, colorClass }: { label: string; colorClass: string }) {
  return (
    <span className={`text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded font-mono ${colorClass}`}>
      {label}
    </span>
  )
}

// ── Helpers ───────────────────────────────────────────────────────────────────

interface Recommendation {
  id: string
  type: 'risk' | 'structural' | 'hotspot' | 'coverage'
  icon: string
  headline: string
  reasons: string[]
  impact: string
  suggestedAction: string
  changeTitle: string
  score: number
}

function generateRecommendations(components: ComponentItem[]): Recommendation[] {
  const candidates: Recommendation[] = []

  for (const c of components) {
    // 1. Risk: high incoming deps + low/medium confidence
    if (c.incomingDeps >= 3 && c.confidence < 75) {
      candidates.push({
        id: `risk-${c.id}`,
        type: 'risk',
        icon: '⚠',
        headline: `Reduce risk in ${c.name}`,
        reasons: [
          `Used by ${c.incomingDeps} component${c.incomingDeps !== 1 ? 's' : ''}`,
          `Confidence: ${c.confidence}%`,
        ],
        impact: `Changes propagate to ${c.incomingDeps} downstream component${c.incomingDeps !== 1 ? 's' : ''}`,
        suggestedAction: 'Stabilize public interfaces and reduce coupling',
        changeTitle: `Stabilize interfaces in ${c.name}`,
        score: c.incomingDeps * 3 + Math.round((100 - c.confidence) / 10),
      })
    }

    // 2. Structural: many files, potential mixed responsibilities
    if (c.fileCount >= 6) {
      candidates.push({
        id: `structural-${c.id}`,
        type: 'structural',
        icon: '🧩',
        headline: `Split oversized component: ${c.name}`,
        reasons: [
          `${c.fileCount} files — likely mixed responsibilities`,
          c.incomingDeps > 0
            ? `Used by ${c.incomingDeps} component${c.incomingDeps !== 1 ? 's' : ''}`
            : `${c.outgoingDeps} outgoing dependencies`,
        ],
        impact: 'Large components are harder to test and change safely',
        suggestedAction: 'Separate into focused, single-responsibility modules',
        changeTitle: `Refactor ${c.name} into focused modules`,
        score: Math.round(c.fileCount / 2) + c.incomingDeps + 3,
      })
    }

    // 3. Hotspot: entry point with high outgoing dep count
    if (c.is_anchored && c.outgoingDeps >= 3) {
      candidates.push({
        id: `hotspot-${c.id}`,
        type: 'hotspot',
        icon: '🔥',
        headline: `Harden core component: ${c.name}`,
        reasons: [
          'Entry point — directly exposed to external input',
          `Depends on ${c.outgoingDeps} component${c.outgoingDeps !== 1 ? 's' : ''}`,
        ],
        impact: 'Failures here are user-visible and blast-radius is high',
        suggestedAction: 'Add input validation, error handling, and observability',
        changeTitle: `Harden error handling in ${c.name}`,
        score: c.outgoingDeps + c.incomingDeps * 3 + 2,
      })
    }

    // 4. Coverage gap: widely used component with no detectable type signals
    if (c.incomingDeps >= 2 && c.confidence <= 50) {
      candidates.push({
        id: `coverage-${c.id}`,
        type: 'coverage',
        icon: '🧪',
        headline: `Add test coverage: ${c.name}`,
        reasons: [
          `Used by ${c.incomingDeps} component${c.incomingDeps !== 1 ? 's' : ''}`,
          'No strong type signals — regression risk unquantified',
        ],
        impact: 'Untested shared components multiply risk across dependents',
        suggestedAction: 'Add unit tests covering the public interface',
        changeTitle: `Add test coverage for ${c.name}`,
        score: c.incomingDeps * 2 + Math.max(0, 70 - c.confidence) + 2,
      })
    }
  }

  // One recommendation per component (highest score wins)
  const byComp = new Map<string, Recommendation>()
  for (const r of candidates) {
    const key = r.id.split('-').slice(1).join('-') // component id
    const existing = byComp.get(key)
    if (!existing || r.score > existing.score) byComp.set(key, r)
  }

  return [...byComp.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
}

function getHotspots(components: ComponentItem[]) {
  return [...components]
    .filter(c => c.incomingDeps > 0 || c.outgoingDeps > 0)
    .sort((a, b) => (b.incomingDeps * 2 + b.outgoingDeps) - (a.incomingDeps * 2 + a.outgoingDeps))
    .slice(0, 5)
}

export function ProjectDashboard({
  project: initial, initialChanges, initialStats, initialComponents,
  initialSnapshots, initialActiveChanges,
  initialRiskScores, initialActionItems, signalSnapshot,
}: {
  project: Project; initialChanges: Change[]; initialStats: Stats
  initialComponents: ComponentItem[]
  initialSnapshots: any[]
  initialActiveChanges: Array<{ id: string; title: string; status: string; analysis_status: string; risk_level: string | null; updated_at: string }>
  initialRiskScores: Array<{ componentId: string; componentName: string; riskScore: number; tier: 'HIGH' | 'MEDIUM'; incomingDeps: number }>
  initialActionItems: Array<{ id: string; tier: number; source: string; priorityScore: number; payload: any }>
  signalSnapshot: any | null
}) {
  const router = useRouter()

  function openQuickStart() {
    window.dispatchEvent(new CustomEvent('open-quick-start', { detail: {} }))
  }

  const { events } = useAnalysisStream(initial.id)

  const changeNames: Record<string, string> = {}
  for (const c of initialChanges) changeNames[c.id] = c.title

  const project = initial
  const changes = initialChanges
  const stats = initialStats
  const components = initialComponents

  const isReady = project.scan_status === 'ready'
  const hotspots = getHotspots(components)
  const recommendations = isReady ? generateRecommendations(components) : []
  const doneChanges = changes.filter(c => c.status === 'done').length
  const hasData = components.length > 0

  return (
    <div className="flex flex-col h-screen bg-[#0b1326] text-on-surface overflow-hidden">
      <header className="w-full h-16 flex-shrink-0 flex items-center justify-between px-6 bg-[#0b1326] border-b border-white/5 z-50">
        <div className="flex items-center gap-2 text-sm">
          <Link href="/projects" className="font-black text-indigo-400 tracking-tighter hover:text-indigo-300 transition-colors">FactoryOS</Link>
          <span className="text-slate-600">/</span>
          <span className="text-slate-200 font-medium truncate max-w-[240px]">{project.name}</span>
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
        <LeftNav projectId={project.id} projectName={project.name} />
        <main className="flex-1 overflow-y-auto p-8">
          <div className="max-w-5xl mx-auto space-y-5">

            {/* Active Changes + Recent Outcomes */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <ActiveChanges
                projectId={project.id}
                initialChanges={initialActiveChanges.map(c => ({
                  id: c.id,
                  title: c.title,
                  status: c.status,
                  analysisStatus: c.analysis_status,
                  risk_level: c.risk_level ?? '',
                  updated_at: c.updated_at,
                }))}
                events={events}
                onCreateChange={openQuickStart}
              />
              <RecentOutcomes
                snapshots={initialSnapshots as any}
                changeNames={changeNames}
              />
            </div>

            {/* Risk Radar + Next Best Actions */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <RiskRadar riskScores={initialRiskScores} projectId={project.id} />
              <NextBestActions actionItems={initialActionItems} />
            </div>

            {/* System Signals (full width) */}
            <SystemSignals
              snapshot={signalSnapshot}
              avgConfidence={initialStats.avgConfidence}
              componentCount={initialStats.componentCount}
            />

            {/* Quick Start panel (floating) */}
            <QuickStart
              projectId={project.id}
              onChangeCreated={() => {
                router.refresh()
              }}
            />

            {/* Hotspots + Next Steps */}
            {isReady && hasData && (
              <div className="grid grid-cols-2 gap-4">

                {/* Hotspots */}
                <div className="rounded-xl bg-[#131b2e] border border-white/5 p-5">
                  <h2 className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-4">
                    <span className="mr-1">🔥</span>Hotspots
                  </h2>
                  {hotspots.length === 0 ? (
                    <p className="text-xs text-slate-600">No cross-component dependencies yet.</p>
                  ) : (
                    <div className="space-y-2">
                      {hotspots.map(c => (
                        <div key={c.id} className="flex items-center gap-2">
                          <span className={`text-[10px] font-mono font-bold px-1 py-0.5 rounded flex-shrink-0 ${TYPE_COLORS[c.type] ?? 'text-slate-400 bg-slate-400/10'}`}>{c.type}</span>
                          <span className="text-xs text-slate-300 truncate flex-1">{c.name}</span>
                          <div className="flex items-center gap-1.5 flex-shrink-0 text-[10px] font-mono text-slate-500">
                            {c.incomingDeps > 0 && <span className="text-amber-400/80">↙{c.incomingDeps}</span>}
                            {c.outgoingDeps > 0 && <span>↗{c.outgoingDeps}</span>}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Next Steps + Learning Status */}
                <div className="rounded-xl bg-[#131b2e] border border-white/5 p-5 flex flex-col gap-4">
                  <div>
                    <h2 className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-3">
                      <span className="mr-1">🚀</span>Next Steps
                    </h2>
                    <div className="space-y-2">
                      <Link href={`/projects/${project.id}/changes/new`} className="flex items-center gap-2 text-xs text-indigo-300 hover:text-indigo-200 transition-colors">
                        <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>add_circle</span>
                        Create a change request
                      </Link>
                      <Link href={`/projects/${project.id}/system-model`} className="flex items-center gap-2 text-xs text-slate-400 hover:text-slate-300 transition-colors">
                        <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>account_tree</span>
                        Explore system model
                      </Link>
                      {stats.unstableCount > 0 && (
                        <Link href={`/projects/${project.id}/system-model`} className="flex items-center gap-2 text-xs text-amber-400/80 hover:text-amber-400 transition-colors">
                          <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>warning</span>
                          Review {stats.unstableCount} unstable component{stats.unstableCount > 1 ? 's' : ''}
                        </Link>
                      )}
                    </div>
                  </div>

                  <div className="border-t border-white/5 pt-3">
                    <p className="text-[10px] text-slate-500 uppercase tracking-widest mb-1">Learning status</p>
                    {doneChanges === 0 ? (
                      <p className="text-xs text-slate-600">No changes analyzed yet</p>
                    ) : (
                      <p className="text-xs text-slate-400">Learning from <span className="text-indigo-300 font-mono">{doneChanges}</span> past change{doneChanges > 1 ? 's' : ''}</p>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Suggested Improvements */}
            {isReady && recommendations.length > 0 && (
              <div>
                <h2 className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-3">
                  💡 Suggested Improvements
                </h2>
                <div className="space-y-2">
                  {recommendations.map(r => {
                    const typeColor =
                      r.type === 'risk' ? 'border-amber-500/20 bg-amber-500/3' :
                      r.type === 'structural' ? 'border-blue-500/20 bg-blue-500/3' :
                      r.type === 'hotspot' ? 'border-red-500/20 bg-red-500/3' :
                      'border-emerald-500/20 bg-emerald-500/3'
                    return (
                      <div key={r.id} className={`rounded-xl border p-4 ${typeColor}`}>
                        <div className="flex items-start justify-between gap-4">
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-semibold text-slate-200 mb-1">
                              <span className="mr-1.5">{r.icon}</span>{r.headline}
                            </p>
                            <ul className="space-y-0.5 mb-2">
                              {r.reasons.map(reason => (
                                <li key={reason} className="text-xs text-slate-500 flex items-center gap-1.5">
                                  <span className="text-slate-600">·</span>{reason}
                                </li>
                              ))}
                            </ul>
                            <p className="text-xs text-slate-400 mb-2">
                              <span className="text-slate-600">Impact: </span>{r.impact}
                            </p>
                            <p className="text-xs text-slate-500">
                              <span className="text-slate-600">→ </span>{r.suggestedAction}
                            </p>
                          </div>
                          <Link
                            href={`/projects/${project.id}/changes/new?title=${encodeURIComponent(r.changeTitle)}`}
                            className="flex-shrink-0 flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-semibold bg-indigo-600/20 text-indigo-300 hover:bg-indigo-600/30 border border-indigo-500/20 transition-colors whitespace-nowrap"
                          >
                            Create Change
                            <span className="material-symbols-outlined" style={{ fontSize: '13px' }}>arrow_forward</span>
                          </Link>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            {/* Changes */}
            {isReady && (
              <div>
                <div className="flex items-center justify-between mb-3">
                  <h2 className="text-sm font-bold text-slate-300">Changes</h2>
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-slate-500 font-mono">{changes.length} total</span>
                    <button
                      onClick={() => openQuickStart()}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-indigo-500 hover:bg-indigo-400 text-white transition-colors"
                    >
                      <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>add</span>
                      New Change
                    </button>
                  </div>
                </div>

                {changes.length === 0 ? (
                  <div className="rounded-xl p-8 bg-[#131b2e] border border-white/5">
                    <p className="text-sm text-slate-400 font-medium mb-1">No changes yet</p>
                    <p className="text-xs text-slate-600 mb-4">Start by describing a change to your system.</p>
                    <div className="space-y-2 mb-4">
                      {['Fix login session expiry bug', 'Add user roles and permissions', 'Refactor API authentication layer'].map(ex => (
                        <button
                          key={ex}
                          onClick={() => openQuickStart()}
                          className="flex items-center gap-2 text-xs text-slate-400 hover:text-indigo-300 transition-colors"
                        >
                          <span className="material-symbols-outlined text-slate-600" style={{ fontSize: '14px' }}>arrow_forward</span>
                          {ex}
                        </button>
                      ))}
                    </div>
                    <button
                      onClick={() => openQuickStart()}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-indigo-600/20 text-indigo-300 hover:bg-indigo-600/30 transition-colors border border-indigo-500/20"
                    >
                      <span className="material-symbols-outlined" style={{ fontSize: '13px' }}>add</span>
                      New Change Request
                    </button>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {changes.map(c => (
                      <Link key={c.id} href={`/projects/${project.id}/changes/${c.id}`} className="flex items-center gap-4 px-5 py-4 rounded-xl bg-[#131b2e] border border-white/5 hover:border-white/10 hover:bg-[#171f33] transition-all">
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-semibold text-on-surface truncate">{c.title}</p>
                          <p className="text-xs text-slate-500 mt-0.5">{new Date(c.updated_at).toLocaleDateString('en-GB')}</p>
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0">
                          <Badge label={c.type} colorClass={CHANGE_TYPE_COLORS[c.type] ?? 'text-slate-400 bg-slate-400/10'} />
                          {c.risk_level && <Badge label={c.risk_level} colorClass={RISK_COLORS[c.risk_level] ?? 'text-slate-400 bg-slate-400/10'} />}
                          <Badge label={c.status.replace(/_/g, ' ')} colorClass={STATUS_COLORS[c.status] ?? 'text-slate-400 bg-slate-400/10'} />
                          <span className="material-symbols-outlined text-slate-600" style={{ fontSize: '16px' }}>chevron_right</span>
                        </div>
                      </Link>
                    ))}
                  </div>
                )}
              </div>
            )}

          </div>
        </main>
      </div>

    </div>
  )
}
