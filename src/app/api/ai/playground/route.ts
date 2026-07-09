import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { looksLikeBooking, parseBooking } from '@/lib/ai/booking'
import { loadAiConfig } from '@/lib/ai/config'
import { containsMonetaryAmount } from '@/lib/ai/guards'
import { retrieveKnowledge } from '@/lib/ai/knowledge'
import { generateReply } from '@/lib/ai/generate'
import {
  aiBlockMonetaryReplies,
  aiDefaultTimezone,
  buildSystemPrompt,
  type BookingContext,
} from '@/lib/ai/defaults'
import { latestUserMessage, recentUserMessages } from '@/lib/ai/query'
import { freeSlots, suggestedSlots } from '@/lib/calendar/availability'
import { confirmationMessage } from '@/lib/calendar/book'
import { loadCalendarConfig, loadConfirmationTemplate } from '@/lib/calendar/config'
import { isBookable } from '@/lib/calendar/slots'
import type { CalendarConfig, Slot } from '@/lib/calendar/types'
import { AiError, type ChatMessage } from '@/lib/ai/types'

// Keep the tested transcript bounded, mirroring the live context window.
const MAX_TURNS = 20

interface PlaygroundBooking {
  config: CalendarConfig
  context: BookingContext
  slots: Slot[]
}

/**
 * Read the account's real availability, without ever writing to it.
 *
 * The Playground has to show real slots or it tests nothing: the whole
 * failure mode we are guarding against is an agent that invents times.
 * Reading free/busy is idempotent and side-effect free, so this is safe;
 * `POST` to the calendar is what the Playground must never do, and this
 * route simply never calls it.
 */
async function loadBooking(
  db: SupabaseClient,
  accountId: string,
): Promise<PlaygroundBooking | null> {
  const config = await loadCalendarConfig(db, accountId)
  if (!config || !config.bookingEnabled) return null
  try {
    const slots = await freeSlots(config, new Date())
    return {
      config,
      slots,
      context: {
        suggested: suggestedSlots(slots, config),
        more: slots.length > config.offerSlots,
      },
    }
  } catch (err) {
    console.error('[ai/playground] could not read calendar availability:', err)
    return null
  }
}

/**
 * POST /api/ai/playground  (agent+)
 *
 * Test-chat with the account's agent WITHOUT touching WhatsApp. Runs the
 * exact same path the auto-reply bot uses — knowledge-base retrieval +
 * `auto_reply` system prompt + the configured provider — so what you see
 * here is what a real customer would get. Reads the config even when the
 * master switch is off (requireActive:false) so you can try it before
 * going live. Stateless: the client sends the running transcript each turn.
 *
 * Scheduling is exercised for real up to, but not including, the write:
 * the agent is shown the account's actual free slots and its booking
 * marker is parsed and validated against them, but no calendar event is
 * created and no invitation is sent. A successful dry run answers with
 * `{ booked: true }` and the confirmation the customer would have read.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')

    const limit = checkRateLimit(`ai-playground:${userId}`, RATE_LIMITS.aiDraft)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    const rawMessages = Array.isArray(body?.messages) ? body.messages : null
    if (!rawMessages) {
      return NextResponse.json({ error: 'messages is required' }, { status: 400 })
    }

    const messages: ChatMessage[] = rawMessages
      .filter(
        (m: unknown): m is ChatMessage =>
          !!m &&
          typeof m === 'object' &&
          ((m as ChatMessage).role === 'user' ||
            (m as ChatMessage).role === 'assistant') &&
          typeof (m as ChatMessage).content === 'string' &&
          (m as ChatMessage).content.trim().length > 0,
      )
      .slice(-MAX_TURNS)

    if (messages.length === 0) {
      return NextResponse.json(
        { error: 'Send a message to test the agent.' },
        { status: 400 },
      )
    }

    const config = await loadAiConfig(supabase, accountId, {
      requireActive: false,
    }).catch((err) => {
      console.error('[ai/playground] loadAiConfig error:', err)
      throw new AiError('Stored API key could not be decrypted.', {
        code: 'key_decrypt_failed',
        status: 400,
      })
    })
    if (!config) {
      return NextResponse.json(
        {
          error: 'No agent configured yet. Add your provider key in Setup.',
          code: 'ai_not_configured',
        },
        { status: 400 },
      )
    }

    const knowledge = await retrieveKnowledge(supabase, accountId, config, {
      semantic: recentUserMessages(messages),
      lexical: latestUserMessage(messages),
    })
    const booking = await loadBooking(supabase, accountId)
    const systemPrompt = buildSystemPrompt({
      userPrompt: config.systemPrompt,
      mode: 'auto_reply',
      now: new Date(),
      timezone: booking?.config.timezone ?? aiDefaultTimezone(),
      knowledge: knowledge.excerpts,
      knowledgeMissing:
        knowledge.hasKnowledgeBase && knowledge.excerpts.length === 0,
      booking: booking?.context ?? null,
    })

    const { text, handoff } = await generateReply({ config, systemPrompt, messages })
    if (handoff || !text) return NextResponse.json({ reply: text, handoff })

    // The agent asked to book. Run every check the live bot runs — parse
    // the marker, verify the instant is a real free slot — then stop short
    // of the calendar and show what the customer *would* have received.
    // `booked: true` marks a dry run: nothing was written.
    if (looksLikeBooking(text)) {
      const request = booking ? parseBooking(text) : null
      if (!booking || !request || !isBookable(request.instant, booking.slots)) {
        return NextResponse.json({ reply: '', handoff: true })
      }
      const template = await loadConfirmationTemplate(supabase, accountId)
      return NextResponse.json({
        booked: true,
        handoff: false,
        reply: template
          ? confirmationMessage({
              template,
              start: request.instant,
              timezone: booking.config.timezone,
              email: request.email,
              meetUrl: null,
            })
          : '',
      })
    }

    // The live bot discards a reply that quotes money and hands off. Mirror
    // that here, or the Playground would show the admin an answer their
    // customers can never receive.
    if (aiBlockMonetaryReplies() && containsMonetaryAmount(text)) {
      return NextResponse.json({ reply: '', handoff: true })
    }
    return NextResponse.json({ reply: text, handoff })
  } catch (err) {
    if (err instanceof AiError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status },
      )
    }
    return toErrorResponse(err)
  }
}
