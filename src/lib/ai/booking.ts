// ============================================================
// The booking sentinel.
//
// `generateReply` is a single-shot completion — there is no tool-calling
// loop, and adding one would mean reworking both provider adapters and
// the timeout budget of a webhook that must answer Meta in seconds. So
// the agent asks to book the same way it asks to hand off: by emitting a
// marker the code parses.
//
// Everything here is parsing and rejection. Nothing in this file trusts
// the model: the instant it names is checked against a freshly computed
// slot set before a single byte reaches the calendar (see `isBookable`).
// A malformed, ambiguous, or invented marker is not an error to recover
// from — it is a handoff to a human.
// ============================================================

/** Shown to the model. Kept in one place so the prompt and the parser
 *  can never drift apart. */
export const BOOK_SENTINEL_TEMPLATE = '[[BOOK|<timestamp>|<email>]]'

// Neither field may contain `|` or `]`, which is what makes the marker
// unambiguously delimited without escaping.
const BOOK_SENTINEL_RE = /\[\[BOOK\|([^|\]]+)\|([^|\]]+)\]\]/g

/**
 * ISO-8601 with an explicit UTC offset (`-03:00`) or `Z`.
 *
 * The offset is mandatory. `Date.parse('2026-07-13T10:00:00')` resolves
 * against the *server's* zone — on Vercel that is UTC, so a model that
 * omits the offset would silently book Buenos Aires meetings three hours
 * early. Rejecting the string outright is the only safe reading.
 */
const ISO_WITH_OFFSET_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:\d{2})$/

/**
 * Resolve a validated ISO string to an instant, or `null` if it names a
 * date that does not exist.
 *
 * We do the arithmetic ourselves instead of calling `Date.parse`, which
 * silently *overflows* out-of-range components rather than rejecting
 * them: `Date.parse('2026-02-31T10:00:00-03:00')` cheerfully returns
 * March 3rd. A model that hallucinates the 31st of February would then
 * get a real, bookable instant three days after the date the customer
 * agreed to — and if that slot happened to be free, `isBookable` would
 * wave it through. So we rebuild the date and insist the components
 * survive the round trip.
 */
function toInstant(match: RegExpMatchArray): Date | null {
  const [, y, mo, d, h, mi, s, offset] = match
  const year = Number(y)
  const month = Number(mo)
  const day = Number(d)
  const hour = Number(h)
  const minute = Number(mi)
  const second = s === undefined ? 0 : Number(s)

  if (month < 1 || month > 12) return null
  if (day < 1 || day > 31) return null
  if (hour > 23 || minute > 59 || second > 59) return null

  const utc = new Date(Date.UTC(year, month - 1, day, hour, minute, second))
  // Feb 31 → Mar 3. The only reliable test for "this date exists".
  if (
    utc.getUTCFullYear() !== year ||
    utc.getUTCMonth() !== month - 1 ||
    utc.getUTCDate() !== day
  ) {
    return null
  }

  let offsetMinutes = 0
  if (offset !== 'Z') {
    const sign = offset[0] === '-' ? -1 : 1
    const offsetHour = Number(offset.slice(1, 3))
    const offsetMinute = Number(offset.slice(4, 6))
    if (offsetHour > 23 || offsetMinute > 59) return null
    offsetMinutes = sign * (offsetHour * 60 + offsetMinute)
  }

  return new Date(utc.getTime() - offsetMinutes * 60_000)
}

/** Deliberately conservative. A rejected address costs one handoff; an
 *  accepted bad one sends a calendar invite into the void and tells the
 *  customer it arrived. */
const EMAIL_RE = /^[^\s@]+@[^\s@,;:<>()[\]]+\.[a-z]{2,}$/i

export interface BookingRequest {
  /** The instant the customer agreed to. */
  instant: Date
  /** The timestamp exactly as the model wrote it — logged on rejection,
   *  so a systematic formatting drift is visible rather than mysterious. */
  iso: string
  /** Lower-cased attendee address. */
  email: string
}

/**
 * Pull a booking request out of raw model output, or `null` if there
 * isn't exactly one well-formed request.
 *
 * Returns `null` — never throws, never guesses — when the marker is
 * absent, malformed, duplicated, missing its timezone offset, naming a
 * date that does not exist, or carrying an address that isn't one.
 * Callers treat `null` on a reply that *looks* like it wanted to book as
 * a handoff.
 *
 * Two markers mean the model contradicted itself about which slot to
 * take. There is no safe way to pick one, so we take neither.
 */
export function parseBooking(raw: string): BookingRequest | null {
  const matches = [...raw.matchAll(BOOK_SENTINEL_RE)]
  if (matches.length !== 1) return null

  const [, isoRaw, emailRaw] = matches[0]
  const iso = isoRaw.trim()
  const email = emailRaw.trim().toLowerCase()

  if (!EMAIL_RE.test(email)) return null

  const isoMatch = ISO_WITH_OFFSET_RE.exec(iso)
  if (!isoMatch) return null

  const instant = toInstant(isoMatch)
  if (!instant) return null

  return { instant, iso, email }
}

/** True when the output contains a booking marker, well-formed or not.
 *  Lets the caller distinguish "the model tried to book and botched it"
 *  (→ hand off) from "the model wrote an ordinary reply" (→ send it). */
export function looksLikeBooking(raw: string): boolean {
  return raw.includes('[[BOOK')
}

/** Model output with any booking marker removed. The agent is told to
 *  emit the marker alone, but a stray "¡Listo!" alongside it must never
 *  reach the customer with the marker still in it. */
export function stripBooking(raw: string): string {
  return raw.replace(BOOK_SENTINEL_RE, '').trim()
}
