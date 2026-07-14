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
export interface PromptSlot {
  iso: string
  label: string
}

/**
 * How many free slots to name in the prompt.
 *
 * The model both proposes from this list and validates a customer's
 * requested time against it, so the window has to be wide enough that an
 * ordinary counter-proposal — "¿y a las 11?", "¿el jueves?" — is almost
 * always a time it can see and answer definitively, rather than one it has
 * to hedge about. It is deliberately generous: it comfortably covers the
 * whole default booking horizon for a normally-busy diary, and only starts
 * to bite on an unusually open calendar or a horizon of many weeks. Past
 * it, `total` tells the model there is more availability it cannot see, so
 * it never mistakes the end of the list for the end of the diary.
 */
export const MAX_PROMPT_SLOTS = 150

/**
 * The bookable slots to put in front of the model, soonest first, capped
 * at `MAX_PROMPT_SLOTS`.
 *
 * This is both the list the agent proposes from and the list it checks a
 * customer's requested time against. Only the *proposal* is trimmed
 * further — to `config.offerSlots` — and that happens in the prompt, when
 * the agent writes the actual WhatsApp message; a fourteen-line message is
 * unreadable, but the model still needs to *see* the wider availability so
 * it can answer "sí, las 11 está libre" or "las 11 está ocupada, ¿te sirve
 * a las 11:30?" instead of promising to "try".
 */
export function availableSlots(slots: Slot[], config: CalendarConfig): PromptSlot[] {
  return slots.slice(0, MAX_PROMPT_SLOTS).map((slot) => ({
    iso: isoWithOffset(slot.start, config.timezone),
    label: formatSlotEs(slot.start, config.timezone),
  }))
}
