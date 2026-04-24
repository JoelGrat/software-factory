import { describe, it, expect } from 'vitest'
import { pickPort, PORT_MIN, PORT_MAX } from '@/lib/preview/port-manager'

describe('pickPort', () => {
  it('picks PORT_MIN when nothing is used', () => {
    expect(pickPort(new Set())).toBe(PORT_MIN)
  })
  it('skips used ports', () => {
    expect(pickPort(new Set([3100, 3101]))).toBe(3102)
  })
  it('throws port_pool_exhausted when all ports used', () => {
    const all = new Set(Array.from({ length: PORT_MAX - PORT_MIN + 1 }, (_, i) => PORT_MIN + i))
    expect(() => pickPort(all)).toThrow('port_pool_exhausted')
  })
})
