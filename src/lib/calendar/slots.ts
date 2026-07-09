import type { BusyInterval, CalendarConfig, Slot } from './types'
import { tzParts, zonedToUtc } from './tz'

// ============================================================
// The slot engine: busy intervals in, bookable slots out.
//
// Pure and synchronous. Every policy the account configures — working
// hours, meeting length, buffers, notice, horizon — is applied here and
// nowhere else, so "is this slot bookable?" has exactly one answer and
// the booking guard can re-ask it at write time.
// ============================================================

const MINUTE = 60_000
const DAY = 86_400_000

/** `"09:30"` → `[9, 30]`. Throws on anything else — these strings come
 *  from a validated config, and a silent 0:00 would open the calendar. */
function parseHm(hm: string): [number, number] {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hm)
  if (!m) throw new Error(`Invalid working-hours time: "${hm}"`)
  return [Number(m[1]), Number(m[2])]
}

/**
 * Does `[start, end)`, padded by `bufferMinutes` on both sides, touch
 * any busy interval? Half-open on both sides, so a meeting ending
 * exactly when another begins does not collide — the buffer, not the
 * comparison, is what keeps them apart.
 */
function collides(
  start: Date,
  end: Date,
  busy: BusyInterval[],
  bufferMinutes: number,
): boolean {
  const from = start.getTime() - bufferMinutes * MINUTE
  const to = end.getTime() + bufferMinutes * MINUTE
  return busy.some((b) => from < b.end.getTime() && to > b.start.getTime())
}

/**
 * Every slot that could be booked right now, in chronological order.
 *
 * Returns the *full* bookable set, not just the handful the agent shows
 * the customer. Offering and validating are deliberately different
 * questions: we suggest `config.offerSlots` times to keep the WhatsApp
 * message readable, but a customer who replies "¿y el jueves a las 15?"
 * names a slot that was never offered and is nonetheless perfectly
 * bookable. `isBookable` checks membership in this set, so the agent can
 * accept it — while a slot that fails any policy is rejected no matter
 * how the conversation arrived at it.
 *
 * `now` is injected rather than read from the clock: the booking guard
 * recomputes this set moments before writing to the calendar, and it
 * must reach the same verdict as the pass that built the prompt.
 */
export function computeSlots(args: {
  busy: BusyInterval[]
  config: CalendarConfig
  now: Date
}): Slot[] {
  const { busy, config, now } = args
  const {
    timezone,
    slotMinutes,
    bufferMinutes,
    minNoticeMinutes,
    maxDaysAhead,
    workingHours,
  } = config

  const earliest = now.getTime() + minNoticeMinutes * MINUTE
  const length = slotMinutes * MINUTE

  // Walk civil dates, not instants. Adding 24h to a local midnight drifts
  // by an hour across a DST boundary; incrementing the *calendar day* and
  // re-resolving midnight in the zone never does. The UTC-proxy date here
  // is a carrier for (year, month, day) only — its instant is meaningless.
  //
  // The day loop is also the horizon: `maxDaysAhead` counts whole local
  // days from the first bookable one, inclusive, so 0 means "today" and
  // 14 means "through the end of the day a fortnight out". A rolling
  // `now + N*24h` cutoff would instead chop the last day off mid-
  // afternoon at whatever hour the customer happened to write in.
  const today = tzParts(new Date(earliest), timezone)
  const firstDay = Date.UTC(today.year, today.month - 1, today.day)

  const slots: Slot[] = []
  for (let i = 0; i <= maxDaysAhead; i++) {
    const civil = new Date(firstDay + i * DAY)
    const year = civil.getUTCFullYear()
    const month = civil.getUTCMonth() + 1
    const day = civil.getUTCDate()

    const ranges = workingHours[String(civil.getUTCDay())] ?? []
    for (const [from, to] of ranges) {
      const [fromHour, fromMinute] = parseHm(from)
      const [toHour, toMinute] = parseHm(to)
      const rangeEnd = zonedToUtc(year, month, day, toHour, toMinute, timezone)

      let start = zonedToUtc(year, month, day, fromHour, fromMinute, timezone)
      for (
        ;
        start.getTime() + length <= rangeEnd.getTime();
        start = new Date(start.getTime() + length)
      ) {
        const end = new Date(start.getTime() + length)
        if (start.getTime() < earliest) continue // in the past, or too soon
        if (collides(start, end, busy, bufferMinutes)) continue
        slots.push({ start, end })
      }
    }
  }

  // Working-hour ranges are authored per day and could be listed out of
  // order (a split shift written evening-first). Days are already in
  // order; sorting the whole set is cheap and makes "the first N slots"
  // mean "the soonest N".
  return slots.sort((a, b) => a.start.getTime() - b.start.getTime())
}

/**
 * Is `instant` the start of a currently-bookable slot?
 *
 * Exact instant equality against the computed set — never a range check.
 * The model is shown a list of starts and must echo one back verbatim;
 * anything else (a time it invented, a slot booked out from under it
 * seconds ago, an off-by-one-hour timezone slip) fails here and is
 * handed to a human. Being strict is the whole point: a false accept
 * puts a wrong meeting in the account's calendar.
 */
export function isBookable(instant: Date, slots: Slot[]): boolean {
  return slots.some((s) => s.start.getTime() === instant.getTime())
}
