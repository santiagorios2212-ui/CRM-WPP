import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  encodeState,
  googleAuthorizeUrl,
  googleRedirectUri,
  verifyState,
} from './oauth'

afterEach(() => vi.unstubAllEnvs())

const ACCOUNT = '309daf2c-326d-4fd6-83b8-8449b5f6a227'
const NONCE = 'b1e4c0de-0000-4000-8000-000000000001'

const req = (headers: Record<string, string>) =>
  new Request('https://example.invalid/api/calendar/google/connect', { headers })

describe('googleRedirectUri', () => {
  it('prefers the explicit site URL, and strips a trailing slash', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://crm-wpp-rho.vercel.app/')
    expect(googleRedirectUri(req({}))).toBe(
      'https://crm-wpp-rho.vercel.app/api/calendar/google/callback',
    )
  })

  it('falls back to the proxy forwarding headers', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', '')
    expect(
      googleRedirectUri(
        req({ 'x-forwarded-host': 'crm.example.com', 'x-forwarded-proto': 'https' }),
      ),
    ).toBe('https://crm.example.com/api/calendar/google/callback')
  })

  it('takes the first hop when a proxy chain appends its own', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', '')
    expect(
      googleRedirectUri(
        req({
          'x-forwarded-host': 'crm.example.com, internal.lb',
          'x-forwarded-proto': 'https, http',
        }),
      ),
    ).toBe('https://crm.example.com/api/calendar/google/callback')
  })

  it('uses http for localhost so the dev flow works', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', '')
    expect(googleRedirectUri(req({ host: 'localhost:3000' }))).toBe(
      'http://localhost:3000/api/calendar/google/callback',
    )
  })
})

describe('googleAuthorizeUrl', () => {
  const url = () =>
    new URL(
      googleAuthorizeUrl({
        clientId: 'client-123',
        redirectUri: 'https://crm.example.com/api/calendar/google/callback',
        state: NONCE,
      }),
    )

  it('asks for an offline refresh token, every time', () => {
    const params = url().searchParams
    // Without access_type=offline Google issues no refresh token at all;
    // without prompt=consent it stops issuing one on the second connect.
    expect(params.get('access_type')).toBe('offline')
    expect(params.get('prompt')).toBe('consent')
    expect(params.get('response_type')).toBe('code')
    expect(params.get('state')).toBe(NONCE)
  })

  it('requests read access as well as write — freeBusy needs it', () => {
    const scope = url().searchParams.get('scope') ?? ''
    expect(scope).toContain('auth/calendar.events')
    expect(scope).toContain('auth/calendar.readonly')
  })
})

describe('verifyState', () => {
  const cookie = encodeState(NONCE, ACCOUNT)

  it('accepts the flow it started', () => {
    expect(verifyState({ cookie, state: NONCE, accountId: ACCOUNT })).toBe(true)
  })

  it('rejects a state that does not match the cookie', () => {
    expect(verifyState({ cookie, state: 'other-nonce', accountId: ACCOUNT })).toBe(false)
  })

  it('rejects a calendar being attached to a different workspace', () => {
    // The attack this exists for: walk an admin of account A through a
    // flow that lands their Google token on account B.
    expect(verifyState({ cookie, state: NONCE, accountId: 'other-account' })).toBe(false)
  })

  it('rejects a missing or malformed cookie', () => {
    expect(verifyState({ cookie: undefined, state: NONCE, accountId: ACCOUNT })).toBe(false)
    expect(verifyState({ cookie: NONCE, state: NONCE, accountId: ACCOUNT })).toBe(false)
    expect(verifyState({ cookie, state: null, accountId: ACCOUNT })).toBe(false)
  })
})
