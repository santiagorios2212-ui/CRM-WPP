import { describe, it, expect, afterEach, vi } from 'vitest'
import { appOrigin, safeNextPath } from './origin'

afterEach(() => vi.unstubAllEnvs())

const req = (headers: Record<string, string> = {}) =>
  new Request('https://internal.invalid/auth/callback', { headers })

describe('appOrigin', () => {
  it('prefers the canonical site URL and drops trailing slashes', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://crm-wpp-rho.vercel.app//')
    expect(appOrigin(req())).toBe('https://crm-wpp-rho.vercel.app')
  })

  it('falls back to the proxy headers, taking the first hop', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', '')
    expect(
      appOrigin(
        req({
          'x-forwarded-host': 'crm.example.com, internal.lb',
          'x-forwarded-proto': 'https, http',
        }),
      ),
    ).toBe('https://crm.example.com')
  })

  it('uses http for localhost so the dev flow works', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', '')
    expect(appOrigin(req({ host: 'localhost:3000' }))).toBe('http://localhost:3000')
  })

  it('ignores a misconfigured site URL rather than 500-ing on redirect', () => {
    // Really happened: the variable's *name* was pasted into its value
    // box. The string flows into NextResponse.redirect, which throws on a
    // malformed URL — taking down the auth callback.
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'NEXT_PUBLIC_SITE_URL')
    expect(appOrigin(req({ 'x-forwarded-host': 'crm.example.com' }))).toBe(
      'https://crm.example.com',
    )
  })

  it('rejects a non-http scheme', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'javascript:alert(1)')
    expect(appOrigin(req({ 'x-forwarded-host': 'crm.example.com' }))).toBe(
      'https://crm.example.com',
    )
  })

  it('strips a path someone appended to the site URL', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://crm.example.com/dashboard')
    expect(appOrigin(req())).toBe('https://crm.example.com')
  })
})

describe('safeNextPath', () => {
  it('passes a root-relative path through', () => {
    expect(safeNextPath('/reset-password')).toBe('/reset-password')
    expect(safeNextPath('/inbox?conversation=1')).toBe('/inbox?conversation=1')
  })

  it('falls back when absent or not a path', () => {
    expect(safeNextPath(null)).toBe('/dashboard')
    expect(safeNextPath('')).toBe('/dashboard')
    expect(safeNextPath('reset-password')).toBe('/dashboard')
    expect(safeNextPath('https://evil.example/steal')).toBe('/dashboard')
  })

  it('refuses the encodings browsers read as an absolute URL', () => {
    // This runs on a link that arrived by email, mid-authentication —
    // the most persuasive possible place to bounce someone onto a
    // credential-harvesting page.
    expect(safeNextPath('//evil.example')).toBe('/dashboard')
    expect(safeNextPath('//evil.example/reset-password')).toBe('/dashboard')
    // Chrome and Firefox normalise the backslash to a second slash.
    expect(safeNextPath('/\\evil.example')).toBe('/dashboard')
  })

  it('honours a caller-supplied fallback', () => {
    expect(safeNextPath(null, '/login')).toBe('/login')
  })
})
