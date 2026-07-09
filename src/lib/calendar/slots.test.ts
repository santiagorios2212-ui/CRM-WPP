import { describe, it, expect } from 'vitest'
import { computeSlots, isBookable } from './slots'
import { DEFAULT_WORKING_HOURS, type CalendarConfig } from './types'
import { isoWithOffset } from './tz'

const BA = 'America/Argentina/Buenos_Aires'

/** Buenos Aires is a fixed UTC-3, so a local time is just `+3` in UTC.
 *  Spelling it out beats calling `zonedToUtc` and testing the engine
 *  against its own helper. All dates are July 2026: the 9th is a
 *  Thursday, the 11th/12th a weekend, the 13th a Monday. */
const at = (day: number, hour: number, minute = 0): Date =>
  new Date(Date.UTC(2026, 6, day, hour + 3, minute))

const config = (overrides: Partial<CalendarConfig> = {}): CalendarConfig => ({
  provider: 'google',
  refreshToken: 'x',
  calendarId: 'primary',
  connectedEmail: null,
  timezone: BA,
  slotMinutes: 30,
  bufferMinutes: 15,
  minNoticeMinutes: 120,
  maxDaysAhead: 14,
  offerSlots: 3,
  workingHours: DEFAULT_WORKING_HOURS,
  bookingEnabled: true,
  ...overrides,
})

const starts = (slots: { start: Date }[]): string[] =>
  slots.map((s) => isoWithOffset(s.start, BA))

describe('computeSlots — working hours', () => {
  it('generates slots only inside the configured ranges', () => {
    const slots = computeSlots({
      busy: [],
      config: config({ minNoticeMinutes: 0, maxDaysAhead: 0 }),
      now: at(9, 0), // Thursday 09:00 local, ranges are 09:00-17:00
    })
    expect(starts(slots)[0]).toBe('2026-07-09T09:00:00-03:00')
    // Last slot must *end* by 17:00, so it starts at 16:30.
    expect(starts(slots).at(-1)).toBe('2026-07-09T16:30:00-03:00')
    expect(slots).toHaveLength(16) // 8h / 30min
  })

  it('skips days with no configured hours', () => {
    const slots = computeSlots({
      busy: [],
      config: config({ minNoticeMinutes: 0, maxDaysAhead: 3 }),
      now: at(10, 18), // Friday evening — nothing left today
    })
    // Sat 11th and Sun 12th are closed; the next slot is Monday 09:00.
    expect(starts(slots)[0]).toBe('2026-07-13T09:00:00-03:00')
  })

  it('handles a split shift and returns the whole set in time order', () => {
    const slots = computeSlots({
      busy: [],
      // Deliberately authored out of order: afternoon range listed first.
      config: config({
        minNoticeMinutes: 0,
        maxDaysAhead: 0,
        slotMinutes: 60,
        bufferMinutes: 0,
        workingHours: { '4': [['14:00', '16:00'], ['09:00', '11:00']] },
      }),
      now: at(9, 7), // Thursday 07:00
    })
    expect(starts(slots)).toEqual([
      '2026-07-09T09:00:00-03:00',
      '2026-07-09T10:00:00-03:00',
      '2026-07-09T14:00:00-03:00',
      '2026-07-09T15:00:00-03:00',
    ])
  })

  it('rejects a malformed working-hours string rather than opening the calendar', () => {
    expect(() =>
      computeSlots({
        busy: [],
        config: config({ workingHours: { '4': [['9:00', '17:00']] } }),
        now: at(9, 8),
      }),
    ).toThrow(/Invalid working-hours time/)
  })
})

describe('computeSlots — notice and horizon', () => {
  it('honours the minimum notice', () => {
    const slots = computeSlots({
      busy: [],
      config: config({ maxDaysAhead: 0 }), // 120 min notice
      now: at(9, 12), // Thursday 12:00 → nothing before 14:00
    })
    expect(starts(slots)[0]).toBe('2026-07-09T14:00:00-03:00')
  })

  it('bounds the horizon to whole local days, not to a rolling 24h window', () => {
    const now = at(9, 15, 40) // Thursday 15:40
    const today = computeSlots({
      busy: [],
      config: config({ minNoticeMinutes: 0, maxDaysAhead: 0 }),
      now,
    })
    expect(starts(today)).toEqual([
      '2026-07-09T16:00:00-03:00',
      '2026-07-09T16:30:00-03:00',
    ])

    // Extending by one day adds all of Friday — not just up to 15:40.
    const withTomorrow = computeSlots({
      busy: [],
      config: config({ minNoticeMinutes: 0, maxDaysAhead: 1 }),
      now,
    })
    expect(starts(withTomorrow).at(-1)).toBe('2026-07-10T16:30:00-03:00')
  })

  it('returns nothing when the horizon closes before the next open hour', () => {
    const slots = computeSlots({
      busy: [],
      config: config({ minNoticeMinutes: 0, maxDaysAhead: 0 }),
      now: at(11, 10), // Saturday — closed, and the horizon is today
    })
    expect(slots).toEqual([])
  })
})

describe('computeSlots — busy intervals and buffers', () => {
  it('drops slots that overlap a busy interval', () => {
    const slots = computeSlots({
      busy: [{ start: at(9, 14), end: at(9, 15) }],
      config: config({ minNoticeMinutes: 0, maxDaysAhead: 0, bufferMinutes: 0 }),
      now: at(9, 13, 30),
    })
    expect(starts(slots)).toEqual([
      '2026-07-09T13:30:00-03:00',
      '2026-07-09T15:00:00-03:00',
      '2026-07-09T15:30:00-03:00',
      '2026-07-09T16:00:00-03:00',
      '2026-07-09T16:30:00-03:00',
    ])
  })

  it('keeps the buffer free on both sides of a busy interval', () => {
    const slots = computeSlots({
      busy: [{ start: at(9, 14), end: at(9, 15) }],
      config: config({ minNoticeMinutes: 0, maxDaysAhead: 0 }), // 15 min buffer
      now: at(9, 13, 0),
    })
    // 13:30-14:00 would touch the event; 15:00-15:30 would start on top
    // of it. With a 15-minute buffer the nearest bookable slots are
    // 13:00 (ends 13:30, +15 = 13:45 < 14:00) and 15:30.
    expect(starts(slots)).toEqual([
      '2026-07-09T13:00:00-03:00',
      '2026-07-09T15:30:00-03:00',
      '2026-07-09T16:00:00-03:00',
      '2026-07-09T16:30:00-03:00',
    ])
  })

  it('treats busy intervals as half-open, so back-to-back events do not bleed', () => {
    const slots = computeSlots({
      busy: [{ start: at(9, 9), end: at(9, 10) }],
      config: config({ minNoticeMinutes: 0, maxDaysAhead: 0, bufferMinutes: 0 }),
      now: at(9, 8),
    })
    // A slot starting exactly when the event ends is free.
    expect(starts(slots)[0]).toBe('2026-07-09T10:00:00-03:00')
  })

  it('returns nothing when the day is fully booked', () => {
    const slots = computeSlots({
      busy: [{ start: at(9, 8), end: at(9, 18) }],
      config: config({ minNoticeMinutes: 0, maxDaysAhead: 0 }),
      now: at(9, 8),
    })
    expect(slots).toEqual([])
  })
})

describe('computeSlots — offering versus booking', () => {
  it('returns the full bookable set, not just the slots we would show', () => {
    const slots = computeSlots({
      busy: [],
      config: config({ minNoticeMinutes: 0, maxDaysAhead: 0, offerSlots: 3 }),
      now: at(9, 9),
    })
    // `offerSlots` bounds the prompt, never the engine: a customer who
    // asks for a time we never suggested must still be able to book it.
    expect(slots.length).toBeGreaterThan(3)
  })
})

describe('isBookable', () => {
  const slots = computeSlots({
    busy: [],
    config: config({ minNoticeMinutes: 0, maxDaysAhead: 0 }),
    now: at(9, 9),
  })

  it('accepts an exact slot start', () => {
    expect(isBookable(at(9, 10, 30), slots)).toBe(true)
  })

  it('rejects a time inside a slot but not at its start', () => {
    expect(isBookable(at(9, 10, 31), slots)).toBe(false)
  })

  it('rejects a plausible-looking hallucination', () => {
    expect(isBookable(at(9, 18), slots)).toBe(false) // after hours
    expect(isBookable(at(11, 10), slots)).toBe(false) // Saturday
  })

  it('rejects an instant an hour off — the classic timezone slip', () => {
    // The model echoes back an ISO string. Writing `-02:00` where the
    // offered slot said `-03:00` names a different instant, and must not
    // silently book a meeting an hour from the one agreed to.
    expect(isBookable(new Date(Date.parse('2026-07-09T09:00:00-03:00')), slots)).toBe(
      true,
    )
    expect(isBookable(new Date(Date.parse('2026-07-09T09:00:00-02:00')), slots)).toBe(
      false,
    )
  })
})
