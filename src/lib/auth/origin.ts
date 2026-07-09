// ============================================================
// Where this deployment lives, and where it is safe to send a user.
//
// Both answers are needed by any route that redirects a browser back
// into the app after an external round trip — the Supabase auth callback
// and the Google Calendar OAuth callback.
// ============================================================

/**
 * The app's public origin, with no trailing slash.
 *
 * `NEXT_PUBLIC_SITE_URL` wins when set: a proxied deployment answers on
 * several hostnames and only one of them is canonical. Otherwise we
 * reconstruct it from the proxy's forwarding headers, which is what
 * `/api/account/invitations` has always done.
 *
 * `request.nextUrl.origin` is deliberately not used. Behind Vercel's
 * proxy it can carry the internal hostname, and a redirect to that host
 * either 404s or leaves the user on a URL they do not recognise.
 */
export function appOrigin(request: Request): string {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL?.trim()
  if (explicit) {
    const validated = asHttpOrigin(explicit)
    if (validated) return validated
    // Do not propagate. This value is fed straight to `NextResponse
    // .redirect`, which throws on a malformed URL — a 500 on the auth
    // callback, from a typo in a dashboard field nobody looks at again.
    // Someone did paste the variable's *name* into its value box, and it
    // took a production stack trace to find out.
    console.error(
      `[auth] NEXT_PUBLIC_SITE_URL is not an absolute http(s) URL ("${explicit}"); deriving the origin from the request instead.`,
    )
  }

  const headers = request.headers
  const host = headers.get('x-forwarded-host')?.split(',')[0].trim() || headers.get('host')
  const proto =
    headers.get('x-forwarded-proto')?.split(',')[0].trim() ??
    (host?.startsWith('localhost') ? 'http' : 'https')

  return `${proto}://${host}`
}

/** `value` as a bare `scheme://host[:port]` origin, or null if it is not
 *  an absolute http(s) URL. Any path, query, or fragment is discarded. */
function asHttpOrigin(value: string): string | null {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url.origin
  } catch {
    return null
  }
}

/**
 * Narrow a caller-supplied `?next=` to a path on this origin.
 *
 * An open redirect here would be handed to the user mid-authentication,
 * on a link that arrived by email — the single most persuasive place to
 * bounce someone onto a credential-harvesting page. So we accept only a
 * root-relative path, and reject the encodings that browsers read as an
 * absolute URL: `//evil.com` (protocol-relative) and `/\evil.com`, which
 * Chrome and Firefox normalise to `//evil.com`.
 */
export function safeNextPath(raw: string | null, fallback = '/dashboard'): string {
  if (!raw) return fallback
  if (!raw.startsWith('/')) return fallback
  if (raw.startsWith('//') || raw.startsWith('/\\')) return fallback
  return raw
}
