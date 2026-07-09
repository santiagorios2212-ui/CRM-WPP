import { describe, it, expect } from 'vitest'
import {
  formatNowEs,
  formatSlotEs,
  isValidTimezone,
  isoWithOffset,
  tzOffsetMs,
  tzParts,
  zonedToUtc,
} from './tz'

const BA = 'America/Argentina/Buenos_Aires'
const NY = 'America/New_York'

const HOUR = 3_600_000

describe('tzParts', () => {
  it('reads the wall clock of a zone, not of the host', () => {
    // 2026-07-13T13:00Z is 10:00 in Buenos Aires (UTC-3).
    const p = tzParts(new Date(Date.UTC(2026, 6, 13, 13, 0)), BA)
    expect(p).toMatchObject({ year: 2026, month: 7, day: 13, hour: 10, minute: 0 })
  })

  it('reports midnight as hour 0, never 24', () => {
    // Some ICU builds render midnight as "24" under hour12:false.
    const p = tzParts(new Date(Date.UTC(2026, 6, 13, 3, 0)), BA)
    expect(p.hour).toBe(0)
    expect(p.day).toBe(13)
  })

  it('derives the weekday from the civil date, independent of locale data', () => {
    // 2026-07-13 is a Monday.
    expect(tzParts(new Date(Date.UTC(2026, 6, 13, 13, 0)), BA).weekday).toBe(1)
    // 22:00Z on the 12th is still Sunday the 12th in Buenos Aires (19:00).
    expect(tzParts(new Date(Date.UTC(2026, 6, 12, 22, 0)), BA).weekday).toBe(0)
    // …but already Monday the 13th in UTC. The zone is what decides.
    expect(tzParts(new Date(Date.UTC(2026, 6, 13, 1, 0)), 'UTC').weekday).toBe(1)
  })
})

describe('tzOffsetMs', () => {
  it('is a constant -3h for Argentina, which has not observed DST since 2009', () => {
    expect(tzOffsetMs(new Date(Date.UTC(2026, 0, 15)), BA)).toBe(-3 * HOUR)
    expect(tzOffsetMs(new Date(Date.UTC(2026, 6, 15)), BA)).toBe(-3 * HOUR)
  })

  it('tracks DST where it exists', () => {
    expect(tzOffsetMs(new Date(Date.UTC(2026, 0, 15, 17)), NY)).toBe(-5 * HOUR) // EST
    expect(tzOffsetMs(new Date(Date.UTC(2026, 6, 15, 17)), NY)).toBe(-4 * HOUR) // EDT
  })

  it('is not thrown off by sub-second precision', () => {
    // formatToParts has no millisecond field; a naive implementation
    // subtracts a truncated instant from an untruncated one.
    expect(tzOffsetMs(new Date(Date.UTC(2026, 6, 15, 12, 0, 0, 750)), BA)).toBe(
      -3 * HOUR,
    )
  })
})

describe('zonedToUtc', () => {
  it('resolves a wall-clock time to the instant it names', () => {
    expect(zonedToUtc(2026, 7, 13, 10, 0, BA).toISOString()).toBe(
      '2026-07-13T13:00:00.000Z',
    )
  })

  it('round-trips through tzParts', () => {
    const instant = zonedToUtc(2026, 11, 3, 8, 30, NY)
    expect(tzParts(instant, NY)).toMatchObject({
      year: 2026,
      month: 11,
      day: 3,
      hour: 8,
      minute: 30,
    })
  })

  it('picks the offset in force at the result, not at the guess', () => {
    // US DST ends 2026-11-01. A wall clock reading 09:00 on Nov 2 is EST
    // (-5). The first guess lands in UTC on Nov 2 09:00Z, where the zone
    // is *also* EST — but on the spring side the two disagree, and the
    // correction pass is what saves us. 2026-03-08 02:30 does not exist
    // (clocks jump 02:00 → 03:00); we must still return a real instant.
    expect(zonedToUtc(2026, 11, 2, 9, 0, NY).toISOString()).toBe(
      '2026-11-02T14:00:00.000Z',
    )
    expect(Number.isNaN(zonedToUtc(2026, 3, 8, 2, 30, NY).getTime())).toBe(false)
    // 09:00 on the spring-forward day itself is unambiguous: EDT (-4).
    expect(zonedToUtc(2026, 3, 8, 9, 0, NY).toISOString()).toBe(
      '2026-03-08T13:00:00.000Z',
    )
  })
})

describe('isoWithOffset', () => {
  it('renders the local offset, not Z — the model echoes this string back', () => {
    expect(isoWithOffset(new Date(Date.UTC(2026, 6, 13, 13, 0)), BA)).toBe(
      '2026-07-13T10:00:00-03:00',
    )
  })

  it('renders a positive offset with a + sign', () => {
    expect(isoWithOffset(new Date(Date.UTC(2026, 6, 13, 8, 0)), 'Europe/Madrid')).toBe(
      '2026-07-13T10:00:00+02:00',
    )
  })

  it('parses back to the instant it was made from', () => {
    const instant = new Date(Date.UTC(2026, 6, 13, 13, 0))
    expect(Date.parse(isoWithOffset(instant, BA))).toBe(instant.getTime())
    expect(Date.parse(isoWithOffset(instant, NY))).toBe(instant.getTime())
  })
})

describe('isValidTimezone', () => {
  it('accepts IANA zones and rejects typos', () => {
    expect(isValidTimezone(BA)).toBe(true)
    expect(isValidTimezone('UTC')).toBe(true)
    expect(isValidTimezone('America/Buenos_Aires_Typo')).toBe(false)
    expect(isValidTimezone('')).toBe(false)
  })
})

describe('Spanish labels', () => {
  it('names the slot the way the customer will read it', () => {
    expect(formatSlotEs(new Date(Date.UTC(2026, 6, 13, 13, 0)), BA)).toBe(
      'lunes 13 de julio a las 10:00',
    )
  })

  it('states the current date with the year, for date arithmetic', () => {
    expect(formatNowEs(new Date(Date.UTC(2026, 6, 9, 19, 37)), BA)).toBe(
      'jueves 9 de julio de 2026, 16:37',
    )
  })

  it('spells accented months and days correctly', () => {
    // miércoles 2026-09-02, 08:05 local.
    expect(formatSlotEs(new Date(Date.UTC(2026, 8, 2, 11, 5)), BA)).toBe(
      'miércoles 2 de septiembre a las 08:05',
    )
  })
})
