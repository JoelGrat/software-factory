import { describe, it, expect, beforeAll } from 'vitest'
import { encrypt, decrypt } from '@/lib/preview/crypto'

beforeAll(() => {
  process.env.PREVIEW_SECRET_KEY = 'a'.repeat(64)
})

describe('encrypt / decrypt', () => {
  it('round-trips a plain string', () => {
    const plain = 'my-secret-value'
    expect(decrypt(encrypt(plain))).toBe(plain)
  })

  it('produces different ciphertext each call (random IV)', () => {
    const a = encrypt('same')
    const b = encrypt('same')
    expect(a).not.toBe(b)
  })

  it('throws on tampered ciphertext', () => {
    const enc = encrypt('value')
    const tampered = enc.slice(0, -4) + 'xxxx'
    expect(() => decrypt(tampered)).toThrow()
  })

  it('throws when PREVIEW_SECRET_KEY is missing', () => {
    const saved = process.env.PREVIEW_SECRET_KEY
    delete process.env.PREVIEW_SECRET_KEY
    expect(() => encrypt('x')).toThrow('PREVIEW_SECRET_KEY')
    process.env.PREVIEW_SECRET_KEY = saved!
  })
})
