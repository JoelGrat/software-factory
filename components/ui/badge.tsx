type BadgeVariant = string

const BADGE_STYLES: Record<string, { bg: string; color: string; border: string; label?: string }> = {
  // Severity
  critical:        { bg: 'rgba(255,69,69,0.1)',    color: '#FF6B6B',  border: 'rgba(255,69,69,0.2)',   label: 'Critical' },
  major:           { bg: 'rgba(245,162,0,0.1)',    color: '#F5A200',  border: 'rgba(245,162,0,0.2)',   label: 'Major' },
  minor:           { bg: 'rgba(79,112,255,0.1)',   color: '#7B97FF',  border: 'rgba(79,112,255,0.2)',  label: 'Minor' },
  // Status
  draft:           { bg: 'rgba(123,130,160,0.1)',  color: '#7B82A0',  border: 'rgba(123,130,160,0.2)', label: 'Draft' },
  analyzing:       { bg: 'rgba(79,112,255,0.1)',   color: '#7B97FF',  border: 'rgba(79,112,255,0.2)',  label: 'Analyzing' },
  incomplete:      { bg: 'rgba(255,69,69,0.1)',    color: '#FF6B6B',  border: 'rgba(255,69,69,0.2)',   label: 'Incomplete' },
  review_required: { bg: 'rgba(245,162,0,0.1)',    color: '#F5A200',  border: 'rgba(245,162,0,0.2)',   label: 'Review Required' },
  ready_for_dev:   { bg: 'rgba(0,216,122,0.1)',    color: '#00D87A',  border: 'rgba(0,216,122,0.2)',   label: 'Ready for Planning' },
  blocked:         { bg: 'rgba(255,69,69,0.12)',   color: '#FF4545',  border: 'rgba(255,69,69,0.25)',  label: 'Blocked' },
  // Question status
  open:            { bg: 'rgba(79,112,255,0.1)',   color: '#7B97FF',  border: 'rgba(79,112,255,0.2)',  label: 'Open' },
  answered:        { bg: 'rgba(0,216,122,0.1)',    color: '#00D87A',  border: 'rgba(0,216,122,0.2)',   label: 'Answered' },
  resolved:        { bg: 'rgba(0,216,122,0.1)',    color: '#00D87A',  border: 'rgba(0,216,122,0.2)',   label: 'Resolved' },
  // Priority
  high:            { bg: 'rgba(255,69,69,0.1)',    color: '#FF6B6B',  border: 'rgba(255,69,69,0.2)',   label: 'High' },
  medium:          { bg: 'rgba(245,162,0,0.1)',    color: '#F5A200',  border: 'rgba(245,162,0,0.2)',   label: 'Medium' },
  low:             { bg: 'rgba(79,112,255,0.1)',   color: '#7B97FF',  border: 'rgba(79,112,255,0.2)',  label: 'Low' },
  // Role
  ba:              { bg: 'rgba(167,139,250,0.1)',  color: '#A78BFA',  border: 'rgba(167,139,250,0.2)', label: 'BA' },
  dev:             { bg: 'rgba(79,112,255,0.1)',   color: '#7B97FF',  border: 'rgba(79,112,255,0.2)',  label: 'Dev' },
  pm:              { bg: 'rgba(45,212,191,0.1)',   color: '#2DD4BF',  border: 'rgba(45,212,191,0.2)',  label: 'PM' },
  // Source
  rule:            { bg: 'rgba(79,112,255,0.08)',  color: '#6B82FF',  border: 'rgba(79,112,255,0.15)', label: 'Rule' },
  ai:              { bg: 'rgba(167,139,250,0.08)', color: '#A78BFA',  border: 'rgba(167,139,250,0.15)', label: 'AI' },
  pattern:         { bg: 'rgba(45,212,191,0.08)',  color: '#2DD4BF',  border: 'rgba(45,212,191,0.15)', label: 'Pattern' },
  // Category
  missing:         { bg: 'rgba(255,69,69,0.08)',   color: '#FF8080',  border: 'rgba(255,69,69,0.15)',  label: 'Missing' },
  ambiguous:       { bg: 'rgba(245,162,0,0.08)',   color: '#F5B833',  border: 'rgba(245,162,0,0.15)',  label: 'Ambiguous' },
  conflicting:     { bg: 'rgba(251,113,133,0.08)', color: '#FB7185',  border: 'rgba(251,113,133,0.15)',label: 'Conflicting' },
  // Task status
  'in_progress':   { bg: 'rgba(79,112,255,0.1)',   color: '#7B97FF',  border: 'rgba(79,112,255,0.2)',  label: 'In Progress' },
  completed:       { bg: 'rgba(0,216,122,0.1)',    color: '#00D87A',  border: 'rgba(0,216,122,0.2)',   label: 'Completed' },
  // NFR
  security:        { bg: 'rgba(251,113,133,0.08)', color: '#FB7185',  border: 'rgba(251,113,133,0.15)',label: 'Security' },
  performance:     { bg: 'rgba(79,112,255,0.08)',  color: '#7B97FF',  border: 'rgba(79,112,255,0.15)', label: 'Performance' },
  auditability:    { bg: 'rgba(45,212,191,0.08)',  color: '#2DD4BF',  border: 'rgba(45,212,191,0.15)', label: 'Auditability' },
}

const DEFAULT_STYLE = { bg: 'rgba(123,130,160,0.08)', color: '#7B82A0', border: 'rgba(123,130,160,0.15)' }

interface BadgeProps {
  variant: BadgeVariant
  label?: string
  className?: string
}

export function Badge({ variant, label, className = '' }: BadgeProps) {
  const s = BADGE_STYLES[variant] ?? DEFAULT_STYLE
  const text = label ?? s.label ?? variant
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium ${className}`}
      style={{
        background: s.bg,
        color: s.color,
        border: `1px solid ${s.border}`,
        fontFamily: 'var(--font-syne)',
        letterSpacing: '0.03em',
      }}
    >
      {text}
    </span>
  )
}
