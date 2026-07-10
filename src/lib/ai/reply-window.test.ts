import { describe, it, expect } from 'vitest'
import { replyWindowExpired } from './reply-window'

const NOW = new Date('2026-07-10T12:00:00Z')
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000)

describe('replyWindowExpired', () => {
  it('treats a never-opened window as expired, so the first message opens one', () => {
    expect(replyWindowExpired(null, 360, NOW)).toBe(true)
    expect(replyWindowExpired(undefined, 360, NOW)).toBe(true)
  })

  it('is open inside the window and expired past it', () => {
    expect(replyWindowExpired(minutesAgo(359), 360, NOW)).toBe(false)
    expect(replyWindowExpired(minutesAgo(360), 360, NOW)).toBe(true)
    expect(replyWindowExpired(minutesAgo(361), 360, NOW)).toBe(true)
  })

  it('never expires when reset is disabled', () => {
    // 0 = lifetime cap: a window, once open, stays open forever.
    expect(replyWindowExpired(minutesAgo(100_000), 0, NOW)).toBe(false)
    expect(replyWindowExpired(minutesAgo(100_000), -1, NOW)).toBe(false)
    // …but a thread that never opened one still gets its first window.
    expect(replyWindowExpired(null, 0, NOW)).toBe(true)
  })

  it('accepts an ISO string, as the row arrives from the database', () => {
    expect(replyWindowExpired('2026-07-10T05:00:00Z', 360, NOW)).toBe(true) // 7h ago
    expect(replyWindowExpired('2026-07-10T11:00:00Z', 360, NOW)).toBe(false) // 1h ago
  })

  it('reopens rather than wedges on an unparseable timestamp', () => {
    expect(replyWindowExpired('not-a-date', 360, NOW)).toBe(true)
  })
})
