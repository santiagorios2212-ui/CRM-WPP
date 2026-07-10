-- ============================================================
-- 033_ai_reply_reset_window.sql — give the reply cap a clock
--
-- `conversations.ai_reply_count` only ever went up. The per-conversation
-- cap is meant to bound one exchange, but nothing reset it, so it was
-- silently a lifetime quota: a customer who used up ten replies in July
-- met a bot that would never speak to them again.
--
-- The fix is a fixed-length window that starts when the customer opens an
-- exchange. The clock runs from that first message: once
-- `auto_reply_reset_minutes` have passed since the window began, the next
-- inbound starts a fresh window and the budget refills. So a burst of
-- questions shares one budget, and a customer coming back tomorrow — or
-- six hours later — gets a new one.
--
-- The window length lives on `ai_configs`, per account, so it is editable
-- from the agent settings UI rather than an env var. Zero means "never
-- reset": the old lifetime-cap behaviour, kept as a deliberate choice for
-- anyone who wants it.
--
-- `ai_window_started_at` records when the current window opened. NULL —
-- a fresh conversation, or any thread from before this migration — reads
-- as "no window yet", so the first inbound after it always opens one.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS ai_window_started_at timestamptz;

ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS auto_reply_reset_minutes integer NOT NULL DEFAULT 360
    CHECK (auto_reply_reset_minutes BETWEEN 0 AND 43200);   -- 0 = never; ≤ 30 days

-- Index the sort the AI path does on every inbound (029 added the count
-- columns but nothing indexed the per-conversation message timeline that
-- buildConversationContext orders by).
CREATE INDEX IF NOT EXISTS idx_messages_conversation_created_at
  ON messages (conversation_id, created_at DESC);

-- ============================================================
-- Atomic claim, now window-aware.
--
-- One UPDATE still does the whole thing — the window test, the cap check,
-- and the write cannot be split, or two inbounds landing together would
-- both open a window and both reset the count. This is the property
-- migration 029 introduced the function for, and the reason the app must
-- not read-then-write the counter itself.
--
--   - Window expired (or none yet): open a new one now, count = 1. The
--     reply about to be sent is the first of the exchange.
--   - Window still open, under the cap: increment, claim.
--   - Window still open, at the cap: refuse.
--
-- `reset_minutes = 0` disables expiry, so once a window is open it never
-- rolls over — the lifetime cap, but anchored at the first message rather
-- than at row creation.
-- ============================================================
CREATE OR REPLACE FUNCTION public.claim_ai_reply_slot(
  conversation_id uuid,
  max_replies integer,
  reset_minutes integer
)
RETURNS boolean AS $$
  WITH state AS (
    SELECT
      c.ai_window_started_at IS NULL
        OR (reset_minutes > 0
            AND now() - c.ai_window_started_at >= make_interval(mins => reset_minutes))
        AS expired
    FROM conversations c
    WHERE c.id = conversation_id
  ),
  claimed AS (
    UPDATE conversations
    SET
      ai_window_started_at =
        CASE WHEN (SELECT expired FROM state) THEN now() ELSE ai_window_started_at END,
      ai_reply_count =
        CASE WHEN (SELECT expired FROM state) THEN 1 ELSE ai_reply_count + 1 END
    WHERE id = conversation_id
      AND ((SELECT expired FROM state) OR ai_reply_count < max_replies)
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM claimed);
$$ LANGUAGE sql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.claim_ai_reply_slot(uuid, integer, integer) TO service_role;

-- ============================================================
-- The old two-argument form stays, delegating to the new one.
--
-- Deploys are not atomic: this migration runs while the previous build is
-- still answering inbounds, and that build calls the two-argument
-- signature on every one. Dropping it would silence the bot for the
-- minute or two until the new build ships. A hard-coded six-hour window
-- during that overlap is harmless. Postgres overloads on arity, so both
-- coexist unambiguously; drop this once no deployment calls it.
-- ============================================================
CREATE OR REPLACE FUNCTION public.claim_ai_reply_slot(
  conversation_id uuid,
  max_replies integer
)
RETURNS boolean AS $$
  SELECT public.claim_ai_reply_slot(conversation_id, max_replies, 360);
$$ LANGUAGE sql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.claim_ai_reply_slot(uuid, integer) TO service_role;
