import { randomUUID } from 'crypto'
import { NextResponse, type NextRequest } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { googleOAuthClient } from '@/lib/calendar/google'
import {
  STATE_COOKIE,
  STATE_TTL_SECONDS,
  encodeState,
  googleAuthorizeUrl,
  googleRedirectUri,
} from '@/lib/calendar/oauth'
import { CalendarError } from '@/lib/calendar/types'

/**
 * GET /api/calendar/google/connect  (admin+)
 *
 * Kicks off the OAuth flow: mints a CSRF nonce, parks it in an httpOnly
 * cookie bound to the current account, and redirects the admin to
 * Google's consent screen.
 *
 * A GET that changes server state (the cookie) but performs no
 * side-effect on the account is deliberate — it is a plain link the
 * browser follows, and the actual grant only lands in `/callback`.
 */
export async function GET(request: NextRequest) {
  try {
    const { accountId } = await requireRole('admin')
    const { id } = googleOAuthClient()

    const nonce = randomUUID()
    const response = NextResponse.redirect(
      googleAuthorizeUrl({
        clientId: id,
        redirectUri: googleRedirectUri(request),
        state: nonce,
      }),
    )

    response.cookies.set(STATE_COOKIE, encodeState(nonce, accountId), {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: STATE_TTL_SECONDS,
    })
    return response
  } catch (err) {
    if (err instanceof CalendarError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status })
    }
    return toErrorResponse(err)
  }
}
