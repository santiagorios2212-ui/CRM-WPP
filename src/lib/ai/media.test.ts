import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { hasUnreadableCustomerBurst } from './media'

interface Row {
  sender_type: 'customer' | 'agent' | 'bot'
  content_type: string
}

/** `rows` newest-first, mirroring the `order('created_at', desc)` query. */
function makeDb(rows: Row[], error: unknown = null) {
  const db = {
    from: () => ({
      select: () => ({
        eq: () => ({
          order: () => ({
            limit: () => Promise.resolve({ data: rows, error }),
          }),
        }),
      }),
    }),
  }
  return db as unknown as SupabaseClient
}

const text = (sender: Row['sender_type']): Row => ({
  sender_type: sender,
  content_type: 'text',
})

describe('hasUnreadableCustomerBurst', () => {
  it('is false for a text-only burst', async () => {
    const db = makeDb([text('customer'), text('bot'), text('customer')])
    expect(await hasUnreadableCustomerBurst(db, 'conv-1')).toBe(false)
  })

  it('is true when the burst mixes media with the text we are answering', async () => {
    // Customer sent a photo, then "¿me lo hacés?" — the model sees only
    // the second message.
    const db = makeDb([
      text('customer'),
      { sender_type: 'customer', content_type: 'image' },
      text('bot'),
    ])
    expect(await hasUnreadableCustomerBurst(db, 'conv-1')).toBe(true)
  })

  it('ignores media from before the last agent/bot reply', async () => {
    const db = makeDb([
      text('customer'),
      text('bot'),
      { sender_type: 'customer', content_type: 'audio' },
    ])
    expect(await hasUnreadableCustomerBurst(db, 'conv-1')).toBe(false)
  })

  it('ignores media the business itself sent', async () => {
    const db = makeDb([
      text('customer'),
      { sender_type: 'agent', content_type: 'image' },
      text('customer'),
    ])
    expect(await hasUnreadableCustomerBurst(db, 'conv-1')).toBe(false)
  })

  it('is false for an empty conversation', async () => {
    expect(await hasUnreadableCustomerBurst(makeDb([]), 'conv-1')).toBe(false)
  })

  it('throws on a DB error so the caller skips without disabling the thread', async () => {
    const db = makeDb([], new Error('db down'))
    await expect(hasUnreadableCustomerBurst(db, 'conv-1')).rejects.toThrow('db down')
  })
})
