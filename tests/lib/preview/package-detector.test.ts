import { describe, it, expect } from 'vitest'
import { detectInstallCommand, detectStartCommand } from '@/lib/preview/package-detector'

describe('detectInstallCommand', () => {
  it('detects pnpm from pnpm-lock.yaml', () => {
    expect(detectInstallCommand(['pnpm-lock.yaml', 'package.json']))
      .toBe('pnpm install --frozen-lockfile')
  })
  it('detects yarn from yarn.lock', () => {
    expect(detectInstallCommand(['yarn.lock', 'package.json']))
      .toBe('yarn install --frozen-lockfile')
  })
  it('detects bun from bun.lockb (legacy format)', () => {
    expect(detectInstallCommand(['bun.lockb', 'package.json']))
      .toBe('bun install --frozen-lockfile')
  })
  it('detects bun from bun.lock (v1.1+ format)', () => {
    expect(detectInstallCommand(['bun.lock', 'package.json']))
      .toBe('bun install --frozen-lockfile')
  })
  it('detects npm from package-lock.json', () => {
    expect(detectInstallCommand(['package-lock.json', 'package.json']))
      .toBe('npm ci')
  })
  it('falls back to npm install when no lockfile', () => {
    expect(detectInstallCommand(['package.json'])).toBe('npm install')
  })
  it('prefers pnpm over yarn when both present', () => {
    expect(detectInstallCommand(['pnpm-lock.yaml', 'yarn.lock']))
      .toBe('pnpm install --frozen-lockfile')
  })
})

describe('detectStartCommand', () => {
  it('prefers preview script', () => {
    expect(detectStartCommand({ preview: 'vite preview', dev: 'vite' }))
      .toBe('npm run preview')
  })
  it('prefers dev over start (avoids next start / production server)', () => {
    expect(detectStartCommand({ start: 'next start', dev: 'next dev' }))
      .toBe('npm run dev')
  })
  it('uses start when only start is defined', () => {
    expect(detectStartCommand({ start: 'node server.js' }))
      .toBe('npm run start')
  })
  it('uses dev script directly', () => {
    expect(detectStartCommand({ dev: 'next dev' })).toBe('npm run dev')
  })
  it('falls back to npm run dev when no scripts match', () => {
    expect(detectStartCommand({ test: 'vitest' })).toBe('npm run dev')
  })
})
