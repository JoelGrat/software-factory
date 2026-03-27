import type { ParsedItem } from '@/lib/requirements/parser'

const EXTERNAL_KW  = ['third-party', 'external', 'integration', 'vendor', 'stripe', 'twilio', 'sendgrid', 'webhook']
const CONTRACT_KW  = ['contract', 'interface', 'specification', 'protocol', 'format', 'schema', 'sla', 'endpoint', 'signature']

export function hasExternalDependenciesDefined(items: ParsedItem[]): boolean {
  const mentionsExternal = items.some(i =>
    EXTERNAL_KW.some(k => i.title.toLowerCase().includes(k) || i.description.toLowerCase().includes(k))
  )
  if (!mentionsExternal) return true  // no external system mentioned → no gap
  return items.some(i =>
    CONTRACT_KW.some(k => i.title.toLowerCase().includes(k) || i.description.toLowerCase().includes(k))
  )
}
