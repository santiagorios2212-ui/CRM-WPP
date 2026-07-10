import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { DEFAULT_WORKING_HOURS, type CalendarConfig } from '@/lib/calendar/types'
import type { AiConfig } from './types'

// Shared, hoisted mock state so the module mocks can close over it.
const h = vi.hoisted(() => ({
  loadAiConfig: vi.fn(),
  buildConversationContext: vi.fn(),
  retrieveKnowledge: vi.fn(),
  hasUnreadableCustomerBurst: vi.fn(),
  generateReply: vi.fn(),
  engineSendText: vi.fn(),
  loadCalendarConfig: vi.fn(),
  loadConfirmationTemplate: vi.fn(),
  freeSlots: vi.fn(),
  bookMeeting: vi.fn(),
  state: {
    conv: null as Record<string, unknown> | null,
    autoResponders: [] as { id: string }[],
    claim: true as boolean,
    /** Whether the conditional `ai_autoreply_disabled` flip matched a row. */
    handoffClaim: true as boolean,
    updatePayload: null as Record<string, unknown> | null,
    rpcCalls: [] as { name: string; args: unknown }[],
    /** An existing row in `ai_bookings` for this conversation, if any. */
    existingBooking: null as { id: string } | null,
  },
}))

vi.mock('./config', () => ({ loadAiConfig: h.loadAiConfig }))
vi.mock('./context', () => ({ buildConversationContext: h.buildConversationContext }))
vi.mock('./knowledge', () => ({ retrieveKnowledge: h.retrieveKnowledge }))
vi.mock('./media', () => ({
  hasUnreadableCustomerBurst: h.hasUnreadableCustomerBurst,
}))
vi.mock('./generate', () => ({ generateReply: h.generateReply }))
vi.mock('@/lib/flows/meta-send', () => ({ engineSendText: h.engineSendText }))

// Only the IO is stubbed. `suggestedSlots` and `confirmationMessage` are
// pure, and mocking them would hide the thing worth testing: that the
// customer is told the time we actually wrote to the calendar.
vi.mock('@/lib/calendar/config', () => ({
  loadCalendarConfig: h.loadCalendarConfig,
  loadConfirmationTemplate: h.loadConfirmationTemplate,
}))
vi.mock('@/lib/calendar/availability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/calendar/availability')>()),
  freeSlots: h.freeSlots,
}))
vi.mock('@/lib/calendar/book', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/calendar/book')>()),
  bookMeeting: h.bookMeeting,
}))

vi.mock('./admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      if (table === 'ai_bookings') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () =>
                Promise.resolve({ data: h.state.existingBooking, error: null }),
            }),
          }),
        }
      }
      if (table === 'contacts') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () =>
                Promise.resolve({ data: { name: 'Juan Pérez' }, error: null }),
            }),
          }),
        }
      }
      if (table === 'automations') {
        // .select().eq().eq().in().limit() → active auto-responders
        const chain = {
          select: () => chain,
          eq: () => chain,
          in: () => chain,
          limit: () =>
            Promise.resolve({ data: h.state.autoResponders, error: null }),
        }
        return chain
      }
      // conversations
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: () =>
              Promise.resolve({ data: h.state.conv, error: null }),
          }),
        }),
        // .update().eq(id).eq(ai_autoreply_disabled,false).select().maybeSingle()
        // — the conditional flip that claims the handoff.
        update: (payload: Record<string, unknown>) => {
          h.state.updatePayload = payload
          const chain = {
            eq: () => chain,
            select: () => chain,
            maybeSingle: () =>
              Promise.resolve({
                data: h.state.handoffClaim ? { id: 'conv-1' } : null,
                error: null,
              }),
          }
          return chain
        },
      }
    },
    rpc: (name: string, args: unknown) => {
      h.state.rpcCalls.push({ name, args })
      return Promise.resolve({ data: h.state.claim, error: null })
    },
  }),
}))

import { dispatchInboundToAiReply } from './auto-reply'

const ARGS = {
  accountId: 'acct-1',
  conversationId: 'conv-1',
  contactId: 'contact-1',
  configOwnerUserId: 'user-1',
}

function aiConfig(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    provider: 'openai',
    model: 'gpt-test',
    apiKey: 'sk-test',
    systemPrompt: null,
    isActive: true,
    autoReplyEnabled: true,
    autoReplyMaxPerConversation: 3,
    autoReplyResetMinutes: 360,
    embeddingsApiKey: null,
    ...overrides,
  }
}

/** No knowledge base configured at all — the common case. */
const NO_KB = { excerpts: [], hasKnowledgeBase: false, degraded: false }

beforeEach(() => {
  h.state.conv = {
    assigned_agent_id: null,
    ai_autoreply_disabled: false,
    ai_reply_count: 0,
    ai_window_started_at: null,
  }
  h.state.autoResponders = []
  h.state.claim = true
  h.state.handoffClaim = true
  h.state.updatePayload = null
  h.state.rpcCalls = []
  h.state.existingBooking = null
  h.loadAiConfig.mockResolvedValue(aiConfig())
  h.buildConversationContext.mockResolvedValue([{ role: 'user', content: 'hi' }])
  h.retrieveKnowledge.mockResolvedValue(NO_KB)
  h.hasUnreadableCustomerBurst.mockResolvedValue(false)
  h.generateReply.mockResolvedValue({ text: 'Hello!', handoff: false })
  h.engineSendText.mockResolvedValue({ whatsapp_message_id: 'm1' })
  // No calendar connected — the common case, and the default everywhere
  // else in this file.
  h.loadCalendarConfig.mockResolvedValue(null)
  h.loadConfirmationTemplate.mockResolvedValue(
    'Listo, agendé la llamada para el {datetime}. Te envié la invitación a {email}.',
  )
  h.freeSlots.mockResolvedValue([])
  h.bookMeeting.mockResolvedValue({ status: 'failed', error: new Error('unstubbed') })
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('dispatchInboundToAiReply — eligibility gates', () => {
  it('claims a slot and sends on the happy path', async () => {
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.rpcCalls).toEqual([
      {
        name: 'claim_ai_reply_slot',
        args: {
          conversation_id: 'conv-1',
          max_replies: 3,
          reset_minutes: 360,
        },
      },
    ])
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1', text: 'Hello!' }),
    )
  })

  it('passes the account\'s configured reset window to the claim', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ autoReplyResetMinutes: 120 }))
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.rpcCalls[0].args).toMatchObject({ reset_minutes: 120 })
  })

  it('grounds the reply in retrieved knowledge', async () => {
    h.retrieveKnowledge.mockResolvedValue({
      excerpts: ['Returns accepted within 30 days.'],
      hasKnowledgeBase: true,
      degraded: false,
    })
    await dispatchInboundToAiReply(ARGS)
    expect(h.retrieveKnowledge).toHaveBeenCalled()
    const systemPrompt = h.generateReply.mock.calls[0][0].systemPrompt as string
    expect(systemPrompt).toContain('Returns accepted within 30 days.')
  })

  it('queries retrieval with a widened semantic query and a narrow lexical one', async () => {
    h.buildConversationContext.mockResolvedValue([
      { role: 'user', content: 'quiero un CRM' },
      { role: 'assistant', content: 'genial' },
      { role: 'user', content: '¿y cuánto sale?' },
    ])
    await dispatchInboundToAiReply(ARGS)
    expect(h.retrieveKnowledge).toHaveBeenCalledWith(
      expect.anything(),
      'acct-1',
      expect.anything(),
      { semantic: 'quiero un CRM\n¿y cuánto sale?', lexical: '¿y cuánto sale?' },
    )
  })

  it('stands down when an active message-level automation exists', async () => {
    h.state.autoResponders = [{ id: 'auto-1' }]
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('does not send when the atomic slot claim loses the race', async () => {
    h.state.claim = false
    await dispatchInboundToAiReply(ARGS)
    // It still attempts the claim, but the send is skipped.
    expect(h.state.rpcCalls).toHaveLength(1)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when AI is off / not configured', async () => {
    h.loadAiConfig.mockResolvedValue(null)
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when auto-reply is disabled for the account', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ autoReplyEnabled: false }))
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when a human agent is assigned', async () => {
    h.state.conv = {
      assigned_agent_id: 'agent-9',
      ai_autoreply_disabled: false,
      ai_reply_count: 0,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when auto-reply was disabled on this conversation', async () => {
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: true,
      ai_reply_count: 0,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when the cap is reached inside an open window', async () => {
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: false,
      ai_reply_count: 3,
      ai_window_started_at: new Date(Date.now() - 60 * 60_000).toISOString(), // 1h ago
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
    // Bailed before paying for a completion or reaching the claim.
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.state.rpcCalls).toEqual([])
  })

  it('answers a capped thread once its reset window has elapsed', async () => {
    // The cap bounds one exchange, not a customer's lifetime. Someone who
    // comes back the next morning must not meet a bot that used up its
    // budget yesterday. Window opened 7h ago, reset is 6h → expired.
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: false,
      ai_reply_count: 3,
      ai_window_started_at: new Date(Date.now() - 7 * 60 * 60_000).toISOString(),
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Hello!' }),
    )
    // The claim RPC (not the engine) resets the counter atomically.
    expect(h.state.rpcCalls.map((c) => c.name)).toEqual(['claim_ai_reply_slot'])
  })

  it('honours a per-account window: the same age is capped at 6h, open at 12h', async () => {
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: false,
      ai_reply_count: 3,
      ai_window_started_at: new Date(Date.now() - 8 * 60 * 60_000).toISOString(), // 8h ago
    }
    // Default 6h window: 8h-old window has expired → answers.
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).toHaveBeenCalled()

    // A 12h window on the same thread has not expired → stays quiet.
    h.generateReply.mockClear()
    h.loadAiConfig.mockResolvedValue(aiConfig({ autoReplyResetMinutes: 720 }))
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
  })

  it('skips when there is nothing to reply to', async () => {
    h.buildConversationContext.mockResolvedValue([])
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })
})

describe('dispatchInboundToAiReply — handoff', () => {
  it('disables auto-reply and does not send on handoff', async () => {
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.state.updatePayload).toEqual({ ai_autoreply_disabled: true })
    expect(h.state.rpcCalls).toHaveLength(0)
  })

  it('hands off without generating when the burst contains unreadable media', async () => {
    h.hasUnreadableCustomerBurst.mockResolvedValue(true)
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.state.updatePayload).toEqual({ ai_autoreply_disabled: true })
  })

  it('skips the reply without generating when retrieval is degraded', async () => {
    h.retrieveKnowledge.mockResolvedValue({
      excerpts: [],
      hasKnowledgeBase: true,
      degraded: true,
    })
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
    // Transient infra failure — must NOT be sticky.
    expect(h.state.updatePayload).toBeNull()
  })

  it('skips without disabling when the media lookup itself fails', async () => {
    h.hasUnreadableCustomerBurst.mockRejectedValue(new Error('db down'))
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.state.updatePayload).toBeNull()
  })
})

describe('dispatchInboundToAiReply — handoff notice', () => {
  const NOTICE = 'Dejame consultarlo con el equipo y te responden en un rato.'

  it('is silent by default, preserving the historical behaviour', async () => {
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('tells the customer when AI_HANDOFF_MESSAGE is set', async () => {
    vi.stubEnv('AI_HANDOFF_MESSAGE', NOTICE)
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1', text: NOTICE }),
    )
    expect(h.state.updatePayload).toEqual({ ai_autoreply_disabled: true })
  })

  it('does not spend a reply-cap slot on the notice', async () => {
    vi.stubEnv('AI_HANDOFF_MESSAGE', NOTICE)
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.rpcCalls).toHaveLength(0)
  })

  it('sends nothing when another inbound already claimed the handoff', async () => {
    vi.stubEnv('AI_HANDOFF_MESSAGE', NOTICE)
    h.state.handoffClaim = false // the conditional UPDATE matched no row
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('also notices on the media and monetary handoffs', async () => {
    vi.stubEnv('AI_HANDOFF_MESSAGE', NOTICE)
    h.hasUnreadableCustomerBurst.mockResolvedValue(true)
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: NOTICE }),
    )

    h.engineSendText.mockClear()
    h.hasUnreadableCustomerBurst.mockResolvedValue(false)
    vi.stubEnv('AI_BLOCK_MONETARY_REPLIES', 'true')
    h.generateReply.mockResolvedValue({ text: 'Sale $80.000.', handoff: false })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: NOTICE }),
    )
  })

  it('keeps the thread disabled when the notice fails to send', async () => {
    vi.stubEnv('AI_HANDOFF_MESSAGE', NOTICE)
    h.engineSendText.mockRejectedValue(new Error('meta 500'))
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.updatePayload).toEqual({ ai_autoreply_disabled: true })
  })

  it('sends no notice on a degraded-retrieval skip (not a handoff)', async () => {
    vi.stubEnv('AI_HANDOFF_MESSAGE', NOTICE)
    h.retrieveKnowledge.mockResolvedValue({
      excerpts: [],
      hasKnowledgeBase: true,
      degraded: true,
    })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.state.updatePayload).toBeNull()
  })
})

describe('dispatchInboundToAiReply — knowledge grounding', () => {
  it('tells the model when a KB exists but nothing matched', async () => {
    h.retrieveKnowledge.mockResolvedValue({
      excerpts: [],
      hasKnowledgeBase: true,
      degraded: false,
    })
    await dispatchInboundToAiReply(ARGS)
    const systemPrompt = h.generateReply.mock.calls[0][0].systemPrompt as string
    expect(systemPrompt).toContain('no excerpt matched this question')
    // A greeting must still get a reply — the instruction is scoped to
    // business questions, not enforced as a blanket handoff.
    expect(h.engineSendText).toHaveBeenCalled()
  })

  it('says nothing about a knowledge base when the account has none', async () => {
    await dispatchInboundToAiReply(ARGS)
    const systemPrompt = h.generateReply.mock.calls[0][0].systemPrompt as string
    expect(systemPrompt).not.toContain('no excerpt matched this question')
  })
})

describe('dispatchInboundToAiReply — monetary output guard', () => {
  it('hands off instead of sending a reply that quotes a price', async () => {
    vi.stubEnv('AI_BLOCK_MONETARY_REPLIES', 'true')
    h.generateReply.mockResolvedValue({
      text: 'El CRM sale $80.000 más IVA.',
      handoff: false,
    })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.state.updatePayload).toEqual({ ai_autoreply_disabled: true })
    // The guard fires before the slot is consumed.
    expect(h.state.rpcCalls).toHaveLength(0)
  })

  it('still sends a price-free reply when the guard is on', async () => {
    vi.stubEnv('AI_BLOCK_MONETARY_REPLIES', 'true')
    h.generateReply.mockResolvedValue({
      text: 'Se cotiza a medida. ¿Coordinamos una llamada?',
      handoff: false,
    })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).toHaveBeenCalled()
  })

  it('sends prices normally when the guard is off', async () => {
    h.generateReply.mockResolvedValue({
      text: 'El envío cuesta $3.500.',
      handoff: false,
    })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).toHaveBeenCalled()
  })
})

// ============================================================
// Scheduling.
//
// The transcript that prompted this feature: the customer offered
// "de lunes a viernes de 9 a 17hs", the agent kept asking for a narrower
// time, and then promised to send a calendar invitation that no code
// path could ever send. Both halves are tested here.
// ============================================================

const BA = 'America/Argentina/Buenos_Aires'
const MONDAY_10 = new Date(Date.UTC(2026, 6, 13, 13, 0)) // 10:00 in BA

function calendarConfig(overrides: Partial<CalendarConfig> = {}): CalendarConfig {
  return {
    provider: 'google',
    refreshToken: 'refresh-token',
    calendarId: 'primary',
    connectedEmail: 'santi@allnisa.com',
    timezone: BA,
    slotMinutes: 30,
    bufferMinutes: 15,
    minNoticeMinutes: 120,
    maxDaysAhead: 14,
    offerSlots: 3,
    workingHours: DEFAULT_WORKING_HOURS,
    bookingEnabled: true,
    ...overrides,
  }
}

const SLOTS = [
  { start: MONDAY_10, end: new Date(MONDAY_10.getTime() + 30 * 60_000) },
  {
    start: new Date(MONDAY_10.getTime() + 4 * 3_600_000),
    end: new Date(MONDAY_10.getTime() + 4 * 3_600_000 + 30 * 60_000),
  },
]

const MARKER = '[[BOOK|2026-07-13T10:00:00-03:00|juan@example.com]]'

/** The system prompt handed to the model on the last generate call. */
const lastPrompt = (): string =>
  h.generateReply.mock.calls.at(-1)![0].systemPrompt as string

describe('dispatchInboundToAiReply — the scheduling prompt', () => {
  it('always dates the conversation, so "el lunes" is resolvable', async () => {
    await dispatchInboundToAiReply(ARGS)
    expect(lastPrompt()).toContain('Current date and time:')
  })

  it('forbids promising an invitation when no calendar is connected', async () => {
    await dispatchInboundToAiReply(ARGS)
    expect(lastPrompt()).toContain('you have no access to a calendar')
  })

  it('offers real slots when a calendar is connected', async () => {
    h.loadCalendarConfig.mockResolvedValue(calendarConfig())
    h.freeSlots.mockResolvedValue(SLOTS)
    await dispatchInboundToAiReply(ARGS)
    expect(lastPrompt()).toContain('lunes 13 de julio a las 10:00 → 2026-07-13T10:00:00-03:00')
  })

  it('says the calendar is full rather than absent when nothing is free', async () => {
    h.loadCalendarConfig.mockResolvedValue(calendarConfig())
    h.freeSlots.mockResolvedValue([])
    await dispatchInboundToAiReply(ARGS)
    expect(lastPrompt()).toContain('no free slots in the bookable window')
  })

  it('reads the clock in the calendar timezone even when booking is off', async () => {
    h.loadCalendarConfig.mockResolvedValue(calendarConfig({ bookingEnabled: false }))
    await dispatchInboundToAiReply(ARGS)
    expect(lastPrompt()).toContain(BA)
    expect(lastPrompt()).toContain('you have no access to a calendar')
    expect(h.freeSlots).not.toHaveBeenCalled()
  })

  it('stops offering meetings once the thread has booked one', async () => {
    h.loadCalendarConfig.mockResolvedValue(calendarConfig())
    h.state.existingBooking = { id: 'booking-1' }
    await dispatchInboundToAiReply(ARGS)
    expect(h.freeSlots).not.toHaveBeenCalled()
    expect(lastPrompt()).toContain('you have no access to a calendar')
  })

  it('does not schedule when the calendar cannot be read', async () => {
    h.loadCalendarConfig.mockResolvedValue(calendarConfig())
    h.freeSlots.mockRejectedValue(new Error('google is down'))
    await dispatchInboundToAiReply(ARGS)
    // Degrades to "no calendar" and still answers the customer's question.
    expect(lastPrompt()).toContain('you have no access to a calendar')
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Hello!' }),
    )
  })
})

describe('dispatchInboundToAiReply — executing a booking', () => {
  beforeEach(() => {
    h.loadCalendarConfig.mockResolvedValue(calendarConfig())
    h.freeSlots.mockResolvedValue(SLOTS)
    h.generateReply.mockResolvedValue({ text: MARKER, handoff: false })
  })

  it('books, then confirms with the time it actually wrote', async () => {
    h.bookMeeting.mockResolvedValue({
      status: 'booked',
      slot: SLOTS[0],
      result: { eventId: 'evt-1', meetUrl: 'https://meet.google.com/abc' },
    })
    await dispatchInboundToAiReply(ARGS)

    expect(h.bookMeeting).toHaveBeenCalledWith(
      expect.objectContaining({
        instant: MONDAY_10,
        attendeeEmail: 'juan@example.com',
        contactName: 'Juan Pérez',
      }),
    )
    // Composed by code from the booked instant — never by the model, and
    // never containing the raw marker.
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({
        text:
          'Listo, agendé la llamada para el lunes 13 de julio a las 10:00. ' +
          'Te envié la invitación a juan@example.com.\nhttps://meet.google.com/abc',
      }),
    )
    // A confirmation is not a reply: it must not spend a cap slot.
    expect(h.state.rpcCalls).toEqual([])
  })

  it('never lets the raw marker reach the customer', async () => {
    h.bookMeeting.mockResolvedValue({
      status: 'booked',
      slot: SLOTS[0],
      result: { eventId: 'evt-1', meetUrl: null },
    })
    await dispatchInboundToAiReply(ARGS)
    const sent = h.engineSendText.mock.calls.at(-1)![0].text as string
    expect(sent).not.toContain('[[BOOK')
  })

  it('hands off when the model invents a booking with no calendar', async () => {
    h.loadCalendarConfig.mockResolvedValue(null)
    await dispatchInboundToAiReply(ARGS)
    expect(h.bookMeeting).not.toHaveBeenCalled()
    expect(h.state.updatePayload).toEqual({ ai_autoreply_disabled: true })
  })

  it('hands off on a malformed marker instead of guessing', async () => {
    h.generateReply.mockResolvedValue({
      text: '[[BOOK|el lunes a las 10|juan@example.com]]',
      handoff: false,
    })
    await dispatchInboundToAiReply(ARGS)
    expect(h.bookMeeting).not.toHaveBeenCalled()
    expect(h.state.updatePayload).toEqual({ ai_autoreply_disabled: true })
  })

  it('hands off when the slot is gone, rather than booking something else', async () => {
    h.bookMeeting.mockResolvedValue({ status: 'unavailable' })
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.updatePayload).toEqual({ ai_autoreply_disabled: true })
    expect(h.engineSendText).not.toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('agendé') }),
    )
  })

  it('hands off when another conversation claimed the slot', async () => {
    h.bookMeeting.mockResolvedValue({ status: 'already_claimed' })
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.updatePayload).toEqual({ ai_autoreply_disabled: true })
  })

  it('hands off when Google refuses', async () => {
    h.bookMeeting.mockResolvedValue({ status: 'failed', error: new Error('403') })
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.updatePayload).toEqual({ ai_autoreply_disabled: true })
  })

  it('prefers a handoff over a booking when the model asks for both', async () => {
    h.generateReply.mockResolvedValue({ text: MARKER, handoff: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.bookMeeting).not.toHaveBeenCalled()
    expect(h.state.updatePayload).toEqual({ ai_autoreply_disabled: true })
  })
})
