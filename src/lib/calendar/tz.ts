// ============================================================
// Timezone arithmetic, without a timezone library.
//
// We need exactly three things: read an instant's wall-clock parts in a
// given IANA zone, turn a wall-clock time in that zone back into an
// instant, and render an ISO-8601 string with the zone's offset. `Intl`
// already ships the IANA database, so a dependency would buy us nothing
// but a version-skew problem.
//
// Everything here is pure and takes `now` as an argument — no ambient
// clock, so the slot engine is fully testable.
// ============================================================

const CACHE = new Map<string, Intl.DateTimeFormat>()

/**
 * Cached `Intl.DateTimeFormat` per zone. Constructing one is expensive
 * (it loads ICU data) and the slot engine calls into this a few hundred
 * times per conversation.
 *
 * Throws `RangeError` on an unknown zone, which is what we want:
 * `assertValidTimezone` turns that into a validation error at save time
 * so a typo in Settings can never reach the booking path.
 */
function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = CACHE.get(timeZone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    CACHE.set(timeZone, f)
  }
  return f
}

export interface WallClock {
  year: number
  month: number // 1-12
  day: number
  hour: number // 0-23
  minute: number
  second: number
  /** 0 = Sunday … 6 = Saturday, matching `Date.prototype.getUTCDay`. */
  weekday: number
}

/** True when the string names an IANA zone this runtime knows. */
export function isValidTimezone(timeZone: string): boolean {
  try {
    formatter(timeZone)
    return true
  } catch {
    return false
  }
}

/** The wall-clock reading of `instant` on a clock set to `timeZone`. */
export function tzParts(instant: Date, timeZone: string): WallClock {
  const parts = formatter(timeZone).formatToParts(instant)
  const num = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find((p) => p.type === type)
    if (!found) throw new Error(`Intl did not return a "${type}" part`)
    return Number(found.value)
  }

  const year = num('year')
  const month = num('month')
  const day = num('day')
  // `hour12: false` renders midnight as "24" on some ICU builds rather
  // than "00". Both mean the same instant; normalise to 0..23.
  const hour = num('hour') % 24

  return {
    year,
    month,
    day,
    hour,
    minute: num('minute'),
    second: num('second'),
    // Derived from the civil date rather than a localized weekday name,
    // so it never depends on locale data being present.
    weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
  }
}

/**
 * The zone's UTC offset at `instant`, in milliseconds (east of UTC is
 * positive; Buenos Aires is -10_800_000).
 */
export function tzOffsetMs(instant: Date, timeZone: string): number {
  const p = tzParts(instant, timeZone)
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  // `formatToParts` has no millisecond granularity, so compare against a
  // second-truncated instant or every offset comes out off by `ms`.
  const truncated = instant.getTime() - (instant.getTime() % 1000)
  return asUtc - truncated
}

/**
 * The instant at which the clock in `timeZone` reads the given
 * wall-clock time.
 *
 * Resolved by guess-and-correct: pretend the wall clock is UTC, measure
 * the zone's offset near that instant, subtract it, then re-measure. The
 * second pass matters only within a few hours of a DST transition, where
 * the offset that applies is the one at the *result*, not at the guess.
 *
 * Ambiguity is inherent at transitions and we do not pretend otherwise:
 * a wall-clock time skipped by spring-forward does not exist, and one
 * repeated by fall-back happens twice. We return a consistent instant
 * for both cases without erroring. Argentina has not observed DST since
 * 2009, and working hours sit far from the 00:00-03:00 window where
 * transitions land, so this is theoretical for the default config and
 * merely well-defined for the zones that do transition.
 */
export function zonedToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const naive = Date.UTC(year, month - 1, day, hour, minute)
  const firstGuess = naive - tzOffsetMs(new Date(naive), timeZone)
  const corrected = naive - tzOffsetMs(new Date(firstGuess), timeZone)
  return new Date(corrected)
}

const pad = (n: number): string => String(n).padStart(2, '0')

/**
 * ISO-8601 with the zone's own offset, e.g. `2026-07-13T10:00:00-03:00`.
 *
 * Hand-rolled rather than `toISOString()` (which is always UTC) because
 * the model is shown these strings and echoes one back to book. A local
 * offset makes the string self-evidently the time the customer agreed
 * to; a `Z`-suffixed UTC string invites the model to "helpfully" shift
 * it by three hours.
 */
export function isoWithOffset(instant: Date, timeZone: string): string {
  const p = tzParts(instant, timeZone)
  const offsetMinutes = tzOffsetMs(instant, timeZone) / 60_000
  const sign = offsetMinutes < 0 ? '-' : '+'
  const abs = Math.abs(offsetMinutes)
  const offset = `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  return (
    `${p.year}-${pad(p.month)}-${pad(p.day)}` +
    `T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}${offset}`
  )
}

const WEEKDAYS_EN = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const

/** English weekday name. Used in the system prompt, which is written in
 *  English regardless of the language the agent replies in. */
export function weekdayEn(instant: Date, timeZone: string): string {
  return WEEKDAYS_EN[tzParts(instant, timeZone).weekday]
}

// Spelled out rather than pulled from `Intl` with an `es-AR` locale:
// locale data is the one part of ICU that varies across Node builds and
// CI images, and a slot label that silently comes out in English (or
// throws) is a customer-facing bug. These never change.
const WEEKDAYS_ES = [
  'domingo',
  'lunes',
  'martes',
  'miércoles',
  'jueves',
  'viernes',
  'sábado',
] as const

const MONTHS_ES = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
] as const

/** Human label for a slot, e.g. `lunes 13 de julio a las 10:00`. */
export function formatSlotEs(instant: Date, timeZone: string): string {
  const p = tzParts(instant, timeZone)
  return (
    `${WEEKDAYS_ES[p.weekday]} ${p.day} de ${MONTHS_ES[p.month - 1]} ` +
    `a las ${pad(p.hour)}:${pad(p.minute)}`
  )
}

/** Date + time label for the "current date" prompt block, e.g.
 *  `lunes 6 de julio de 2026, 16:37`. */
export function formatNowEs(instant: Date, timeZone: string): string {
  const p = tzParts(instant, timeZone)
  return (
    `${WEEKDAYS_ES[p.weekday]} ${p.day} de ${MONTHS_ES[p.month - 1]} ` +
    `de ${p.year}, ${pad(p.hour)}:${pad(p.minute)}`
  )
}
