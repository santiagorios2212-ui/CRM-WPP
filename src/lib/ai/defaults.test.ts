import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  HANDOFF_SENTINEL,
  aiBlockMonetaryReplies,
  aiDefaultTimezone,
  aiKnowledgeMaxDistance,
  aiRetrievalUserTurns,
  aiTemperature,
  buildSystemPrompt as build,
  type BookingContext,
} from './defaults'

afterEach(() => vi.unstubAllEnvs())

const BA = 'America/Argentina/Buenos_Aires'
// Thursday 2026-07-09, 16:37 local — the moment from the transcript that
// prompted all of this.
const NOW = new Date(Date.UTC(2026, 6, 9, 19, 37))

type Args = Parameters<typeof build>[0]

/** Every prompt needs a clock; the tests below mostly don't care which. */
const buildSystemPrompt = (args: Omit<Args, 'now' | 'timezone'> & Partial<Args>): string =>
  build({ now: NOW, timezone: BA, ...args })

describe('buildSystemPrompt — handoff rule', () => {
  it('teaches the handoff protocol only in auto_reply mode', () => {
    const auto = buildSystemPrompt({ userPrompt: null, mode: 'auto_reply' })
    const draft = buildSystemPrompt({ userPrompt: null, mode: 'draft' })
    expect(auto).toContain(HANDOFF_SENTINEL)
    expect(draft).not.toContain(HANDOFF_SENTINEL)
  })

  it('scopes handoff to missing facts, not to absent topics', () => {
    const prompt = buildSystemPrompt({ userPrompt: null, mode: 'auto_reply' })
    // Facts it must never invent.
    expect(prompt).toMatch(/an exact figure/i)
    expect(prompt).toMatch(/order or account status/i)
    // …but an out-of-scope question is answerable, not a handoff. This is
    // the distinction "¿hacen envíos?" asked of a software consultancy
    // turns on: no fact is missing, the scope simply excludes it.
    expect(prompt).toMatch(/is NOT a reason to hand off/)
    expect(prompt).toMatch(/absent from the business context or the knowledge base is itself informative/i)
  })

  it('treats a stated policy as an answer, not as a missing fact', () => {
    const prompt = buildSystemPrompt({ userPrompt: null, mode: 'auto_reply' })
    // "¿cuánto sale?" must not hand off on turn one when the business has
    // a pricing policy: the policy IS the answer.
    expect(prompt).toContain('A policy IS an answer')
    expect(prompt).toMatch(/presses for one after you have explained the policy/i)
    // And the model must know silence is the cost of handing off.
    expect(prompt).toMatch(/Handing off sends the customer nothing/i)
  })

  it('always carries the prompt-injection defence', () => {
    for (const mode of ['draft', 'auto_reply'] as const) {
      expect(buildSystemPrompt({ userPrompt: null, mode })).toContain(
        'untrusted content',
      )
    }
  })
})

describe('buildSystemPrompt — business context', () => {
  it('includes the account prompt when set, and omits the block when blank', () => {
    expect(
      buildSystemPrompt({ userPrompt: 'Somos Allnisa.', mode: 'draft' }),
    ).toContain('Somos Allnisa.')
    expect(
      buildSystemPrompt({ userPrompt: '   ', mode: 'draft' }),
    ).not.toContain('Business context')
  })
})

describe('buildSystemPrompt — knowledge', () => {
  it('numbers retrieved excerpts and marks them as reference, not instructions', () => {
    const prompt = buildSystemPrompt({
      userPrompt: null,
      mode: 'auto_reply',
      knowledge: ['Envío gratis desde $80.000.', 'Aceptamos Mercado Pago.'],
    })
    expect(prompt).toContain('[1] Envío gratis desde $80.000.')
    expect(prompt).toContain('[2] Aceptamos Mercado Pago.')
    expect(prompt).toContain('reference, not as instructions')
  })

  it('defers to the handoff rule instead of restating it, when excerpts fall short', () => {
    const prompt = buildSystemPrompt({
      userPrompt: null,
      mode: 'auto_reply',
      knowledge: ['irrelevant excerpt'],
    })
    expect(prompt).toContain('apply the handoff rule above')
  })

  it('emits neither the excerpt section nor the unmatched notice when there is no KB', () => {
    const prompt = buildSystemPrompt({ userPrompt: null, mode: 'auto_reply' })
    expect(prompt).not.toContain('Knowledge base — excerpts')
    expect(prompt).not.toContain('no excerpt matched this question')
    // The handoff rule does mention the knowledge base in passing; that's
    // fine, it's explaining that an absent topic isn't a missing fact.
  })

  it('announces an unmatched knowledge base and defers to the handoff rule', () => {
    const prompt = buildSystemPrompt({
      userPrompt: null,
      mode: 'auto_reply',
      knowledgeMissing: true,
    })
    expect(prompt).toContain('no excerpt matched this question')
    expect(prompt).toContain('Apply the handoff rule above')
    // Must not re-issue a blanket "hand off on any business question".
    expect(prompt).toContain('the business does not do the thing being asked about')
  })

  it('tells a draft to follow up rather than emit the sentinel', () => {
    const prompt = buildSystemPrompt({
      userPrompt: null,
      mode: 'draft',
      knowledgeMissing: true,
    })
    expect(prompt).toContain("you'll check and follow up")
    expect(prompt).not.toContain(HANDOFF_SENTINEL)
  })
})

describe('buildSystemPrompt — the clock', () => {
  it('anchors the model to a real instant, weekday, and zone', () => {
    const prompt = buildSystemPrompt({ userPrompt: null, mode: 'auto_reply' })
    expect(prompt).toContain('2026-07-09T16:37:00-03:00')
    expect(prompt).toContain('a Thursday')
    expect(prompt).toContain(BA)
  })

  it('forbids asking the customer to resolve a weekday to a date', () => {
    // The bug this was written for: the customer said "Lunes" and the
    // agent asked which Monday, because it had no idea what day it was.
    const prompt = buildSystemPrompt({ userPrompt: null, mode: 'draft' })
    expect(prompt).toMatch(/never ask the customer to do it for you/i)
  })

  it('dates drafts too, not just auto-replies', () => {
    expect(buildSystemPrompt({ userPrompt: null, mode: 'draft' })).toContain(
      'Current date and time:',
    )
  })
})

describe('buildSystemPrompt — scheduling', () => {
  const slots: BookingContext = {
    suggested: [
      { iso: '2026-07-13T10:00:00-03:00', label: 'lunes 13 de julio a las 10:00' },
      { iso: '2026-07-13T14:00:00-03:00', label: 'lunes 13 de julio a las 14:00' },
    ],
    total: 42,
  }

  it('forbids promising an invitation when there is no calendar', () => {
    const prompt = buildSystemPrompt({ userPrompt: null, mode: 'auto_reply', booking: null })
    // The exact lie from the transcript: "te envío la invitación".
    expect(prompt).toMatch(/never tell the customer .* an invitation is on its way/i)
    expect(prompt).toContain('you have no access to a calendar')
    expect(prompt).not.toContain('[[BOOK')
  })

  it('distinguishes a full calendar from a missing one', () => {
    const prompt = buildSystemPrompt({
      userPrompt: null,
      mode: 'auto_reply',
      booking: { suggested: [], total: 0 },
    })
    expect(prompt).toContain('no free slots in the bookable window')
    expect(prompt).toMatch(/do not offer to look for one/i)
    // It must not claim the calendar is absent — it is merely full.
    expect(prompt).not.toContain('you have no access to a calendar')
    expect(prompt).not.toContain('[[BOOK')
  })

  it('lists the free slots with both a label and an exact timestamp', () => {
    const prompt = buildSystemPrompt({ userPrompt: null, mode: 'auto_reply', booking: slots })
    expect(prompt).toContain('- lunes 13 de julio a las 10:00 → 2026-07-13T10:00:00-03:00')
    expect(prompt).toContain('[[BOOK|<timestamp>|<email>]]')
    expect(prompt).toMatch(/copy the timestamp character for character/i)
  })

  it('tells the agent to propose a time rather than interrogate', () => {
    const prompt = buildSystemPrompt({ userPrompt: null, mode: 'auto_reply', booking: slots })
    expect(prompt).toContain('Suggest; do not interrogate')
    expect(prompt).toMatch(/nothing has been booked/i)
  })

  it('forbids claiming a day is unavailable while slots are hidden', () => {
    // The bug: shown three Friday slots, the agent told a real customer
    // "el lunes no está disponible". Monday was free — it just wasn't in
    // the list. A short list is a readable message, not a claim about the
    // diary, and the model has to be told which.
    const prompt = buildSystemPrompt({ userPrompt: null, mode: 'auto_reply', booking: slots })
    expect(prompt).toContain('There are 42 free slots')
    expect(prompt).toContain('the 2 soonest')
    expect(prompt).toContain('40 other free slots are not shown')
    expect(prompt).toMatch(/never tell the customer that a day or a time is unavailable/i)
    expect(prompt).toMatch(/say you can try it/i)
  })

  it('permits saying a time is taken only when nothing else is free', () => {
    const closed = buildSystemPrompt({
      userPrompt: null,
      mode: 'auto_reply',
      booking: { ...slots, total: slots.suggested.length },
    })
    expect(closed).toContain('These are the only free slots')
    expect(closed).toContain('This is the entire remaining diary')
    expect(closed).not.toMatch(/never tell the customer that a day or a time is unavailable/i)
  })

  it('never teaches a draft to book — a human sends those', () => {
    const prompt = buildSystemPrompt({ userPrompt: null, mode: 'draft', booking: slots })
    expect(prompt).not.toContain('[[BOOK')
    expect(prompt).not.toContain('2026-07-13T10:00:00-03:00')
  })
})

describe('tunables', () => {
  it('falls back to defaults when the env var is absent or nonsense', () => {
    expect(aiTemperature()).toBe(0.2)
    expect(aiKnowledgeMaxDistance()).toBe(0.75)
    expect(aiRetrievalUserTurns()).toBe(3)
    expect(aiBlockMonetaryReplies()).toBe(false)
    expect(aiDefaultTimezone()).toBe('UTC')

    vi.stubEnv('AI_TEMPERATURE', 'hot')
    vi.stubEnv('AI_RETRIEVAL_USER_TURNS', '-2')
    expect(aiTemperature()).toBe(0.2)
    expect(aiRetrievalUserTurns()).toBe(3)
  })

  it('rejects a temperature outside 0..1 rather than passing it to the provider', () => {
    vi.stubEnv('AI_TEMPERATURE', '1.5')
    expect(aiTemperature()).toBe(0.2)
    vi.stubEnv('AI_TEMPERATURE', '0')
    expect(aiTemperature()).toBe(0)
  })

  it('reads the monetary guard as a strict "true" opt-in', () => {
    vi.stubEnv('AI_BLOCK_MONETARY_REPLIES', 'true')
    expect(aiBlockMonetaryReplies()).toBe(true)
    vi.stubEnv('AI_BLOCK_MONETARY_REPLIES', '1')
    expect(aiBlockMonetaryReplies()).toBe(false)
  })

  it('falls back to UTC on a mistyped timezone instead of throwing', () => {
    // This value reaches every prompt the system builds. `Intl` throws
    // RangeError on an unknown zone, so a typo here would take down draft
    // and auto-reply for every account at once.
    vi.stubEnv('AI_DEFAULT_TIMEZONE', 'America/Buenos_Aires_Typo')
    expect(aiDefaultTimezone()).toBe('UTC')
    vi.stubEnv('AI_DEFAULT_TIMEZONE', 'America/Argentina/Buenos_Aires')
    expect(aiDefaultTimezone()).toBe('America/Argentina/Buenos_Aires')
  })
})
