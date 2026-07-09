import { accessToken, freeBusy } from './google'
import { computeSlots } from './slots'
import { formatSlotEs, isoWithOffset } from './tz'
import type { CalendarConfig, Slot } from './types'

const DAY = 86_400_000

/**
 * The account's currently bookable slots, straight from Google.
 *
 * Called twice per booking: once to build the prompt, once again inside
 * `bookMeeting` immediately before writing. The second read is not
 * redundant — seconds pass while the model generates, and the slot the
 * customer just accepted may have been taken by a human in that window.
 *
 * The free/busy window runs two days past the horizon: `maxDaysAhead`
 * counts whole *local* days, so the last one ends up to 24h (plus the
 * zone's offset) after `now + maxDaysAhead × 24h`. Asking Google for a
 * little more than we need costs nothing; asking for too little would
 * silently present a booked slot on the final day as free.
 */
export async function freeSlots(config: CalendarConfig, now: Date): Promise<Slot[]> {
  const token = await accessToken(config.refreshToken)
  const busy = await freeBusy(
    token,
    config.calendarId,
    now,
    new Date(now.getTime() + (config.maxDaysAhead + 2) * DAY),
  )
  return computeSlots({ busy, config, now })
}

/** A slot as the model sees it: a human label to say out loud, and the
 *  exact timestamp to echo back in the booking marker. */
export interface SuggestedSlot {
  iso: string
  label: string
}

/**
 * The handful of slots to put in front of the customer.
 *
 * Only the *presentation* is trimmed to `offerSlots` — a WhatsApp
 * message listing fourteen times is unreadable. The model may still book
 * any slot in the full set, so a customer who counter-proposes "¿y el
 * jueves a las 15?" is not told it is unavailable when it plainly is.
 */
export function suggestedSlots(slots: Slot[], config: CalendarConfig): SuggestedSlot[] {
  return slots.slice(0, config.offerSlots).map((slot) => ({
    iso: isoWithOffset(slot.start, config.timezone),
    label: formatSlotEs(slot.start, config.timezone),
  }))
}
