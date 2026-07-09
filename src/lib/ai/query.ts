import type { ChatMessage } from './types'
import { aiRetrievalUserTurns } from './defaults'

/**
 * The text to retrieve knowledge against: the most recent customer
 * (`user`) turn in the conversation context. Falls back to the last
 * message of any role, then empty string. Shared by the draft route and
 * the auto-reply bot so both query the knowledge base the same way.
 */
export function latestUserMessage(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return messages[i].content
  }
  return messages.length > 0 ? messages[messages.length - 1].content : ''
}

/**
 * The last `n` customer turns, oldest-first, joined by newlines.
 *
 * WhatsApp questions arrive split across turns — "me interesa el CRM" /
 * "¿y cuánto sale?" — and the follow-up alone carries no topic, so
 * embedding it on its own retrieves nothing useful. Widening the query
 * to the recent customer turns restores the subject.
 *
 * Only used for the *semantic* query. The lexical path must keep using
 * `latestUserMessage`: `match_ai_knowledge_fts` builds its query with
 * `plainto_tsquery`, which ANDs every term, so a longer query strictly
 * shrinks the match set. What helps embeddings hurts full-text search.
 */
export function recentUserMessages(
  messages: ChatMessage[],
  n: number = aiRetrievalUserTurns(),
): string {
  const turns: string[] = []
  for (let i = messages.length - 1; i >= 0 && turns.length < n; i--) {
    if (messages[i].role === 'user') turns.unshift(messages[i].content)
  }
  if (turns.length === 0) return latestUserMessage(messages)
  return turns.join('\n')
}
