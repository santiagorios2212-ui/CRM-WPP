import { appOrigin } from '@/lib/auth/origin'
import { GOOGLE_SCOPES } from './google'

// ============================================================
// The OAuth handshake, minus the HTTP.
//
// Two things happen here that are easy to get subtly wrong:
// the `redirect_uri` must be byte-identical between the authorize call
// and the token exchange, and the `state` must be unguessable and bound
// to the account that started the flow.
// ============================================================

const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth'

/** Short-lived, httpOnly. `SameSite=Lax` on purpose: Google returns the
 *  user via a top-level GET navigation, which Lax permits and Strict
 *  would silently drop — leaving every connect attempt looking like CSRF. */
export const STATE_COOKIE = 'gcal_oauth_state'
export const STATE_TTL_SECONDS = 600

/**
 * The callback URL Google redirects to, which must be registered in the
 * Google Cloud console exactly as produced here.
 *
 * `NEXT_PUBLIC_SITE_URL` wins when set, because a proxied deployment can
 * be reached under several hostnames and only one of them is registered.
 * Otherwise we reconstruct the origin from the proxy's forwarding
 * headers, as `/api/account/invitations` does.
 *
 * A spoofed `Host` cannot turn this into an open redirect: Google refuses
 * any `redirect_uri` that is not on the app's registered list, so a
 * forged origin fails the handshake instead of leaking a code.
 */
export function googleRedirectUri(request: Request): string {
  return `${appOrigin(request)}/api/calendar/google/callback`
}

/**
 * Where to send the admin to grant access.
 *
 * `access_type=offline` is what makes Google issue a refresh token at
 * all. `prompt=consent` forces it to issue a *new* one on every connect:
 * without it, a user who has already granted access gets an access token
 * and no refresh token, and we would store nothing usable — the failure
 * lands minutes later, when the first booking silently cannot refresh.
 */
export function googleAuthorizeUrl(args: {
  clientId: string
  redirectUri: string
  state: string
}): string {
  const url = new URL(AUTHORIZE_URL)
  url.searchParams.set('client_id', args.clientId)
  url.searchParams.set('redirect_uri', args.redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', GOOGLE_SCOPES.join(' '))
  url.searchParams.set('access_type', 'offline')
  url.searchParams.set('prompt', 'consent')
  url.searchParams.set('state', args.state)
  return url.toString()
}

/** `<nonce>.<accountId>` — the cookie's payload. */
export function encodeState(nonce: string, accountId: string): string {
  return `${nonce}.${accountId}`
}

/**
 * Constant-time-ish check that the callback belongs to the flow this
 * browser started, for the account it started it for.
 *
 * Binding the account matters: without it, an admin of workspace A could
 * be walked through a flow that attaches their Google calendar to
 * workspace B.
 */
export function verifyState(args: {
  cookie: string | undefined
  state: string | null
  accountId: string
}): boolean {
  if (!args.cookie || !args.state) return false
  const [nonce, cookieAccountId] = args.cookie.split('.')
  if (!nonce || !cookieAccountId) return false
  return nonce === args.state && cookieAccountId === args.accountId
}
