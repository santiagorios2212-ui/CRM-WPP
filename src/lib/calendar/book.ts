import type { SupabaseClient } from '@supabase/supabase-js'
import { freeSlots } from './availability'
import { accessToken, insertEvent } from './google'
import { isBookable } from './slots'
import { formatSlotEs } from './tz'
import type { BookingResult, CalendarConfig, Slot } from './types'

const UNIQUE_VIOLATION = '23505'

/**
 * Why a booking did or did not happen. Every branch is a distinct thing
 * to say to the customer, so none of them collapse into a bare boolean.
 */
export type BookOutcome =
  | { status: 'booked'; slot: Slot; result: BookingResult }
  /** The instant is no longer bookable — taken, or never was. */
  | { status: 'unavailable' }
  /** This thread already booked, or another thread took this instant. */
  | { status: 'already_claimed' }
  /** Google refused or broke. The claim has been rolled back. */
  | { status: 'failed'; error: unknown }

export interface BookMeetingArgs {
  db: SupabaseClient
  config: CalendarConfig
  accountId: string
  conversationId: string
  contactId: string
  /** The instant the model proposed, already parsed and range-checked. */
  instant: Date
  attendeeEmail: string
  /** Contact name for the event title, when we know it. */
  contactName?: string | null
}

/**
 * Put the meeting in the calendar, or explain why not.
 *
 * The ordering is the whole design. We re-derive availability from
 * Google, then claim the slot in Postgres, and only then write to
 * Google:
 *
 *   1. Re-read free/busy. The prompt's slot list is seconds stale; a
 *      human may have taken the slot while the model was writing.
 *   2. `isBookable` — exact instant equality against that fresh set.
 *      This is the only thing standing between a hallucinated timestamp
 *      and a real event in someone's calendar.
 *   3. INSERT the claim. Two unique indexes make this the lock: one
 *      booking per conversation, one booking per (account, instant).
 *      Google's free/busy cannot see a booking that has not been written
 *      yet, so two concurrent conversations agreeing on 10:00 would both
 *      pass step 2. Exactly one survives the INSERT.
 *   4. Create the event. If Google refuses, delete the claim so the slot
 *      returns to circulation rather than being poisoned forever.
 *
 * Doing it the other way round — Google first, Postgres second — would
 * leave an orphaned event in the account's calendar every time the
 * insert lost the race, and there is no customer-visible way to explain
 * that.
 */
export async function bookMeeting(args: BookMeetingArgs): Promise<BookOutcome> {
  const { db, config, accountId, conversationId, contactId, instant, attendeeEmail } = args

  let slots: Slot[]
  try {
    slots = await freeSlots(config, new Date())
  } catch (error) {
    return { status: 'failed', error }
  }

  if (!isBookable(instant, slots)) return { status: 'unavailable' }

  const end = new Date(instant.getTime() + config.slotMinutes * 60_000)

  const { data: claim, error: claimError } = await db
    .from('ai_bookings')
    .insert({
      account_id: accountId,
      conversation_id: conversationId,
      contact_id: contactId,
      starts_at: instant.toISOString(),
      ends_at: end.toISOString(),
      attendee_email: attendeeEmail,
    })
    .select('id')
    .single()

  if (claimError) {
    if (claimError.code === UNIQUE_VIOLATION) return { status: 'already_claimed' }
    return { status: 'failed', error: claimError }
  }

  const name = args.contactName?.trim()
  try {
    const token = await accessToken(config.refreshToken)
    const result = await insertEvent(token, config.calendarId, {
      summary: name ? `Llamada con ${name}` : 'Llamada agendada por WhatsApp',
      description:
        'Agendada automáticamente desde WhatsApp.\n' +
        `Contacto: ${attendeeEmail}\n` +
        `Horario local: ${formatSlotEs(instant, config.timezone)} (${config.timezone})`,
      start: instant,
      end,
      timezone: config.timezone,
      attendeeEmail,
    })

    // Best-effort backfill. The event exists and the customer has the
    // invitation; a failed UPDATE here costs us the audit trail, not the
    // meeting, so it must not surface as a booking failure.
    const { error: backfillError } = await db
      .from('ai_bookings')
      .update({ google_event_id: result.eventId, meet_url: result.meetUrl })
      .eq('id', claim.id)
    if (backfillError) {
      console.error(
        `[calendar] booked Google event ${result.eventId} but failed to record it on ai_bookings ${claim.id}:`,
        backfillError,
      )
    }

    return { status: 'booked', slot: { start: instant, end }, result }
  } catch (error) {
    // Release the claim: nothing was written to Google, so the slot is
    // still free and the next customer deserves to be offered it.
    const { error: rollbackError } = await db
      .from('ai_bookings')
      .delete()
      .eq('id', claim.id)
    if (rollbackError) {
      console.error(
        `[calendar] Google insert failed AND the claim ${claim.id} could not be rolled back — slot ${instant.toISOString()} is now unbookable until the row is deleted by hand:`,
        rollbackError,
      )
    }
    return { status: 'failed', error }
  }
}

/**
 * The message the customer receives once the event exists.
 *
 * Composed here, from the instant we actually wrote to the calendar —
 * never by the model. The one sentence that tells a customer when they
 * are expected on a call is not something to sample from a language
 * model, however well it has behaved up to this point.
 */
export function confirmationMessage(args: {
  template: string
  start: Date
  timezone: string
  email: string
  meetUrl: string | null
}): string {
  const body = args.template
    .replaceAll('{datetime}', formatSlotEs(args.start, args.timezone))
    .replaceAll('{email}', args.email)
  return args.meetUrl ? `${body}\n${args.meetUrl}` : body
}
