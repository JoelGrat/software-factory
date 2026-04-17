import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const ALGO = 'aes-256-gcm'

function getKey(): Buffer {
  const hex = process.env.PREVIEW_SECRET_KEY ?? ''
  if (hex.length !== 64) throw new Error('PREVIEW_SECRET_KEY must be a 64-char hex string (32 bytes)')
  return Buffer.from(hex, 'hex')
}

/** Encrypts a plaintext string. Returns `iv:authTag:ciphertext` (all hex). */
export function encrypt(plaintext: string): string {
  const key = getKey()
  const iv = randomBytes(12)
  const cipher = createCipheriv(ALGO, key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`
}

/** Decrypts a string produced by encrypt(). Throws on invalid input or tampered data. */
export function decrypt(encoded: string): string {
  const key = getKey()
  const parts = encoded.split(':')
  if (parts.length !== 3) throw new Error('Invalid encrypted format')
  const [ivHex, tagHex, dataHex] = parts as [string, string, string]
  const decipher = createDecipheriv(ALGO, key, Buffer.from(ivHex, 'hex'))
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'))
  return Buffer.concat([
    decipher.update(Buffer.from(dataHex, 'hex')),
    decipher.final(),
  ]).toString('utf8')
}
