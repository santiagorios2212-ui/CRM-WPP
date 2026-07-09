// ============================================================
// Shared types for calendar-backed meeting booking.
//
// The AI agent offers real free slots from the account's calendar and
// books the one the customer picks. Everything here is provider-neutral;
// `google.ts` is the only module that knows about Google.
// ============================================================

export type CalendarProvider = 'google'

/**
 * Local wall-clock working hours, keyed by weekday number as a string
 * ("0" = Sunday … "6" = Saturday, matching `Date.prototype.getUTCDay`).
 * Keys are strings because this round-trips through a `jsonb` column.
 *
 * A missing key means "closed that day". Multiple ranges express a
 * split shift: `{ "1": [["09:00","13:00"], ["14:00","18:00"]] }`.
 */
export type WorkingHours = Record<string, [string, string][]>

export const DEFAULT_WORKING_HOURS: WorkingHours = {
  '1': [['09:00', '17:00']],
  '2': [['09:00', '17:00']],
  '3': [['09:00', '17:00']],
  '4': [['09:00', '17:00']],
  '5': [['09:00', '17:00']],
}

/**
 * Account calendar setup, decrypted and ready to use. Produced by
 * `loadCalendarConfig` — `refreshToken` is the plaintext Google OAuth
 * refresh token (stored AES-256-GCM-encrypted at rest, same as the
 * WhatsApp access token).
 */
export interface CalendarConfig {
  provider: CalendarProvider
  refreshToken: string
  /** Google calendar to read and write. `primary` for the main one. */
  calendarId: string
  /** Which Google account is connected — shown in Settings, never used
   *  for auth. Null when the `userinfo.email` scope was declined. */
  connectedEmail: string | null
  /** IANA zone, e.g. `America/Argentina/Buenos_Aires`. All working-hour
   *  strings are wall-clock times in this zone. */
  timezone: string
  /** Meeting length. Also the granularity slots are generated on. */
  slotMinutes: number
  /** Minutes kept free either side of a meeting. Guards against the
   *  agent booking something flush against an existing event. */
  bufferMinutes: number
  /** How soon a meeting may be booked. Stops the agent from offering a
   *  slot fifteen minutes from now that nobody will make. */
  minNoticeMinutes: number
  /** How far ahead to look, counted in whole local days from the first
   *  bookable one and inclusive of it: 0 means "today only", 14 means
   *  "through the end of the day a fortnight out". Bounds the free/busy
   *  query too. */
  maxDaysAhead: number
  /** How many slots to put in front of the customer at once. The agent
   *  may still book any bookable slot the customer names — see
   *  `computeSlots`, which returns the full set. */
  offerSlots: number
  workingHours: WorkingHours
  /** Master switch. When false the agent must never offer or promise a
   *  meeting; scheduling questions hand off to a human instead. */
  bookingEnabled: boolean
}

/** A half-open busy interval `[start, end)` from the calendar. */
export interface BusyInterval {
  start: Date
  end: Date
}

/** A bookable meeting slot, half-open `[start, end)`. */
export interface Slot {
  start: Date
  end: Date
}

/** Outcome of a booking attempt against the calendar provider. */
export interface BookingResult {
  eventId: string
  /** Google Meet link, when the provider generated one. */
  meetUrl: string | null
}

/** Typed error for calendar failures, mirroring `AiError`'s contract so
 *  callers can branch on `code` rather than parse messages. */
export class CalendarError extends Error {
  readonly code: string
  readonly status: number
  constructor(message: string, opts: { code?: string; status?: number } = {}) {
    super(message)
    this.name = 'CalendarError'
    this.code = opts.code ?? 'calendar_error'
    this.status = opts.status ?? 502
  }
}
