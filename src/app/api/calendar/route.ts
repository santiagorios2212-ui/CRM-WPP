import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { parseWorkingHours } from '@/lib/calendar/config'
import { revokeToken } from '@/lib/calendar/google'
import { isValidTimezone } from '@/lib/calendar/tz'
import { decrypt } from '@/lib/whatsapp/encryption'

function bad(message: string) {
  return NextResponse.json({ error: message }, { status: 400 })
}

/** Mirrors the CHECK constraints in migration 032. Kept in sync by hand:
 *  the database is the real guard, this only turns a 500 into a 400. */
const BOUNDS: Record<string, [number, number]> = {
  slot_minutes: [5, 480],
  buffer_minutes: [0, 240],
  min_notice_minutes: [0, 20160],
  max_days_ahead: [0, 90],
  offer_slots: [1, 10],
}

/**
 * GET /api/calendar
 *
 * Any member may see whether a calendar is connected and how booking is
 * configured. `refresh_token` is never selected, let alone returned.
 */
export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    const { data, error } = await supabase
      .from('ai_calendar_configs')
      .select(
        'provider, calendar_id, connected_email, timezone, slot_minutes, buffer_minutes, min_notice_minutes, max_days_ahead, offer_slots, working_hours, booking_enabled, confirmation_template',
      )
      .eq('account_id', accountId)
      .maybeSingle()

    if (error) {
      console.error('[calendar GET] fetch error:', error)
      return NextResponse.json({ error: 'Could not load the calendar config.' }, { status: 500 })
    }
    return NextResponse.json({
      connected: !!data,
      oauth_configured: !!process.env.GOOGLE_OAUTH_CLIENT_ID,
      config: data ?? null,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * PATCH /api/calendar  (admin+)
 *
 * Update booking policy. Never touches the OAuth token: reconnecting is
 * a separate flow, and a settings save must not be able to orphan one.
 */
export async function PATCH(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('admin')

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') return bad('A JSON body is required.')

    const patch: Record<string, unknown> = {}

    if (body.timezone !== undefined) {
      if (typeof body.timezone !== 'string' || !isValidTimezone(body.timezone)) {
        return bad(`"${body.timezone}" is not a known IANA timezone.`)
      }
      patch.timezone = body.timezone
    }

    for (const [key, [min, max]] of Object.entries(BOUNDS)) {
      if (body[key] === undefined) continue
      const value = Number(body[key])
      if (!Number.isInteger(value) || value < min || value > max) {
        return bad(`${key} must be a whole number between ${min} and ${max}.`)
      }
      patch[key] = value
    }

    if (body.working_hours !== undefined) {
      // Rejected here rather than at booking time: `computeSlots` throws on
      // a malformed range, and an admin who saves "9:00" should be told
      // immediately, not by an agent that has quietly stopped scheduling.
      const parsed = parseWorkingHours(body.working_hours)
      if (!parsed) {
        return bad('Working hours must be {"<0-6>": [["HH:MM","HH:MM"], …]} with start < end.')
      }
      patch.working_hours = parsed
    }

    if (body.booking_enabled !== undefined) {
      if (typeof body.booking_enabled !== 'boolean') return bad('booking_enabled must be a boolean.')
      patch.booking_enabled = body.booking_enabled
    }

    if (body.confirmation_template !== undefined) {
      const template = String(body.confirmation_template).trim()
      if (!template) return bad('The confirmation message cannot be empty.')
      // The customer must be told *when*. A template that dropped the
      // placeholder would confirm a meeting without naming its time.
      if (!template.includes('{datetime}')) {
        return bad('The confirmation message must include the {datetime} placeholder.')
      }
      patch.confirmation_template = template
    }

    if (body.calendar_id !== undefined) {
      const calendarId = String(body.calendar_id).trim()
      if (!calendarId) return bad('calendar_id cannot be empty.')
      patch.calendar_id = calendarId
    }

    if (Object.keys(patch).length === 0) return bad('Nothing to update.')

    // Booking cannot be switched on without a token to book with.
    if (patch.booking_enabled === true) {
      const { data: existing } = await supabase
        .from('ai_calendar_configs')
        .select('refresh_token')
        .eq('account_id', accountId)
        .maybeSingle()
      if (!existing?.refresh_token) {
        return bad('Connect a Google account before enabling booking.')
      }
    }

    const { error } = await supabase
      .from('ai_calendar_configs')
      .update(patch)
      .eq('account_id', accountId)
    if (error) {
      console.error('[calendar PATCH] update error:', error)
      return NextResponse.json({ error: 'Could not save the calendar config.' }, { status: 500 })
    }
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * DELETE /api/calendar  (admin+)
 *
 * Disconnect. We ask Google to forget the grant, then delete the row —
 * in that order, because a revoke that fails is recoverable (the user can
 * remove the app at myaccount.google.com) while a row we kept after
 * telling the admin it was gone is not.
 *
 * `ai_bookings` rows survive, and so do the events already in the
 * calendar. Disconnecting stops the agent from booking; it does not
 * cancel meetings customers have already been invited to.
 */
export async function DELETE() {
  try {
    const { supabase, accountId } = await requireRole('admin')

    const { data } = await supabase
      .from('ai_calendar_configs')
      .select('refresh_token')
      .eq('account_id', accountId)
      .maybeSingle()

    if (data?.refresh_token) {
      try {
        await revokeToken(decrypt(data.refresh_token))
      } catch {
        // An undecryptable token cannot be revoked; drop it anyway.
        console.error('[calendar DELETE] could not decrypt the token to revoke it.')
      }
    }

    const { error } = await supabase
      .from('ai_calendar_configs')
      .delete()
      .eq('account_id', accountId)
    if (error) {
      console.error('[calendar DELETE] delete error:', error)
      return NextResponse.json({ error: 'Could not disconnect the calendar.' }, { status: 500 })
    }
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
