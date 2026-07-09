import { describe, it, expect } from 'vitest'
import { looksLikeBooking, parseBooking, stripBooking } from './booking'

const ok = '[[BOOK|2026-07-13T10:00:00-03:00|Juan@Example.com]]'

describe('parseBooking — the happy path', () => {
  it('extracts the instant and normalises the address', () => {
    const req = parseBooking(ok)!
    expect(req.instant.toISOString()).toBe('2026-07-13T13:00:00.000Z')
    expect(req.email).toBe('juan@example.com')
    expect(req.iso).toBe('2026-07-13T10:00:00-03:00')
  })

  it('finds the marker even when the model adds chatter around it', () => {
    expect(parseBooking(`Perfecto. ${ok}`)?.email).toBe('juan@example.com')
  })

  it('accepts Z and a seconds-less timestamp', () => {
    expect(parseBooking('[[BOOK|2026-07-13T13:00:00Z|a@b.co]]')?.instant.toISOString()).toBe(
      '2026-07-13T13:00:00.000Z',
    )
    expect(parseBooking('[[BOOK|2026-07-13T10:00-03:00|a@b.co]]')?.instant.toISOString()).toBe(
      '2026-07-13T13:00:00.000Z',
    )
  })
})

describe('parseBooking — refusals', () => {
  it('returns null when there is no marker', () => {
    expect(parseBooking('¿Qué día te viene bien?')).toBeNull()
  })

  it('refuses a timestamp with no UTC offset', () => {
    // The killer case: Date.parse would resolve this against the server's
    // zone (UTC on Vercel) and book three hours early.
    expect(parseBooking('[[BOOK|2026-07-13T10:00:00|a@b.co]]')).toBeNull()
  })

  it('refuses a date with no time, and a time with no date', () => {
    expect(parseBooking('[[BOOK|2026-07-13|a@b.co]]')).toBeNull()
    expect(parseBooking('[[BOOK|10:00:00-03:00|a@b.co]]')).toBeNull()
  })

  it('refuses a natural-language time', () => {
    expect(parseBooking('[[BOOK|lunes 13 a las 10|a@b.co]]')).toBeNull()
  })

  it('refuses two markers rather than picking one', () => {
    const two = `${ok}${ok.replace('10:00', '14:00')}`
    expect(parseBooking(two)).toBeNull()
  })

  it('refuses a malformed address', () => {
    expect(parseBooking('[[BOOK|2026-07-13T10:00:00-03:00|no-arroba]]')).toBeNull()
    expect(parseBooking('[[BOOK|2026-07-13T10:00:00-03:00|a@b]]')).toBeNull()
    expect(parseBooking('[[BOOK|2026-07-13T10:00:00-03:00|a b@c.co]]')).toBeNull()
  })

  it('refuses a marker missing a field', () => {
    expect(parseBooking('[[BOOK|2026-07-13T10:00:00-03:00]]')).toBeNull()
    expect(parseBooking('[[BOOK||a@b.co]]')).toBeNull()
  })

  it('refuses a syntactically valid but impossible date', () => {
    // Date.parse rolls these over silently — Feb 31 becomes Mar 3 — which
    // would book a real slot on a day nobody agreed to.
    expect(parseBooking('[[BOOK|2026-02-31T10:00:00-03:00|a@b.co]]')).toBeNull()
    expect(parseBooking('[[BOOK|2026-04-31T10:00:00-03:00|a@b.co]]')).toBeNull()
    expect(parseBooking('[[BOOK|2026-13-01T10:00:00-03:00|a@b.co]]')).toBeNull()
    expect(parseBooking('[[BOOK|2026-00-10T10:00:00-03:00|a@b.co]]')).toBeNull()
    // …but a real leap day is fine. 2028 is a leap year; 2026 is not.
    expect(parseBooking('[[BOOK|2028-02-29T10:00:00-03:00|a@b.co]]')).not.toBeNull()
    expect(parseBooking('[[BOOK|2026-02-29T10:00:00-03:00|a@b.co]]')).toBeNull()
  })

  it('refuses an out-of-range time or offset', () => {
    expect(parseBooking('[[BOOK|2026-07-13T25:00:00-03:00|a@b.co]]')).toBeNull()
    expect(parseBooking('[[BOOK|2026-07-13T10:70:00-03:00|a@b.co]]')).toBeNull()
    expect(parseBooking('[[BOOK|2026-07-13T10:00:00-99:00|a@b.co]]')).toBeNull()
  })
})

describe('looksLikeBooking', () => {
  it('separates a botched booking attempt from an ordinary reply', () => {
    // Both parse to null, but only one wanted to book. The first must
    // hand off; the second is just a message.
    expect(looksLikeBooking('[[BOOK|garbage]]')).toBe(true)
    expect(parseBooking('[[BOOK|garbage]]')).toBeNull()
    expect(looksLikeBooking('¿Te va bien el lunes?')).toBe(false)
  })
})

describe('stripBooking', () => {
  it('never lets the marker reach the customer', () => {
    expect(stripBooking(`¡Listo! ${ok}`)).toBe('¡Listo!')
    expect(stripBooking(ok)).toBe('')
  })
})
