import { describe, it, expect } from 'vitest'
import { latestUserMessage, recentUserMessages } from './query'

describe('latestUserMessage', () => {
  it('returns the most recent user turn', () => {
    expect(
      latestUserMessage([
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'reply' },
        { role: 'user', content: 'latest' },
      ]),
    ).toBe('latest')
  })

  it('falls back to the last message when none are user', () => {
    expect(
      latestUserMessage([{ role: 'assistant', content: 'only assistant' }]),
    ).toBe('only assistant')
  })

  it('returns empty string for no messages', () => {
    expect(latestUserMessage([])).toBe('')
  })
})

describe('recentUserMessages', () => {
  it('joins the last n user turns oldest-first, skipping assistant turns', () => {
    expect(
      recentUserMessages(
        [
          { role: 'user', content: 'quiero un CRM' },
          { role: 'assistant', content: 'genial' },
          { role: 'user', content: '¿y cuánto sale?' },
        ],
        3,
      ),
    ).toBe('quiero un CRM\n¿y cuánto sale?')
  })

  it('keeps only the most recent n turns', () => {
    expect(
      recentUserMessages(
        [
          { role: 'user', content: 'a' },
          { role: 'user', content: 'b' },
          { role: 'user', content: 'c' },
        ],
        2,
      ),
    ).toBe('b\nc')
  })

  it('falls back to the last message when there are no user turns', () => {
    expect(
      recentUserMessages([{ role: 'assistant', content: 'only assistant' }], 3),
    ).toBe('only assistant')
  })

  it('returns empty string for no messages', () => {
    expect(recentUserMessages([], 3)).toBe('')
  })
})
