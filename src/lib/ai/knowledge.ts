import type { SupabaseClient } from '@supabase/supabase-js'
import type { AiConfig } from './types'
import { chunkText } from './chunk'
import { aiKnowledgeMaxDistance } from './defaults'
import { embedTexts, toVectorLiteral } from './embeddings'

// ============================================================
// Knowledge base: ingest (chunk + optionally embed) and hybrid
// retrieve (semantic when an embeddings key is present, topped up with
// lexical full-text search).
// ============================================================

interface MatchRow {
  id: string
  content: string
  /** Cosine distance; present only on `match_ai_knowledge_semantic`. */
  distance?: number
}

/**
 * Outcome of a retrieval. Callers need to tell three states apart, which
 * a bare `string[]` collapsed into one indistinguishable `[]`:
 *
 *   - no knowledge base at all      → answer from the system prompt
 *   - a KB exists, nothing matched  → answer, but say so (see
 *     `buildSystemPrompt`'s `knowledgeMissing`)
 *   - retrieval broke               → `degraded`; the caller must NOT let
 *     an unsupervised bot answer ungrounded
 */
export interface KnowledgeResult {
  /** Relevant excerpts, best first. */
  excerpts: string[]
  /** The account has at least one indexed chunk. */
  hasKnowledgeBase: boolean
  /** Retrieval failed and produced nothing — results are not merely
   *  empty, they are unknown. Fail closed on this. */
  degraded: boolean
}

/** Query text for each retrieval path. See `recentUserMessages` for why
 *  they differ. */
export interface KnowledgeQuery {
  /** Widened to the last few customer turns. */
  semantic: string
  /** The latest customer turn only. */
  lexical: string
}

/**
 * (Re)build the chunks for one document. Deletes the document's
 * existing chunks, re-chunks the content, and — when the account has an
 * embeddings key — embeds each chunk. Runs under whatever client the
 * caller passes (service-role for ingest routes).
 *
 * Throws on embedding failure so the ingest route can report it; the
 * chunks are only written once embedding (if attempted) succeeds, so a
 * failed embed never leaves half-indexed rows.
 */
export async function ingestDocument(
  db: SupabaseClient,
  accountId: string,
  config: Pick<AiConfig, 'embeddingsApiKey'>,
  documentId: string,
  content: string,
): Promise<void> {
  const chunks = chunkText(content)

  // Replace, don't append — re-ingest must be idempotent.
  const { error: delErr } = await db
    .from('ai_knowledge_chunks')
    .delete()
    .eq('document_id', documentId)
  if (delErr) throw delErr

  if (chunks.length === 0) return

  // Embed if a key is set, but DON'T let an embedding failure stop the
  // chunks from being stored: a failed embed must still leave the
  // document searchable lexically. We record the error and rethrow it
  // AFTER inserting (embedding-less) rows, so the route can warn
  // "semantic indexing failed" — which is now truthful, because lexical
  // search really does still work.
  let embeddings: number[][] | null = null
  let embedError: unknown = null
  if (config.embeddingsApiKey) {
    try {
      embeddings = await embedTexts(config.embeddingsApiKey, chunks)
    } catch (err) {
      embedError = err
    }
  }

  const rows = chunks.map((content, i) => ({
    document_id: documentId,
    account_id: accountId,
    chunk_index: i,
    content,
    embedding: embeddings ? toVectorLiteral(embeddings[i]) : null,
  }))

  const { error: insErr } = await db.from('ai_knowledge_chunks').insert(rows)
  if (insErr) throw insErr

  if (embedError) throw embedError
}

const EMPTY: KnowledgeResult = {
  excerpts: [],
  hasKnowledgeBase: false,
  degraded: false,
}

/**
 * Retrieve up to `k` knowledge excerpts relevant to the customer's
 * question.
 *
 * Semantic-primary when an embeddings key is configured (embed the
 * query → cosine-nearest chunks, then drop anything past
 * `aiKnowledgeMaxDistance`), topped up with lexical full-text matches to
 * fill `k`. Lexical-only when there's no key.
 *
 * Never throws — the draft route and the auto-reply bot both treat a
 * retrieval failure as a degraded answer, not an outage. But it does
 * report that failure via `degraded`, so an unsupervised caller can
 * decline to answer rather than silently improvise. The old contract
 * (a bare `string[]`) made "nothing matched" and "the embeddings
 * provider timed out" look identical, and the bot answered anyway.
 *
 * The distance filter matters more than it looks:
 * `match_ai_knowledge_semantic` is a plain `ORDER BY <=> LIMIT k` with no
 * threshold, so unfiltered it hands back five chunks for *any* input —
 * "hola" included — and every reply looks grounded.
 */
export async function retrieveKnowledge(
  db: SupabaseClient,
  accountId: string,
  config: Pick<AiConfig, 'embeddingsApiKey'>,
  query: KnowledgeQuery,
  k = 5,
): Promise<KnowledgeResult> {
  const semanticQuery = query.semantic.trim()
  const lexicalQuery = query.lexical.trim()
  if ((!semanticQuery && !lexicalQuery) || k <= 0) return EMPTY

  // Skip everything when the account has no knowledge base — otherwise
  // every draft / auto-reply would pay for a query embedding + two RPCs
  // just to get []. One cheap indexed COUNT (head, no rows) instead of a
  // paid embeddings call on the hot path.
  let hasKnowledgeBase: boolean
  try {
    const { count, error } = await db
      .from('ai_knowledge_chunks')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', accountId)
    if (error) throw error
    if (!count) return EMPTY
    hasKnowledgeBase = true
  } catch (err) {
    // We can't tell whether this account has grounding to offer, so we
    // can't tell whether answering is safe. Report it and let the caller
    // decide.
    console.error('[ai knowledge] chunk count failed:', err)
    return { excerpts: [], hasKnowledgeBase: true, degraded: true }
  }

  const picked = new Map<string, string>() // id → content, preserves order
  const maxDistance = aiKnowledgeMaxDistance()
  let errored = false

  // Semantic path.
  if (config.embeddingsApiKey && semanticQuery) {
    try {
      const [queryEmbedding] = await embedTexts(config.embeddingsApiKey, [
        semanticQuery,
      ])
      if (queryEmbedding) {
        const { data, error } = await db.rpc('match_ai_knowledge_semantic', {
          p_account_id: accountId,
          p_query_embedding: toVectorLiteral(queryEmbedding),
          p_match_count: k,
        })
        if (error) throw error
        if (Array.isArray(data)) {
          for (const row of data as MatchRow[]) {
            // A row without a distance can't be judged — keep it rather
            // than silently discarding every hit if the RPC's shape
            // ever changes.
            if (typeof row.distance === 'number' && row.distance > maxDistance) {
              continue
            }
            picked.set(row.id, row.content)
          }
        }
      }
    } catch (err) {
      errored = true
      console.error('[ai knowledge] semantic retrieval failed, falling back to FTS:', err)
    }
  }

  // Lexical top-up (also the sole path when there's no embeddings key).
  if (picked.size < k && lexicalQuery) {
    try {
      const { data, error } = await db.rpc('match_ai_knowledge_fts', {
        p_account_id: accountId,
        p_query: lexicalQuery,
        p_match_count: k,
      })
      if (error) throw error
      if (Array.isArray(data)) {
        for (const row of data as MatchRow[]) {
          if (picked.size >= k) break
          if (!picked.has(row.id)) picked.set(row.id, row.content)
        }
      }
    } catch (err) {
      errored = true
      console.error('[ai knowledge] lexical retrieval failed:', err)
    }
  }

  const excerpts = Array.from(picked.values()).slice(0, k)
  // A path that errored but still produced excerpts isn't degraded — the
  // reply is grounded, just possibly less well ranked. Only "something
  // broke AND we have nothing" forces the caller's hand.
  return { excerpts, hasKnowledgeBase, degraded: errored && excerpts.length === 0 }
}
