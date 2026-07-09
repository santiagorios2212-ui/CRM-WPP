import { randomUUID } from 'crypto'
import { CalendarError, type BookingResult, type BusyInterval } from './types'

// ============================================================
// Google Calendar over plain `fetch`.
//
// No `googleapis` SDK: we make three calls (refresh, freeBusy, insert)
// and the package would add tens of megabytes and a discovery-document
// loader to a serverless function that must answer a WhatsApp webhook
// before Meta gives up on it.
//
// This module is the only place that knows Google exists. It performs no
// policy — whether a slot *may* be booked is decided by `computeSlots`,
// long before anything here is called.
// ============================================================

const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke'
const CALENDAR_URL = 'https://www.googleapis.com/calendar/v3'

const REQUEST_TIMEOUT_MS = 10_000

/** OAuth scopes we ask for. `calendar.events` alone cannot read
 *  free/busy — that needs `calendar.readonly` — and without
 *  `userinfo.email` we cannot show the operator which account they
 *  connected. Keep in sync with the consent screen configuration. */
export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
] as const

export function googleOAuthClient(): { id: string; secret: string } {
  const id = process.env.GOOGLE_OAUTH_CLIENT_ID
  const secret = process.env.GOOGLE_OAUTH_CLIENT_SECRET
  if (!id || !secret) {
    throw new CalendarError(
      'Google OAuth is not configured: set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET.',
      { code: 'not_configured', status: 500 },
    )
  }
  return { id, secret }
}

interface GoogleErrorBody {
  error?: string | { message?: string; errors?: { reason?: string }[] }
  error_description?: string
}

async function googleError(res: Response, context: string): Promise<CalendarError> {
  let detail = ''
  let reason = ''
  try {
    const body = (await res.json()) as GoogleErrorBody
    if (typeof body.error === 'string') {
      reason = body.error
      detail = body.error_description ?? body.error
    } else {
      detail = body.error?.message ?? ''
      reason = body.error?.errors?.[0]?.reason ?? ''
    }
  } catch {
    // Non-JSON body — the status line is all we have.
  }

  // `invalid_grant` is the one every operator eventually hits: the user
  // revoked access, changed their password, or the consent screen is
  // still in Testing mode (where Google expires refresh tokens after
  // seven days). It is not retryable — the calendar must be reconnected.
  const code =
    reason === 'invalid_grant'
      ? 'invalid_grant'
      : res.status === 401 || res.status === 403
        ? 'unauthorized'
        : res.status === 429
          ? 'rate_limited'
          : 'provider_error'

  return new CalendarError(
    detail ? `${context}: ${detail}` : `${context} (HTTP ${res.status})`,
    { code, status: code === 'invalid_grant' ? 401 : 502 },
  )
}

async function googleFetch(url: string, init: RequestInit, context: string): Promise<unknown> {
  let res: Response
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  } catch (err) {
    const timedOut = err instanceof DOMException && err.name === 'TimeoutError'
    throw new CalendarError(
      timedOut ? `${context}: Google timed out` : `${context}: ${String(err)}`,
      { code: timedOut ? 'timeout' : 'network_error', status: 504 },
    )
  }
  if (!res.ok) throw await googleError(res, context)
  return res.json()
}

/**
 * Trade the stored offline token for a short-lived access token.
 *
 * Not cached across invocations on purpose: serverless containers are
 * shared between accounts, and a cache keyed carelessly would be a
 * cross-tenant token leak. One extra ~150ms round trip per booking pass
 * is a fair price.
 */
export async function accessToken(refreshToken: string): Promise<string> {
  const { id, secret } = googleOAuthClient()
  const body = (await googleFetch(
    TOKEN_URL,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: id,
        client_secret: secret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    },
    'Refreshing the Google access token',
  )) as { access_token?: string }

  if (!body.access_token) {
    throw new CalendarError('Google returned no access token.', {
      code: 'provider_error',
    })
  }
  return body.access_token
}

/** Exchange an authorization code for a refresh token. Only the OAuth
 *  callback calls this. */
export async function exchangeCode(
  code: string,
  redirectUri: string,
): Promise<{ refreshToken: string; accessToken: string }> {
  const { id, secret } = googleOAuthClient()
  const body = (await googleFetch(
    TOKEN_URL,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: id,
        client_secret: secret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      }),
    },
    'Exchanging the Google authorization code',
  )) as { refresh_token?: string; access_token?: string }

  // Google only returns a refresh token on the *first* consent unless the
  // request carried `prompt=consent`. A missing one here means the user
  // had already granted access and we would end up storing nothing — so
  // fail loudly rather than write a row that can never refresh.
  if (!body.refresh_token || !body.access_token) {
    throw new CalendarError(
      'Google did not return a refresh token. Revoke the app at myaccount.google.com/permissions and connect again.',
      { code: 'no_refresh_token', status: 400 },
    )
  }
  return { refreshToken: body.refresh_token, accessToken: body.access_token }
}

/** Which Google account consented. Display only. */
export async function connectedEmail(token: string): Promise<string | null> {
  try {
    const body = (await googleFetch(
      'https://www.googleapis.com/oauth2/v2/userinfo',
      { headers: { Authorization: `Bearer ${token}` } },
      'Reading the Google account email',
    )) as { email?: string }
    return body.email ?? null
  } catch {
    // The scope may have been declined. Cosmetic; never block the connect.
    return null
  }
}

/** Best-effort revoke on disconnect. Google forgets the grant; we forget
 *  the token either way. */
export async function revokeToken(refreshToken: string): Promise<void> {
  try {
    await fetch(REVOKE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: refreshToken }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (err) {
    console.error('[calendar] token revoke failed (deleting locally anyway):', err)
  }
}

interface FreeBusyResponse {
  calendars?: Record<string, { busy?: { start: string; end: string }[]; errors?: unknown[] }>
}

/**
 * Busy intervals on `calendarId` between two instants.
 *
 * A per-calendar `errors` entry (calendar deleted, access lost) is a hard
 * failure, not an empty busy list: "we could not read your calendar" and
 * "your calendar is empty" must never be confused, or the agent will
 * happily book over a full day.
 */
export async function freeBusy(
  token: string,
  calendarId: string,
  timeMin: Date,
  timeMax: Date,
): Promise<BusyInterval[]> {
  const body = (await googleFetch(
    `${CALENDAR_URL}/freeBusy`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        timeMin: timeMin.toISOString(),
        timeMax: timeMax.toISOString(),
        items: [{ id: calendarId }],
      }),
    },
    'Reading Google free/busy',
  )) as FreeBusyResponse

  const entry = body.calendars?.[calendarId]
  if (!entry || (entry.errors && entry.errors.length > 0)) {
    throw new CalendarError(
      `Google could not read calendar "${calendarId}": ${JSON.stringify(entry?.errors ?? 'no such calendar')}`,
      { code: 'calendar_unreadable' },
    )
  }

  return (entry.busy ?? []).map((b) => ({
    start: new Date(b.start),
    end: new Date(b.end),
  }))
}

interface InsertEventResponse {
  id?: string
  hangoutLink?: string
}

/**
 * Create the meeting and email the attendee.
 *
 * `sendUpdates=all` is what actually delivers the invitation the agent
 * told the customer to expect. `conferenceDataVersion=1` is required for
 * Google to honour the Meet `createRequest`; without it the field is
 * silently dropped and the event has no link.
 */
export async function insertEvent(
  token: string,
  calendarId: string,
  event: {
    summary: string
    description: string
    start: Date
    end: Date
    timezone: string
    attendeeEmail: string
  },
): Promise<BookingResult> {
  const body = (await googleFetch(
    `${CALENDAR_URL}/calendars/${encodeURIComponent(calendarId)}/events` +
      '?conferenceDataVersion=1&sendUpdates=all',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        summary: event.summary,
        description: event.description,
        start: { dateTime: event.start.toISOString(), timeZone: event.timezone },
        end: { dateTime: event.end.toISOString(), timeZone: event.timezone },
        attendees: [{ email: event.attendeeEmail }],
        conferenceData: {
          createRequest: {
            requestId: randomUUID(),
            conferenceSolutionKey: { type: 'hangoutsMeet' },
          },
        },
      }),
    },
    'Creating the Google Calendar event',
  )) as InsertEventResponse

  if (!body.id) {
    throw new CalendarError('Google created no event id.', { code: 'provider_error' })
  }
  return { eventId: body.id, meetUrl: body.hangoutLink ?? null }
}
