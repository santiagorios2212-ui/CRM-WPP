-- ============================================================
-- 032_calendar_booking.sql — calendar-backed meeting booking
--
-- Lets the AI agent read the account's real availability, offer free
-- slots to a customer on WhatsApp, and write the agreed meeting back to
-- the calendar. Google is the only provider today; the `provider` CHECK
-- is the seam for adding another.
--
-- Design notes
--   - `ai_calendar_configs` is account-scoped and UNIQUE(account_id),
--     mirroring `ai_configs` / `whatsapp_config`. One calendar per
--     workspace; teammates share it.
--   - `refresh_token` is a Google OAuth offline token. We exchange it
--     for a short-lived access token on every booking pass, so we need
--     the plaintext at call time — stored AES-256-GCM-encrypted at rest
--     with the same `encrypt()`/`decrypt()` as `whatsapp_config.
--     access_token`, and never returned to the client after save.
--   - `booking_enabled` is the switch that lets the agent *promise* a
--     meeting. Off by default: an agent that offers to book when nothing
--     can book is worse than one that says nothing, because the customer
--     waits for an invitation that never arrives.
--   - `working_hours` is `{ "<weekday 0-6>": [["HH:MM","HH:MM"], ...] }`
--     in `timezone`'s wall clock. A missing weekday means closed. Two
--     ranges express a split shift. Parsed and enforced by `computeSlots`
--     in src/lib/calendar/slots.ts, which is the single source of truth
--     for "is this slot bookable?".
--   - `confirmation_template` is the message the customer receives once
--     the event exists. It is composed by *code*, never by the model:
--     the one sentence stating the time the customer is now committed to
--     must not be a token sampled from a distribution.
--     Placeholders: {datetime}, {email}.
--
-- Concurrency — the two unique indexes on `ai_bookings` are locks, not
-- hygiene, and the booking path depends on them:
--
--   - `one_per_conversation` bounds the agent to a single automatic
--     booking per thread. A customer who wants to reschedule gets a
--     human. It also means a retried webhook delivery cannot create a
--     second event.
--   - `no_double_book` closes the race that free/busy cannot see. Two
--     customers messaging at once both query Google, both see 10:00
--     free, and both agree to it — Google's freeBusy has no knowledge of
--     the booking the other conversation is about to make. The engine
--     therefore INSERTs the claim first and calls Google second; the
--     loser of the race gets a unique violation and hands off instead of
--     double-booking the account.
--
-- RLS
--   Settings-class, mirroring `ai_configs`: any member may read the
--   config (the inbox needs to know whether booking is on), admin+ may
--   write it. `ai_bookings` is read-only to members — only the engine,
--   under the service-role client, ever writes a booking.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS ai_calendar_configs (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id            uuid NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  created_by            uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  provider              text NOT NULL DEFAULT 'google' CHECK (provider IN ('google')),
  refresh_token         text NOT NULL,              -- AES-256-GCM-encrypted OAuth offline token
  calendar_id           text NOT NULL DEFAULT 'primary',
  connected_email       text,                       -- display only; never used for auth
  timezone              text NOT NULL DEFAULT 'UTC',
  slot_minutes          integer NOT NULL DEFAULT 30
                          CHECK (slot_minutes BETWEEN 5 AND 480),
  buffer_minutes        integer NOT NULL DEFAULT 15
                          CHECK (buffer_minutes BETWEEN 0 AND 240),
  min_notice_minutes    integer NOT NULL DEFAULT 120
                          CHECK (min_notice_minutes BETWEEN 0 AND 20160),   -- ≤ 14 days
  max_days_ahead        integer NOT NULL DEFAULT 14
                          CHECK (max_days_ahead BETWEEN 0 AND 90),
  offer_slots           integer NOT NULL DEFAULT 3
                          CHECK (offer_slots BETWEEN 1 AND 10),
  working_hours         jsonb NOT NULL DEFAULT
                          '{"1":[["09:00","17:00"]],"2":[["09:00","17:00"]],"3":[["09:00","17:00"]],"4":[["09:00","17:00"]],"5":[["09:00","17:00"]]}'::jsonb,
  booking_enabled       boolean NOT NULL DEFAULT false,
  confirmation_template text NOT NULL DEFAULT
                          'Listo, agendé la llamada para el {datetime}. Te envié la invitación a {email}.',
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE ai_calendar_configs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_calendar_configs_select ON ai_calendar_configs;
CREATE POLICY ai_calendar_configs_select ON ai_calendar_configs FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS ai_calendar_configs_insert ON ai_calendar_configs;
CREATE POLICY ai_calendar_configs_insert ON ai_calendar_configs FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS ai_calendar_configs_update ON ai_calendar_configs;
CREATE POLICY ai_calendar_configs_update ON ai_calendar_configs FOR UPDATE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS ai_calendar_configs_delete ON ai_calendar_configs;
CREATE POLICY ai_calendar_configs_delete ON ai_calendar_configs FOR DELETE
  USING (is_account_member(account_id, 'admin'));

CREATE OR REPLACE FUNCTION public.update_ai_calendar_configs_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ai_calendar_configs_updated_at ON ai_calendar_configs;
CREATE TRIGGER ai_calendar_configs_updated_at
  BEFORE UPDATE ON ai_calendar_configs
  FOR EACH ROW
  EXECUTE FUNCTION public.update_ai_calendar_configs_updated_at();

-- ============================================================
-- Bookings the agent made, and the locks that keep it honest.
-- ============================================================

CREATE TABLE IF NOT EXISTS ai_bookings (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  conversation_id  uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  contact_id       uuid REFERENCES contacts(id) ON DELETE SET NULL,
  starts_at        timestamptz NOT NULL,
  ends_at          timestamptz NOT NULL,
  attendee_email   text NOT NULL,
  -- Null between claiming the row and Google confirming the event. The
  -- engine deletes the claim if the insert fails, so a persistent null
  -- means a crash landed between the two — worth alerting on.
  google_event_id  text,
  meet_url         text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);

-- One automatic booking per thread. Reschedules are a human's job.
CREATE UNIQUE INDEX IF NOT EXISTS ai_bookings_one_per_conversation
  ON ai_bookings (conversation_id);

-- Two conversations cannot claim the same instant. See the concurrency
-- note above: Google's freeBusy cannot see a booking that has not been
-- written yet, so this index is what actually prevents the double-book.
CREATE UNIQUE INDEX IF NOT EXISTS ai_bookings_no_double_book
  ON ai_bookings (account_id, starts_at);

CREATE INDEX IF NOT EXISTS ai_bookings_account_starts_at
  ON ai_bookings (account_id, starts_at DESC);

ALTER TABLE ai_bookings ENABLE ROW LEVEL SECURITY;

-- Read-only to the dashboard. Every write goes through the service-role
-- client in the auto-reply engine, which bypasses RLS.
DROP POLICY IF EXISTS ai_bookings_select ON ai_bookings;
CREATE POLICY ai_bookings_select ON ai_bookings FOR SELECT
  USING (is_account_member(account_id));
