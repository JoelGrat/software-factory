interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost'
  loading?: boolean
}

const VARIANT_CLASSES = {
  primary: 'bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50',
  secondary: 'bg-gray-100 text-gray-800 hover:bg-gray-200 disabled:opacity-50',
  danger: 'bg-red-600 text-white hover:bg-red-700 disabled:opacity-50',
  ghost: 'bg-transparent text-gray-600 hover:bg-gray-100 disabled:opacity-50',
}

export function Button({ variant = 'primary', loading = false, disabled, children, className = '', ...props }: ButtonProps) {
  return (
    <button
      disabled={disabled || loading}
      className={`inline-flex items-center gap-2 px-4 py-2 rounded text-sm font-medium transition-colors ${VARIANT_CLASSES[variant]} ${className}`}
      {...props}
    >
      {loading && (
        <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
        </svg>
      )}
      {children}
    </button>
  )
}
