import { NextResponse, type NextRequest } from 'next/server'
import { requireRole } from '@/lib/auth/account'
import { connectedEmail, exchangeCode } from '@/lib/calendar/google'
import { STATE_COOKIE, googleRedirectUri, verifyState } from '@/lib/calendar/oauth'
import { encrypt } from '@/lib/whatsapp/encryption'

/**
 * GET /api/calendar/google/callback  (admin+)
 *
 * Where Google returns the admin after the consent screen. Exchanges the
 * one-time code for a refresh token, encrypts it, and stores it against
 * the account.
 *
 * Every failure path redirects back to the Calendar tab with a `reason`
 * in the query string rather than rendering an error page: the admin
 * arrived here by clicking a button in the app, and should land back in
 * the app. Nothing sensitive — no code, no token — is ever put in a URL.
 *
 * Booking is deliberately NOT switched on by connecting. Reading someone's
 * calendar and letting an LLM write to it are different decisions, and the
 * second one deserves its own click.
 */
function back(request: NextRequest, params: Record<string, string>): NextResponse {
  const origin = new URL(googleRedirectUri(request)).origin
  const url = new URL('/agents', origin)
  url.searchParams.set('tab', 'calendar')
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)

  const response = NextResponse.redirect(url.toString())
  response.cookies.delete(STATE_COOKIE)
  return response
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams

  // The admin pressed "Cancel" on Google's consent screen.
  const denied = params.get('error')
  if (denied) return back(request, { calendar_error: denied })

  let accountId: string
  let userId: string
  let supabase: Awaited<ReturnType<typeof requireRole>>['supabase']
  try {
    ;({ supabase, accountId, userId } = await requireRole('admin'))
  } catch {
    return back(request, { calendar_error: 'forbidden' })
  }

  if (
    !verifyState({
      cookie: request.cookies.get(STATE_COOKIE)?.value,
      state: params.get('state'),
      accountId,
    })
  ) {
    // Either a forged callback, or the cookie expired while the admin left
    // the consent screen open. Both mean: start again.
    return back(request, { calendar_error: 'invalid_state' })
  }

  const code = params.get('code')
  if (!code) return back(request, { calendar_error: 'missing_code' })

  try {
    const tokens = await exchangeCode(code, googleRedirectUri(request))
    const email = await connectedEmail(tokens.accessToken)

    // Only the columns a reconnect should touch. A workspace that has
    // already tuned its working hours and switched booking on must not
    // have them reset because someone re-authorised the calendar.
    const { error } = await supabase.from('ai_calendar_configs').upsert(
      {
        account_id: accountId,
        created_by: userId,
        provider: 'google',
        refresh_token: encrypt(tokens.refreshToken),
        connected_email: email,
      },
      { onConflict: 'account_id' },
    )
    if (error) {
      console.error('[calendar/callback] could not store the refresh token:', error)
      return back(request, { calendar_error: 'storage_failed' })
    }

    return back(request, { calendar: 'connected' })
  } catch (err) {
    console.error('[calendar/callback] token exchange failed:', err)
    return back(request, { calendar_error: 'exchange_failed' })
  }
}
