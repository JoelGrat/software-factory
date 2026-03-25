import type { GapSeverity, GapCategory, GapSource, TargetRole, QuestionStatus, TaskStatus } from '@/lib/supabase/types'

type BadgeVariant = GapSeverity | GapCategory | GapSource | TargetRole | QuestionStatus | TaskStatus | 'draft' | 'analyzing' | 'incomplete' | 'review_required' | 'ready_for_dev' | 'blocked'

const VARIANT_CLASSES: Record<string, string> = {
  // severity
  critical: 'bg-red-100 text-red-800',
  major: 'bg-orange-100 text-orange-800',
  minor: 'bg-yellow-100 text-yellow-800',
  // category
  missing: 'bg-red-50 text-red-700',
  ambiguous: 'bg-purple-100 text-purple-800',
  conflicting: 'bg-orange-50 text-orange-700',
  incomplete: 'bg-yellow-50 text-yellow-700',
  // source
  rule: 'bg-gray-100 text-gray-700',
  ai: 'bg-blue-100 text-blue-700',
  pattern: 'bg-indigo-100 text-indigo-700',
  // target role
  ba: 'bg-teal-100 text-teal-800',
  architect: 'bg-violet-100 text-violet-800',
  po: 'bg-sky-100 text-sky-800',
  dev: 'bg-slate-100 text-slate-800',
  // question status
  open: 'bg-blue-50 text-blue-700',
  answered: 'bg-green-100 text-green-800',
  dismissed: 'bg-gray-100 text-gray-500',
  // task status
  'in-progress': 'bg-blue-100 text-blue-800',
  resolved: 'bg-green-100 text-green-700',
  // requirement status
  draft: 'bg-gray-100 text-gray-600',
  analyzing: 'bg-blue-100 text-blue-700',
  review_required: 'bg-yellow-100 text-yellow-800',
  ready_for_dev: 'bg-green-100 text-green-800',
  blocked: 'bg-red-200 text-red-900',
}

const LABELS: Record<string, string> = {
  ba: 'BA', po: 'PO', dev: 'Dev', architect: 'Architect',
  review_required: 'Review Required', ready_for_dev: 'Ready for Dev',
  'in-progress': 'In Progress',
}

interface BadgeProps {
  variant: BadgeVariant | string
  label?: string
  className?: string
}

export function Badge({ variant, label, className = '' }: BadgeProps) {
  const cls = VARIANT_CLASSES[variant] ?? 'bg-gray-100 text-gray-700'
  const text = label ?? LABELS[variant] ?? variant
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${cls} ${className}`}>
      {text}
    </span>
  )
}
