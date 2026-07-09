import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt } from '@/lib/whatsapp/encryption'
import { isValidTimezone } from './tz'
import type { CalendarConfig, WorkingHours } from './types'

interface CalendarConfigRow {
  provider: 'google'
  refresh_token: string
  calendar_id: string
  connected_email: string | null
  timezone: string
  slot_minutes: number
  buffer_minutes: number
  min_notice_minutes: number
  max_days_ahead: number
  offer_slots: number
  working_hours: unknown
  booking_enabled: boolean
  confirmation_template: string
}

// One string literal, not a concatenation: supabase-js derives the row
// type from the literal you hand `select()`, and a `+`-joined string
// widens to `string`, which lands you in `GenericStringError`.
const COLUMNS =
  'provider, refresh_token, calendar_id, connected_email, timezone, slot_minutes, buffer_minutes, min_notice_minutes, max_days_ahead, offer_slots, working_hours, booking_enabled, confirmation_template'

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/

/**
 * Narrow the `jsonb` column to `WorkingHours`, or return null if it is
 * anything else. Nothing downstream re-checks this: `computeSlots` reads
 * the ranges and generates slots from them, so a `"09:00"`–`"9:00"` typo
 * that slipped past here would open the calendar at an hour the account
 * never agreed to.
 */
export function parseWorkingHours(raw: unknown): WorkingHours | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null

  const out: WorkingHours = {}
  for (const [weekday, ranges] of Object.entries(raw)) {
    if (!/^[0-6]$/.test(weekday)) return null
    if (!Array.isArray(ranges)) return null

    const parsed: [string, string][] = []
    for (const range of ranges) {
      if (!Array.isArray(range) || range.length !== 2) return null
      const [from, to] = range
      if (typeof from !== 'string' || typeof to !== 'string') return null
      if (!HHMM.test(from) || !HHMM.test(to)) return null
      if (from >= to) return null // lexicographic works on zero-padded HH:MM
      parsed.push([from, to])
    }
    out[weekday] = parsed
  }
  return out
}

/**
 * Load and decrypt the account's calendar setup, or `null` when the
 * account has none — or has one we refuse to use.
 *
 * Every failure here degrades to `null`, which the agent reads as "this
 * business has no calendar": it will not offer a meeting, will not
 * promise an invitation, and will hand a scheduling request to a human.
 * That is the safe direction. The alternative — throwing — would take
 * down auto-reply entirely for an account whose calendar merely needs
 * reconnecting, and a customer asking "¿hacen envíos?" would go
 * unanswered because of a broken OAuth token.
 *
 * Each `null` is logged with its cause, because a silently unbookable
 * calendar is otherwise indistinguishable from one nobody asked about.
 */
export async function loadCalendarConfig(
  db: SupabaseClient,
  accountId: string,
): Promise<CalendarConfig | null> {
  const { data, error } = await db
    .from('ai_calendar_configs')
    .select(COLUMNS)
    .eq('account_id', accountId)
    .maybeSingle()

  if (error) {
    console.error('[calendar config] query failed:', error)
    return null
  }
  if (!data) return null

  const row = data as CalendarConfigRow
  if (!row.refresh_token) return null

  if (!isValidTimezone(row.timezone)) {
    console.error(
      `[calendar config] account ${accountId} has an unknown timezone "${row.timezone}" — booking disabled until it is corrected.`,
    )
    return null
  }

  const workingHours = parseWorkingHours(row.working_hours)
  if (!workingHours) {
    console.error(
      `[calendar config] account ${accountId} has malformed working_hours — booking disabled until it is corrected.`,
    )
    return null
  }

  let refreshToken: string
  try {
    refreshToken = decrypt(row.refresh_token)
  } catch {
    console.error(
      `[calendar config] refresh token for account ${accountId} could not be decrypted — check ENCRYPTION_KEY; the calendar must be reconnected.`,
    )
    return null
  }

  return {
    provider: row.provider,
    refreshToken,
    calendarId: row.calendar_id,
    connectedEmail: row.connected_email,
    timezone: row.timezone,
    slotMinutes: row.slot_minutes,
    bufferMinutes: row.buffer_minutes,
    minNoticeMinutes: row.min_notice_minutes,
    maxDaysAhead: row.max_days_ahead,
    offerSlots: row.offer_slots,
    workingHours,
    bookingEnabled: row.booking_enabled,
  }
}

/**
 * The account's timezone, or `null` when no calendar row exists.
 *
 * Deliberately does not decrypt anything. Every prompt needs a zone to
 * date the conversation in — including drafts, and including accounts
 * whose OAuth token has gone stale — and a decrypt failure must not cost
 * the agent its calendar.
 */
export async function loadTimezone(
  db: SupabaseClient,
  accountId: string,
): Promise<string | null> {
  const { data } = await db
    .from('ai_calendar_configs')
    .select('timezone')
    .eq('account_id', accountId)
    .maybeSingle()
  const timezone = (data as { timezone: string } | null)?.timezone
  return timezone && isValidTimezone(timezone) ? timezone : null
}

/** The confirmation sentence, kept out of `CalendarConfig` because only
 *  the booking path needs it and it must never reach the model. */
export async function loadConfirmationTemplate(
  db: SupabaseClient,
  accountId: string,
): Promise<string | null> {
  const { data } = await db
    .from('ai_calendar_configs')
    .select('confirmation_template')
    .eq('account_id', accountId)
    .maybeSingle()
  return (data as { confirmation_template: string } | null)?.confirmation_template ?? null
}
