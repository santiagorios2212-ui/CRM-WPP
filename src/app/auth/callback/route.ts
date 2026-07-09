import { NextResponse, type NextRequest } from 'next/server'
import { appOrigin, safeNextPath } from '@/lib/auth/origin'
import { createClient } from '@/lib/supabase/server'

/**
 * GET /auth/callback
 *
 * Where Supabase returns a user who clicked an emailed link — password
 * recovery today, email confirmation and magic links if they are ever
 * turned on. `/forgot-password` has always pointed here; the route was
 * never written, so every reset email led to a 404 and an account that
 * could not be recovered.
 *
 * The browser client is `@supabase/ssr`'s, which uses PKCE. Supabase
 * therefore sends the user back with a one-time `?code=`, and the
 * matching verifier lives in a cookie this server can read — which is
 * why the exchange happens here rather than on the page.
 *
 * The link only works in the browser that asked for it: the verifier
 * cookie is what pairs them. Opening the email on a phone after
 * requesting the reset on a laptop fails, and says so.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams
  const origin = appOrigin(request)
  const next = safeNextPath(params.get('next'))

  const back = (reason: string) =>
    NextResponse.redirect(`${origin}/login?error=${encodeURIComponent(reason)}`)

  // Supabase reports an expired or already-consumed link this way, before
  // any code is issued.
  if (params.get('error') || params.get('error_description')) {
    return back(params.get('error_code') === 'otp_expired' ? 'link_expired' : 'link_invalid')
  }

  const code = params.get('code')
  if (!code) return back('link_invalid')

  const supabase = await createClient()
  const { error } = await supabase.auth.exchangeCodeForSession(code)
  if (error) {
    // Almost always a link that was already used, has expired, or was
    // opened in a different browser. Never log the code itself.
    console.error('[auth/callback] code exchange failed:', error.message)
    return back('link_expired')
  }

  return NextResponse.redirect(`${origin}${next}`)
}
