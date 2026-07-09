import type { SupabaseClient } from '@supabase/supabase-js'
import { supabaseAdmin } from './admin-client'
import { looksLikeBooking, parseBooking } from './booking'
import { loadAiConfig } from './config'
import { buildConversationContext } from './context'
import { containsMonetaryAmount } from './guards'
import { retrieveKnowledge } from './knowledge'
import { hasUnreadableCustomerBurst } from './media'
import { generateReply } from './generate'
import {
  aiBlockMonetaryReplies,
  aiDefaultTimezone,
  aiHandoffMessage,
  buildSystemPrompt,
  type BookingContext,
} from './defaults'
import { latestUserMessage, recentUserMessages } from './query'
import { freeSlots, suggestedSlots } from '@/lib/calendar/availability'
import { bookMeeting, confirmationMessage } from '@/lib/calendar/book'
import { loadCalendarConfig, loadConfirmationTemplate } from '@/lib/calendar/config'
import type { CalendarConfig } from '@/lib/calendar/types'
import { engineSendText } from '@/lib/flows/meta-send'

interface DispatchArgs {
  /** Tenancy key — drives config, contact, and whatsapp_config lookups. */
  accountId: string
  conversationId: string
  contactId: string
  /** The account's WhatsApp config owner, used for the outbound send's
   *  audit columns (mirrors how the flow runner passes it through). */
  configOwnerUserId: string
}

/**
 * Stop auto-replying on this thread so the inbound surfaces in the inbox
 * for a human. Sticky until an admin re-enables.
 *
 * When `AI_HANDOFF_MESSAGE` is set, the customer is told before the thread
 * goes quiet. Without it a handoff is silent, and from the customer's side
 * indistinguishable from being ignored — if the team takes twenty minutes
 * to look at the inbox, that lead is gone.
 *
 * The flag flip doubles as the lock: only the caller that moves
 * `ai_autoreply_disabled` false → true sends the notice, so two inbounds
 * landing together can't both message the customer. The claim happens
 * before the send, so a failed send leaves the thread disabled and quiet
 * rather than risking a duplicate — under-notify, never double-notify.
 *
 * The notice deliberately does NOT consume a `claim_ai_reply_slot` cap
 * slot: it can only ever be sent once (the thread is disabled by the same
 * UPDATE that authorises it), so it can't loop, and it shouldn't spend a
 * reply the human may still want.
 */
async function handOffToHuman(
  db: SupabaseClient,
  args: DispatchArgs,
  reason: string,
): Promise<void> {
  const { accountId, conversationId, contactId, configOwnerUserId } = args

  const { data: claimed, error } = await db
    .from('conversations')
    .update({ ai_autoreply_disabled: true })
    .eq('id', conversationId)
    .eq('ai_autoreply_disabled', false)
    .select('id')
    .maybeSingle()

  if (error) {
    console.error('[ai auto-reply] failed to disable auto-reply:', error)
    return
  }
  console.info(`[ai auto-reply] handing off ${conversationId}: ${reason}`)
  if (!claimed) return // another inbound already handed this thread off

  const message = aiHandoffMessage()
  if (!message) return

  try {
    await engineSendText({
      accountId,
      userId: configOwnerUserId,
      conversationId,
      contactId,
      text: message,
    })
  } catch (err) {
    // The thread is already disabled — the handoff itself succeeded. Losing
    // the courtesy notice is a worse customer experience, not a correctness
    // bug, so log and move on.
    console.error('[ai auto-reply] handoff notice failed to send:', err)
  }
}

interface BookingState {
  /** Non-null only when the agent may actually write to the calendar. */
  calendar: CalendarConfig | null
  /** What the prompt is told about scheduling. See `BookingContext`. */
  context: BookingContext | null
  /** The zone the agent reads the clock in — from the calendar when one
   *  is configured at all, even if booking is switched off. */
  timezone: string
}

const NO_BOOKING = (timezone: string): BookingState => ({
  calendar: null,
  context: null,
  timezone,
})

/**
 * Decide what the agent may say about scheduling on this turn.
 *
 * Every failure collapses to "no calendar", which the prompt turns into
 * "I cannot book; a human will arrange it" plus a handoff. That is the
 * only safe direction: an agent that cannot see the diary must not offer
 * a time, and one that cannot write to it must not promise an invitation.
 *
 * A conversation that has already booked gets `null` too. The unique
 * index on `ai_bookings.conversation_id` would refuse a second event
 * anyway; telling the model up front means it says something sensible
 * instead of emitting a marker we then have to reject.
 */
async function resolveBooking(
  db: SupabaseClient,
  accountId: string,
  conversationId: string,
): Promise<BookingState> {
  const calendar = await loadCalendarConfig(db, accountId)
  if (!calendar) return NO_BOOKING(aiDefaultTimezone())
  // Past this point the account has a calendar, so its timezone is the
  // right one to date the conversation in even when booking is off.
  if (!calendar.bookingEnabled) return NO_BOOKING(calendar.timezone)

  const { data: existing, error } = await db
    .from('ai_bookings')
    .select('id')
    .eq('conversation_id', conversationId)
    .maybeSingle()
  if (error) {
    console.error('[ai auto-reply] could not check for an existing booking:', error)
    return NO_BOOKING(calendar.timezone)
  }
  if (existing) return NO_BOOKING(calendar.timezone)

  try {
    const slots = await freeSlots(calendar, new Date())
    return {
      calendar,
      context: {
        suggested: suggestedSlots(slots, calendar),
        more: slots.length > calendar.offerSlots,
      },
      timezone: calendar.timezone,
    }
  } catch (err) {
    // Google is down, the token was revoked, the calendar was deleted.
    // Transient or not, we cannot see availability, so we do not schedule.
    console.error('[ai auto-reply] could not read calendar availability:', err)
    return NO_BOOKING(calendar.timezone)
  }
}

/**
 * Execute a booking marker the model emitted, and tell the customer.
 *
 * Returns true when the turn is finished — either the meeting exists and
 * the customer has been told, or the thread has been handed off. The
 * caller sends nothing further either way: the model was instructed to
 * emit the marker *alone*, so there is no reply text worth salvaging.
 *
 * The confirmation deliberately does not consume a `claim_ai_reply_slot`
 * cap slot, for the same reason the handoff notice does not: it can be
 * sent at most once per thread (the unique index on `conversation_id`
 * guarantees it), so it cannot loop, and a customer who has just been
 * booked should not be met with silence because the cap ran out.
 */
async function executeBooking(
  db: SupabaseClient,
  args: DispatchArgs,
  booking: BookingState,
  text: string,
): Promise<void> {
  const { accountId, conversationId, contactId, configOwnerUserId } = args

  if (!booking.calendar) {
    // The model invented the capability. The prompt told it not to.
    await handOffToHuman(db, args, 'booking marker emitted with no bookable calendar')
    return
  }

  const request = parseBooking(text)
  if (!request) {
    await handOffToHuman(db, args, 'malformed booking marker')
    return
  }

  const { data: contact } = await db
    .from('contacts')
    .select('name')
    .eq('id', contactId)
    .maybeSingle()

  const outcome = await bookMeeting({
    db,
    config: booking.calendar,
    accountId,
    conversationId,
    contactId,
    instant: request.instant,
    attendeeEmail: request.email,
    contactName: (contact as { name: string | null } | null)?.name,
  })

  if (outcome.status !== 'booked') {
    const reason =
      outcome.status === 'unavailable'
        ? `slot ${request.iso} is not bookable (taken, or never offered)`
        : outcome.status === 'already_claimed'
          ? `slot ${request.iso} was claimed by another conversation`
          : `booking failed: ${String(outcome.error)}`
    await handOffToHuman(db, args, reason)
    return
  }

  const template = await loadConfirmationTemplate(db, accountId)
  if (!template) {
    // The event exists. Staying silent now would be the worst outcome of
    // all, so hand off — a human will see the thread and the calendar.
    await handOffToHuman(db, args, 'booked, but no confirmation template configured')
    return
  }

  const message = confirmationMessage({
    template,
    start: outcome.slot.start,
    timezone: booking.calendar.timezone,
    email: request.email,
    meetUrl: outcome.result.meetUrl,
  })

  try {
    await engineSendText({
      accountId,
      userId: configOwnerUserId,
      conversationId,
      contactId,
      text: message,
    })
    console.info(
      `[ai auto-reply] booked ${outcome.result.eventId} for ${conversationId} at ${request.iso}`,
    )
  } catch (err) {
    // The meeting is real and the customer has Google's invitation email;
    // only our WhatsApp confirmation was lost. Hand off rather than retry,
    // so a human closes the loop instead of a second event being created.
    console.error('[ai auto-reply] booked but the confirmation failed to send:', err)
    await handOffToHuman(db, args, 'booked, but the WhatsApp confirmation failed to send')
  }
}

/**
 * AI auto-reply for a freshly-arrived inbound message.
 *
 * Invoked from the WhatsApp webhook's `after()` block, only when no
 * deterministic flow consumed the message (flows win). Mirrors the flow
 * runner's contract: it owns its try/catch and NEVER throws — a failing
 * or slow LLM call must not affect the webhook's 200 to Meta.
 *
 * Eligibility gates (any → silent no-op):
 *   - AI off / auto-reply disabled for the account
 *   - a human agent is assigned (they own the thread)
 *   - auto-reply was disabled for this conversation (prior handoff)
 *   - the per-conversation reply cap is reached
 *   - there's nothing to reply to
 *
 * Safety gates that hand off instead (sticky — a human must look):
 *   - the customer's unanswered burst contains media the model can't read
 *   - the model asked to hand off, or produced nothing
 *   - the reply quotes money and the account forbids that
 *   - the model tried to book a meeting it could not, or would not, book
 *
 * And one that skips without disabling, because it's an outage rather
 * than a decision: knowledge retrieval broke, so we cannot tell whether
 * the reply would be grounded.
 *
 * The 24h WhatsApp session window is inherently open here — we're
 * reacting to a customer message that just landed — so no separate
 * window check is needed.
 */
export async function dispatchInboundToAiReply(
  args: DispatchArgs,
): Promise<void> {
  const { accountId, conversationId, contactId, configOwnerUserId } = args

  try {
    const db = supabaseAdmin()

    const config = await loadAiConfig(db, accountId)
    if (!config || !config.autoReplyEnabled) return

    // Deterministic, user-configured responders win over the LLM — the
    // caller already excludes messages a Flow consumed. Message-level
    // automations (`new_message_received` / `keyword_match`) are
    // dispatched independently for this same inbound and may send their
    // own reply, so if the account has any active one we stand down to
    // avoid double-texting the customer. (Relationship triggers like
    // `first_inbound_message` don't count — they're not per-message
    // auto-responders.)
    const { data: autoResponders } = await db
      .from('automations')
      .select('id')
      .eq('account_id', accountId)
      .eq('is_active', true)
      .in('trigger_type', ['new_message_received', 'keyword_match'])
      .limit(1)
    if (autoResponders && autoResponders.length > 0) return

    const { data: conv, error: convErr } = await db
      .from('conversations')
      .select('assigned_agent_id, ai_autoreply_disabled, ai_reply_count')
      .eq('id', conversationId)
      .maybeSingle()
    if (convErr || !conv) return
    if (conv.assigned_agent_id) return // a human owns this thread
    if (conv.ai_autoreply_disabled) return // handed off / turned off here
    // Cheap early-out; the authoritative cap check is the atomic claim
    // below (this read can race a concurrent inbound).
    if (conv.ai_reply_count >= config.autoReplyMaxPerConversation) return

    const messages = await buildConversationContext(db, conversationId)
    if (messages.length === 0) return

    // The model is text-only. If the customer's unanswered burst carries
    // an image / audio / document, the transcript we just built has a
    // hole in it and any confident answer is a guess.
    if (await hasUnreadableCustomerBurst(db, conversationId)) {
      await handOffToHuman(db, args, 'unreadable media in burst')
      return
    }

    // Ground the reply in the account's knowledge base.
    const knowledge = await retrieveKnowledge(db, accountId, config, {
      semantic: recentUserMessages(messages),
      lexical: latestUserMessage(messages),
    })

    // Retrieval broke (embeddings timeout, RPC error). We don't know what
    // the KB would have said, so an unsupervised reply here is exactly the
    // ungrounded guess we're trying to prevent. Skip without disabling —
    // this is transient, and the next inbound deserves a fresh try.
    if (knowledge.degraded) {
      console.error(
        `[ai auto-reply] knowledge retrieval degraded for conversation ${conversationId}; declining to answer ungrounded.`,
      )
      return
    }

    // What the agent may say about scheduling, and which clock it reads.
    const booking = await resolveBooking(db, accountId, conversationId)

    const systemPrompt = buildSystemPrompt({
      userPrompt: config.systemPrompt,
      mode: 'auto_reply',
      now: new Date(),
      timezone: booking.timezone,
      knowledge: knowledge.excerpts,
      // A KB exists but nothing matched: tell the model it's flying blind
      // so it hands off on business questions instead of improvising.
      knowledgeMissing:
        knowledge.hasKnowledgeBase && knowledge.excerpts.length === 0,
      booking: booking.context,
    })

    const { text, handoff } = await generateReply({
      config,
      systemPrompt,
      messages,
    })

    if (handoff || !text) {
      // The model can't (or shouldn't) answer. Checked before the booking
      // marker: a reply carrying both is a model contradicting itself, and
      // the cautious reading wins.
      await handOffToHuman(db, args, 'model requested handoff')
      return
    }

    // The model asked to book. `executeBooking` owns the rest of the turn,
    // including the customer-facing confirmation — which is composed from
    // the instant we wrote to the calendar, never from `text`.
    if (looksLikeBooking(text)) {
      await executeBooking(db, args, booking, text)
      return
    }

    // Hard policy check on the generated text. The prompt already asks the
    // model not to quote prices; this is what makes it true.
    if (aiBlockMonetaryReplies() && containsMonetaryAmount(text)) {
      await handOffToHuman(db, args, 'reply quoted a monetary amount')
      return
    }

    // Atomically claim a reply slot: the cap check + increment happen in
    // one UPDATE, so concurrent inbounds can never overshoot the cap. If
    // another inbound just took the last slot, `claimed` is false and we
    // skip the send. (We consume a slot slightly before the send lands —
    // fail-safe: under-reply rather than over-reply.)
    const { data: claimed, error: claimErr } = await db.rpc(
      'claim_ai_reply_slot',
      {
        conversation_id: conversationId,
        max_replies: config.autoReplyMaxPerConversation,
      },
    )
    if (claimErr) {
      // A real error here (vs. losing the cap race) is almost always a
      // deploy issue — e.g. `claim_ai_reply_slot` not EXECUTE-able by the
      // service role, or the migration not applied. Log it loudly: a
      // silent return makes "auto-reply never fires" undiagnosable.
      console.error('[ai auto-reply] claim_ai_reply_slot failed:', claimErr)
      return
    }
    if (claimed !== true) return // lost the per-conversation cap race

    await engineSendText({
      accountId,
      userId: configOwnerUserId,
      conversationId,
      contactId,
      text,
    })
  } catch (err) {
    console.error('[ai auto-reply] dispatch failed:', err)
  }
}
