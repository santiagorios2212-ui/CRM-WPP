import type { SupabaseClient } from '@supabase/supabase-js'

// ============================================================
// "Can the model actually see what the customer sent?"
// ============================================================

/**
 * How far back to look for the customer's current, still-unanswered
 * burst. A burst is bounded by the previous agent/bot message, so this
 * is only a safety stop for a customer who fired off a long monologue.
 */
const BURST_LOOKBACK = 15

interface BurstRow {
  sender_type: 'customer' | 'agent' | 'bot'
  content_type: string
}

/**
 * True when the customer's latest unanswered burst contains anything the
 * model cannot read.
 *
 * `buildConversationContext` filters to `content_type = 'text'`, so an
 * audio note, an image, or a document is simply absent from the
 * transcript the model sees. The failure mode is quiet and bad: the
 * customer sends a photo of a product and then "¿me lo hacés?", and the
 * bot answers with total confidence about something it never saw.
 *
 * Scoped to the burst — messages newer than the last agent/bot reply —
 * rather than a flat window, so a sticker sent last March doesn't
 * silence the bot forever. A burst of pure media never reaches here at
 * all: the webhook only dispatches to auto-reply when the inbound
 * carries text.
 *
 * Throws on a DB error. The caller's try/catch then skips the reply
 * without disabling the thread — an outage shouldn't be sticky.
 */
export async function hasUnreadableCustomerBurst(
  db: SupabaseClient,
  conversationId: string,
): Promise<boolean> {
  const { data, error } = await db
    .from('messages')
    .select('sender_type, content_type')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(BURST_LOOKBACK)

  if (error) throw error

  for (const row of (data ?? []) as BurstRow[]) {
    // Walking newest → oldest: the first non-customer message closes the
    // burst. Anything before it, the bot has already replied past.
    if (row.sender_type !== 'customer') return false
    if (row.content_type !== 'text') return true
  }
  return false
}
