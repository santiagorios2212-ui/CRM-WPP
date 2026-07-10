// ============================================================
// Has the reply-count window rolled over?
//
// The authoritative decision lives in `claim_ai_reply_slot`, which reads
// the database clock inside the same UPDATE that increments the counter.
// This mirror exists only for the engine's cheap pre-check: it lets a
// capped thread bail before paying for retrieval and a completion, using
// the `ai_window_started_at` the dispatcher already read. A little clock
// skew between the app and the database is immaterial over a window
// measured in hours, and the RPC has the final say regardless.
// ============================================================

/**
 * True when a new exchange should begin — i.e. the reply budget refills.
 *
 * A window that has never opened (`startedAt` null — a fresh conversation,
 * or any thread from before migration 033) always counts as expired, so
 * the first inbound opens one. `resetMinutes <= 0` means "never reset":
 * once a window is open it stays open, which is the lifetime-cap
 * behaviour, kept as a deliberate option.
 */
export function replyWindowExpired(
  startedAt: string | Date | null | undefined,
  resetMinutes: number,
  now: Date = new Date(),
): boolean {
  if (startedAt == null) return true
  if (resetMinutes <= 0) return false

  const started = startedAt instanceof Date ? startedAt : new Date(startedAt)
  // An unparseable timestamp is treated as "no window" rather than
  // trusted: better to reopen a window than to wedge the thread on a bad
  // value. The database, which wrote it, will not disagree in practice.
  if (Number.isNaN(started.getTime())) return true

  return now.getTime() - started.getTime() >= resetMinutes * 60_000
}
