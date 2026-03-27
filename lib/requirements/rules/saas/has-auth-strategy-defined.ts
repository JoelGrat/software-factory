import type { ParsedItem } from '@/lib/requirements/parser'
const KW = ['authentication', 'login', 'sign in', 'session', 'token', 'oauth', 'sso', 'jwt', 'password', 'credential']
export function hasAuthStrategyDefined(items: ParsedItem[]): boolean {
  return items.some(i => KW.some(k => i.title.toLowerCase().includes(k) || i.description.toLowerCase().includes(k)))
}
