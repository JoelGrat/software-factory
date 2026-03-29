'use client'

import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

interface Props {
  children: string
  className?: string
}

export function MarkdownView({ children, className = '' }: Props) {
  return (
    <div className={className}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children: c }) => <h1 className="text-lg font-bold text-white mb-3 mt-6 first:mt-0 font-headline">{c}</h1>,
          h2: ({ children: c }) => <h2 className="text-base font-bold text-slate-200 mb-2 mt-5 font-headline">{c}</h2>,
          h3: ({ children: c }) => <h3 className="text-sm font-semibold text-slate-300 mb-2 mt-4 font-headline">{c}</h3>,
          p: ({ children: c }) => <p className="text-sm text-slate-400 leading-relaxed mb-3">{c}</p>,
          ul: ({ children: c }) => <ul className="list-disc list-inside space-y-1 mb-3">{c}</ul>,
          ol: ({ children: c }) => <ol className="list-decimal list-inside space-y-1 mb-3">{c}</ol>,
          li: ({ children: c }) => <li className="text-sm text-slate-400">{c}</li>,
          code: ({ children: c }) => <code className="text-xs font-mono bg-surface-container-high px-1.5 py-0.5 rounded text-indigo-300">{c}</code>,
          pre: ({ children: c }) => <pre className="bg-surface-container rounded-lg p-4 overflow-x-auto mb-3 text-xs font-mono text-slate-300 border border-white/5">{c}</pre>,
          strong: ({ children: c }) => <strong className="font-semibold text-slate-200">{c}</strong>,
          hr: () => <hr className="border-white/10 my-4" />,
          a: ({ children: c, href }) => <a href={href} className="text-indigo-400 hover:underline" target="_blank" rel="noreferrer">{c}</a>,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
}
