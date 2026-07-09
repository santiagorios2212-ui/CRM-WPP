import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const h = vi.hoisted(() => ({ embedTexts: vi.fn() }))
vi.mock('./embeddings', () => ({
  embedTexts: h.embedTexts,
  toVectorLiteral: (v: number[]) => `[${v.join(',')}]`,
}))

import { retrieveKnowledge, ingestDocument } from './knowledge'

interface SemanticRow {
  id: string
  content: string
  distance?: number
}

interface FakeState {
  semantic: SemanticRow[]
  fts: { id: string; content: string }[]
  chunkCount: number
  countError: unknown
  ftsError: unknown
  rpcCalls: string[]
  rpcArgs: Record<string, unknown>[]
  inserted: Record<string, unknown>[] | null
  deletedFor: string | null
}

function makeDb() {
  const state: FakeState = {
    semantic: [],
    fts: [],
    chunkCount: 5, // account has a non-empty KB by default
    countError: null,
    ftsError: null,
    rpcCalls: [],
    rpcArgs: [],
    inserted: null,
    deletedFor: null,
  }
  const db = {
    rpc: (name: string, args: Record<string, unknown>) => {
      state.rpcCalls.push(name)
      state.rpcArgs.push(args)
      if (name === 'match_ai_knowledge_semantic')
        return Promise.resolve({ data: state.semantic, error: null })
      if (name === 'match_ai_knowledge_fts')
        return Promise.resolve({ data: state.fts, error: state.ftsError })
      return Promise.resolve({ data: null, error: null })
    },
    from: () => ({
      // retrieveKnowledge's empty-KB count guard.
      select: () => ({
        eq: () =>
          Promise.resolve({ count: state.chunkCount, error: state.countError }),
      }),
      delete: () => ({
        eq: (_col: string, val: string) => {
          state.deletedFor = val
          return Promise.resolve({ error: null })
        },
      }),
      insert: (rows: Record<string, unknown>[]) => {
        state.inserted = rows
        return Promise.resolve({ error: null })
      },
    }),
  }
  return { db: db as unknown as SupabaseClient, state }
}

/** Same query on both paths — most tests don't care about the split. */
const q = (text: string) => ({ semantic: text, lexical: text })

beforeEach(() => {
  h.embedTexts.mockReset()
  h.embedTexts.mockImplementation(async (_key: string, inputs: string[]) =>
    inputs.map((_, i) => [i, i]),
  )
})

describe('retrieveKnowledge', () => {
  it('returns an empty result for an empty query without touching the DB', async () => {
    const { db, state } = makeDb()
    const out = await retrieveKnowledge(db, 'acct', { embeddingsApiKey: null }, q('  '))
    expect(out).toEqual({ excerpts: [], hasKnowledgeBase: false, degraded: false })
    expect(state.rpcCalls).toEqual([])
  })

  it('short-circuits (no embed, no RPC) when the KB is empty', async () => {
    const { db, state } = makeDb()
    state.chunkCount = 0
    const out = await retrieveKnowledge(db, 'acct', { embeddingsApiKey: 'sk-x' }, q('q'))
    expect(out).toEqual({ excerpts: [], hasKnowledgeBase: false, degraded: false })
    expect(h.embedTexts).not.toHaveBeenCalled()
    expect(state.rpcCalls).toEqual([])
  })

  it('uses lexical FTS only when there is no embeddings key', async () => {
    const { db, state } = makeDb()
    state.fts = [{ id: 'f1', content: 'F1' }]
    const out = await retrieveKnowledge(db, 'acct', { embeddingsApiKey: null }, q('q'))
    expect(out.excerpts).toEqual(['F1'])
    expect(out.hasKnowledgeBase).toBe(true)
    expect(out.degraded).toBe(false)
    expect(state.rpcCalls).toEqual(['match_ai_knowledge_fts'])
    expect(h.embedTexts).not.toHaveBeenCalled()
  })

  it('uses semantic search when an embeddings key is present', async () => {
    const { db, state } = makeDb()
    state.semantic = [
      { id: 's1', content: 'S1', distance: 0.1 },
      { id: 's2', content: 'S2', distance: 0.2 },
      { id: 's3', content: 'S3', distance: 0.3 },
    ]
    const out = await retrieveKnowledge(db, 'acct', { embeddingsApiKey: 'sk-x' }, q('q'), 3)
    expect(out.excerpts).toEqual(['S1', 'S2', 'S3'])
    expect(h.embedTexts).toHaveBeenCalledTimes(1)
    // Enough semantic hits → no FTS top-up.
    expect(state.rpcCalls).toEqual(['match_ai_knowledge_semantic'])
  })

  it('tops up with FTS and dedupes when semantic is short', async () => {
    const { db, state } = makeDb()
    state.semantic = [
      { id: 's1', content: 'S1', distance: 0.1 },
      { id: 's2', content: 'S2', distance: 0.2 },
    ]
    state.fts = [
      { id: 's2', content: 'S2-dup' }, // dedup by id
      { id: 'f1', content: 'F1' },
    ]
    const out = await retrieveKnowledge(db, 'acct', { embeddingsApiKey: 'sk-x' }, q('q'), 3)
    expect(out.excerpts).toEqual(['S1', 'S2', 'F1'])
    expect(state.rpcCalls).toEqual([
      'match_ai_knowledge_semantic',
      'match_ai_knowledge_fts',
    ])
  })

  it('drops semantic hits past the distance threshold', async () => {
    const { db, state } = makeDb()
    // The RPC has no threshold of its own, so a greeting still comes back
    // with the k nearest chunks. Only the close one is real grounding.
    state.semantic = [
      { id: 's1', content: 'CLOSE', distance: 0.4 },
      { id: 's2', content: 'FAR', distance: 0.95 },
    ]
    const out = await retrieveKnowledge(db, 'acct', { embeddingsApiKey: 'sk-x' }, q('hola'), 3)
    expect(out.excerpts).toEqual(['CLOSE'])
    expect(out.degraded).toBe(false)
  })

  it('keeps rows whose distance is absent rather than discarding them', async () => {
    const { db, state } = makeDb()
    state.semantic = [{ id: 's1', content: 'S1' }]
    const out = await retrieveKnowledge(db, 'acct', { embeddingsApiKey: 'sk-x' }, q('q'), 3)
    expect(out.excerpts).toEqual(['S1'])
  })

  it('reports a KB that exists but matched nothing (not degraded)', async () => {
    const { db } = makeDb() // chunkCount 5, no semantic/fts rows
    const out = await retrieveKnowledge(db, 'acct', { embeddingsApiKey: null }, q('q'))
    expect(out).toEqual({ excerpts: [], hasKnowledgeBase: true, degraded: false })
  })

  it('reports degraded when embedding fails and FTS finds nothing', async () => {
    const { db } = makeDb()
    h.embedTexts.mockRejectedValueOnce(new Error('provider down'))
    const out = await retrieveKnowledge(db, 'acct', { embeddingsApiKey: 'sk-x' }, q('q'))
    expect(out.degraded).toBe(true)
    expect(out.hasKnowledgeBase).toBe(true)
  })

  it('is NOT degraded when embedding fails but FTS still grounds the reply', async () => {
    const { db, state } = makeDb()
    state.fts = [{ id: 'f1', content: 'F1' }]
    h.embedTexts.mockRejectedValueOnce(new Error('provider down'))
    const out = await retrieveKnowledge(db, 'acct', { embeddingsApiKey: 'sk-x' }, q('q'))
    expect(out.excerpts).toEqual(['F1'])
    expect(out.degraded).toBe(false)
  })

  it('reports degraded when the chunk count query errors', async () => {
    const { db, state } = makeDb()
    state.countError = new Error('db down')
    const out = await retrieveKnowledge(db, 'acct', { embeddingsApiKey: null }, q('q'))
    expect(out).toEqual({ excerpts: [], hasKnowledgeBase: true, degraded: true })
  })

  it('reports degraded when the FTS RPC errors with no embeddings key', async () => {
    const { db, state } = makeDb()
    state.ftsError = new Error('rpc denied')
    const out = await retrieveKnowledge(db, 'acct', { embeddingsApiKey: null }, q('q'))
    expect(out.degraded).toBe(true)
  })

  it('sends the widened query to embeddings and the narrow one to FTS', async () => {
    const { db, state } = makeDb()
    await retrieveKnowledge(
      db,
      'acct',
      { embeddingsApiKey: 'sk-x' },
      { semantic: 'quiero un CRM\n¿cuánto sale?', lexical: '¿cuánto sale?' },
    )
    expect(h.embedTexts).toHaveBeenCalledWith('sk-x', ['quiero un CRM\n¿cuánto sale?'])
    const ftsArgs = state.rpcArgs[state.rpcCalls.indexOf('match_ai_knowledge_fts')]
    expect(ftsArgs.p_query).toBe('¿cuánto sale?')
  })
})

describe('ingestDocument', () => {
  it('embeds chunks when a key is present', async () => {
    const { db, state } = makeDb()
    await ingestDocument(db, 'acct', { embeddingsApiKey: 'sk-x' }, 'doc-1', 'hello world')
    expect(h.embedTexts).toHaveBeenCalledTimes(1)
    expect(state.deletedFor).toBe('doc-1')
    expect(state.inserted).toHaveLength(1)
    expect(state.inserted![0].embedding).toBe('[0,0]') // literal from mocked embed
    expect(state.inserted![0].account_id).toBe('acct')
  })

  it('stores chunks without embeddings when there is no key', async () => {
    const { db, state } = makeDb()
    await ingestDocument(db, 'acct', { embeddingsApiKey: null }, 'doc-1', 'hello world')
    expect(h.embedTexts).not.toHaveBeenCalled()
    expect(state.inserted![0].embedding).toBeNull()
  })

  it('deletes existing chunks and inserts nothing for empty content', async () => {
    const { db, state } = makeDb()
    await ingestDocument(db, 'acct', { embeddingsApiKey: 'sk-x' }, 'doc-1', '   ')
    expect(state.deletedFor).toBe('doc-1')
    expect(state.inserted).toBeNull()
    expect(h.embedTexts).not.toHaveBeenCalled()
  })

  it('still stores lexical chunks when embedding fails, then rethrows', async () => {
    const { db, state } = makeDb()
    h.embedTexts.mockRejectedValueOnce(new Error('rate limited'))
    await expect(
      ingestDocument(db, 'acct', { embeddingsApiKey: 'sk-x' }, 'doc-1', 'hello world'),
    ).rejects.toThrow('rate limited')
    // Chunks were inserted (lexical search works) despite the embed failure…
    expect(state.inserted).toHaveLength(1)
    expect(state.inserted![0].embedding).toBeNull()
  })
})
