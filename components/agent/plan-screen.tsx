'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import type { AgentPlan, PlanTask } from '@/lib/supabase/types'
import { JobShell } from '@/components/agent/job-shell'
import { StepIndicator } from '@/components/agent/step-indicator'
import { MarkdownView } from '@/components/ui/markdown-view'

type Tab = 'tasks' | 'spec'

interface Props {
  jobId: string
  projectId: string
  projectName: string
  plan: AgentPlan
}

export function PlanScreen({ jobId, projectId, projectName, plan }: Props) {
  const router = useRouter()
  const [tasks, setTasks] = useState<PlanTask[]>(plan.tasks as PlanTask[])
  const [activeTab, setActiveTab] = useState<Tab>('tasks')
  const [savingTasks, setSavingTasks] = useState(false)
  const [taskError, setTaskError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [approving, setApproving] = useState(false)
  const [approveError, setApproveError] = useState<string | null>(null)

  async function updateTasks(updated: PlanTask[]) {
    setSavingTasks(true)
    setTaskError(null)
    const res = await fetch(`/api/jobs/${jobId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'update_tasks', tasks: updated }),
    })
    setSavingTasks(false)
    if (!res.ok) {
      const d = await res.json()
      setTaskError(d.error ?? 'Failed to save tasks')
      return false
    }
    setTasks(updated)
    return true
  }

  async function approvePlan() {
    setApproving(true)
    setApproveError(null)
    try {
      const res = await fetch(`/api/jobs/${jobId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'approve_plan' }),
      })
      if (!res.ok) { setApproveError('Failed to approve plan. Please try again.'); return }
      router.push(`/projects/${projectId}/jobs/${jobId}/execution`)
    } catch {
      setApproveError('Failed to approve plan. Please try again.')
    } finally {
      setApproving(false)
    }
  }

  async function cancel() {
    try {
      await fetch(`/api/jobs/${jobId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'cancel' }),
      })
    } catch { /* best-effort */ }
    router.push(`/projects/${projectId}/requirements`)
  }

  const totalFiles = plan.files_to_create.length + plan.files_to_modify.length

  const sidebar = (
    <div className="p-5 space-y-4">
      <div className="p-3 bg-surface-container rounded-lg border border-white/5">
        <div className="text-[10px] text-slate-500 uppercase font-bold font-headline mb-1">Branch</div>
        <code className="text-xs font-mono text-indigo-300 break-all">{plan.branch_name || 'not yet created'}</code>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="p-3 bg-surface-container rounded-lg border border-white/5 text-center">
          <div className="text-[10px] text-slate-500 uppercase font-bold font-headline mb-1">Create</div>
          <div className="text-xl font-bold font-headline text-[#22c55e]">{plan.files_to_create.length}</div>
        </div>
        <div className="p-3 bg-surface-container rounded-lg border border-white/5 text-center">
          <div className="text-[10px] text-slate-500 uppercase font-bold font-headline mb-1">Modify</div>
          <div className="text-xl font-bold font-headline text-[#f59e0b]">{plan.files_to_modify.length}</div>
        </div>
      </div>
      <div className="p-3 bg-surface-container rounded-lg border border-white/5">
        <div className="text-[10px] text-slate-500 uppercase font-bold font-headline mb-1">Tasks</div>
        <div className="text-xl font-bold font-headline text-indigo-100">{tasks.length}</div>
      </div>
      {plan.test_approach && (
        <div className="p-3 bg-surface-container rounded-lg border border-white/5">
          <div className="text-[10px] text-slate-500 uppercase font-bold font-headline mb-2">Test Approach</div>
          <p className="text-xs text-slate-400 leading-relaxed">{plan.test_approach}</p>
        </div>
      )}
    </div>
  )

  return (
    <JobShell projectName={projectName} projectId={projectId} jobId={jobId} sidebar={sidebar} sidebarTitle="Plan Summary">
      <div className="max-w-4xl mx-auto space-y-6">
        <StepIndicator current={3} />

        {/* Header */}
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 flex-wrap">
            <code className="text-xs font-mono text-indigo-300 bg-indigo-500/10 border border-indigo-500/20 px-2 py-1 rounded-lg">
              {plan.branch_name || 'branch pending'}
            </code>
            <span className="text-xs text-[#22c55e] font-mono">+{plan.files_to_create.length} create</span>
            <span className="text-xs text-[#f59e0b] font-mono">~{plan.files_to_modify.length} modify</span>
          </div>
          <div className="flex items-center gap-3 flex-shrink-0">
            <button
              onClick={cancel}
              className="text-xs font-bold text-slate-500 hover:text-white transition-colors uppercase tracking-widest px-4 py-2"
            >
              Cancel
            </button>
            {confirming ? (
              <div className="flex items-center gap-3 px-4 py-2.5 rounded-lg bg-surface-container border border-white/10">
                <p className="text-xs text-slate-400">
                  Create <code className="text-indigo-300 font-mono">{plan.branch_name}</code> and start coding —{' '}
                  <span className="text-white font-semibold">{tasks.length} tasks</span>,{' '}
                  <span className="text-white font-semibold">{totalFiles} files</span>.
                </p>
                <button
                  onClick={() => setConfirming(false)}
                  className="text-xs text-slate-500 hover:text-slate-300 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={approvePlan}
                  disabled={approving}
                  className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-headline font-bold bg-gradient-to-br from-primary to-primary-container text-on-primary-container disabled:opacity-50 hover:scale-[1.02] active:scale-95 transition-all"
                >
                  {approving ? 'Starting...' : 'Confirm & Start →'}
                </button>
              </div>
            ) : (
              <button
                onClick={() => setConfirming(true)}
                className="bg-gradient-to-br from-primary to-primary-container text-on-primary-container px-6 py-2.5 rounded-lg font-headline font-extrabold text-sm flex items-center gap-2 shadow-[0_4px_20px_rgba(189,194,255,0.2)] hover:scale-[1.02] transition-transform active:scale-95"
              >
                Approve & Start Execution
                <span className="material-symbols-outlined text-[16px]">arrow_forward</span>
              </button>
            )}
          </div>
        </div>

        {approveError && <p className="text-xs text-error font-mono">{approveError}</p>}

        {/* Tab bar */}
        <div className="flex gap-1 p-1 rounded-lg" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', display: 'inline-flex' }}>
          {([
            { id: 'tasks' as Tab, label: `Tasks (${tasks.length})` },
            { id: 'spec' as Tab, label: 'Spec File' },
          ]).map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className="px-4 py-2 rounded-md text-sm transition-all"
              style={{
                background: activeTab === tab.id ? 'var(--bg-elevated)' : 'transparent',
                color: activeTab === tab.id ? 'var(--text-primary)' : 'var(--text-muted)',
                fontFamily: 'var(--font-syne)',
                fontWeight: activeTab === tab.id ? '600' : '400',
                border: activeTab === tab.id ? '1px solid var(--border-default)' : '1px solid transparent',
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Tasks tab */}
        {activeTab === 'tasks' && (
          <TaskList
            tasks={tasks}
            saving={savingTasks}
            error={taskError}
            onUpdate={updateTasks}
          />
        )}

        {/* Spec tab */}
        {activeTab === 'spec' && (
          <div className="bg-surface-container rounded-xl border border-white/5 overflow-hidden">
            {plan.spec_markdown ? (
              <MarkdownView className="p-6">{plan.spec_markdown}</MarkdownView>
            ) : (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <span className="material-symbols-outlined text-slate-600 mb-3" style={{ fontSize: '32px' }}>description</span>
                <p className="text-slate-500 text-sm">No spec file was generated for this plan.</p>
              </div>
            )}
          </div>
        )}
      </div>
    </JobShell>
  )
}

// ── TaskList ──────────────────────────────────────────────────────────────────

interface TaskListProps {
  tasks: PlanTask[]
  saving: boolean
  error: string | null
  onUpdate: (tasks: PlanTask[]) => Promise<boolean>
}

interface EditForm {
  title: string
  description: string
  files: string
}

const EMPTY_FORM: EditForm = { title: '', description: '', files: '' }

function TaskList({ tasks, saving, error, onUpdate }: TaskListProps) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editForm, setEditForm] = useState<EditForm>(EMPTY_FORM)
  const [adding, setAdding] = useState(false)
  const [newForm, setNewForm] = useState<EditForm>(EMPTY_FORM)

  function startEdit(task: PlanTask) {
    setEditingId(task.id)
    setEditForm({ title: task.title, description: task.description, files: task.files.join(', ') })
  }

  async function saveEdit() {
    const updated = tasks.map(t =>
      t.id === editingId
        ? { ...t, title: editForm.title.trim(), description: editForm.description.trim(), files: editForm.files.split(',').map(f => f.trim()).filter(Boolean) }
        : t
    )
    const ok = await onUpdate(updated)
    if (ok) setEditingId(null)
  }

  async function deleteTask(id: string) {
    const updated = tasks.filter(t => t.id !== id)
    await onUpdate(updated)
  }

  async function saveNewTask() {
    if (!newForm.title.trim()) return
    const newTask: PlanTask = {
      id: `task-${tasks.length + 1}`,
      title: newForm.title.trim(),
      description: newForm.description.trim(),
      files: newForm.files.split(',').map(f => f.trim()).filter(Boolean),
      dependencies: [],
    }
    const ok = await onUpdate([...tasks, newTask])
    if (ok) { setAdding(false); setNewForm(EMPTY_FORM) }
  }

  const inputStyle = {
    background: 'var(--bg-surface)',
    border: '1px solid var(--border-default)',
    color: 'var(--text-primary)',
    fontFamily: 'var(--font-jetbrains)',
    fontSize: '12px',
  }

  return (
    <div className="space-y-2">
      {error && <p className="text-xs text-error font-mono mb-2">{error}</p>}

      {tasks.map((task, i) => (
        <div key={task.id} className="group bg-surface-container rounded-xl border border-white/5 transition-all hover:border-white/10">
          {editingId === task.id ? (
            /* Edit mode */
            <div className="p-4 space-y-2">
              <input
                autoFocus
                value={editForm.title}
                onChange={e => setEditForm(p => ({ ...p, title: e.target.value }))}
                placeholder="Task title"
                className="w-full rounded-lg px-3 py-2 text-sm outline-none"
                style={inputStyle}
              />
              <textarea
                value={editForm.description}
                onChange={e => setEditForm(p => ({ ...p, description: e.target.value }))}
                placeholder="Description"
                rows={2}
                className="w-full rounded-lg px-3 py-2 text-sm resize-none outline-none"
                style={inputStyle}
              />
              <input
                value={editForm.files}
                onChange={e => setEditForm(p => ({ ...p, files: e.target.value }))}
                placeholder="Files (comma-separated)"
                className="w-full rounded-lg px-3 py-2 text-sm outline-none"
                style={inputStyle}
              />
              <div className="flex gap-2 justify-end">
                <button onClick={() => setEditingId(null)} className="px-3 py-1 rounded-lg text-xs text-slate-400 hover:text-slate-200 transition-colors">
                  Cancel
                </button>
                <button
                  onClick={saveEdit}
                  disabled={!editForm.title.trim() || saving}
                  className="flex items-center gap-1 px-3 py-1 rounded-lg text-xs font-bold bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 disabled:opacity-40 transition-all"
                >
                  <span className="material-symbols-outlined" style={{ fontSize: '13px' }}>check</span>
                  {saving ? 'Saving...' : 'Save'}
                </button>
              </div>
            </div>
          ) : (
            /* View mode */
            <div className="flex gap-3 items-start p-4">
              <span className="text-xs font-mono text-indigo-400 min-w-[20px] mt-0.5 flex-shrink-0">{i + 1}</span>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-on-surface mb-1">{task.title}</p>
                <p className="text-xs text-slate-400 mb-2">{task.description}</p>
                <div className="flex gap-1.5 flex-wrap">
                  {task.files.map(f => (
                    <span key={f} className="text-[10px] text-slate-500 font-mono bg-surface-container-high px-1.5 py-0.5 rounded">{f}</span>
                  ))}
                </div>
              </div>
              <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                <button
                  onClick={() => startEdit(task)}
                  className="p-1.5 rounded-lg text-slate-500 hover:text-slate-200 hover:bg-white/5 transition-all"
                  title="Edit task"
                >
                  <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>edit</span>
                </button>
                <button
                  onClick={() => deleteTask(task.id)}
                  disabled={saving}
                  className="p-1.5 rounded-lg text-slate-500 hover:text-error hover:bg-error/5 transition-all disabled:opacity-30"
                  title="Delete task"
                >
                  <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>delete</span>
                </button>
              </div>
            </div>
          )}
        </div>
      ))}

      {/* Add task */}
      {adding ? (
        <div className="rounded-xl border border-indigo-500/20 bg-indigo-500/5 p-4 space-y-2">
          <input
            autoFocus
            value={newForm.title}
            onChange={e => setNewForm(p => ({ ...p, title: e.target.value }))}
            placeholder="Task title"
            className="w-full rounded-lg px-3 py-2 text-sm outline-none"
            style={inputStyle}
          />
          <textarea
            value={newForm.description}
            onChange={e => setNewForm(p => ({ ...p, description: e.target.value }))}
            placeholder="Description"
            rows={2}
            className="w-full rounded-lg px-3 py-2 text-sm resize-none outline-none"
            style={inputStyle}
          />
          <input
            value={newForm.files}
            onChange={e => setNewForm(p => ({ ...p, files: e.target.value }))}
            placeholder="Files (comma-separated)"
            className="w-full rounded-lg px-3 py-2 text-sm outline-none"
            style={inputStyle}
          />
          <div className="flex gap-2 justify-end">
            <button onClick={() => { setAdding(false); setNewForm(EMPTY_FORM) }} className="px-3 py-1 rounded-lg text-xs text-slate-400 hover:text-slate-200 transition-colors">
              Cancel
            </button>
            <button
              onClick={saveNewTask}
              disabled={!newForm.title.trim() || saving}
              className="flex items-center gap-1 px-3 py-1 rounded-lg text-xs font-bold bg-gradient-to-br from-primary to-primary-container text-on-primary-container disabled:opacity-40 transition-all"
            >
              <span className="material-symbols-outlined" style={{ fontSize: '13px' }}>add</span>
              {saving ? 'Saving...' : 'Add Task'}
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setAdding(true)}
          className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl border border-dashed border-white/10 text-xs text-slate-500 hover:text-slate-300 hover:border-white/20 transition-all font-headline font-bold uppercase tracking-wider"
        >
          <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>add</span>
          Add Task
        </button>
      )}
    </div>
  )
}
