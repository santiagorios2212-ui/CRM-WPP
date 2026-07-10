-- ============================================================
-- 033_ai_reply_idle_reset.sql — give the reply cap a memory
--
-- `conversations.ai_reply_count` only ever went up. It is meant to stop
-- a runaway loop inside one exchange, but nothing ever reset it, so a
-- customer who came back a month later found a bot that had used up its
-- budget in April and would never speak again. The cap was silently a
-- lifetime quota.
--
-- A conversation on WhatsApp is not a session. The same thread carries a
-- question in March and an order in June. What separates them is silence.
-- So: when a customer writes after a long enough gap, the exchange is a
-- new one and the budget starts over.
--
-- Where the gap is measured from matters, and the obvious choice is
-- wrong. Timing from the bot's last reply would reset the counter on a
-- customer who never left — one who kept typing into a bot that had
-- already gone quiet at its cap. The silence that ends an exchange is
-- silence in the *thread*: the gap between the message that just arrived
-- and the one before it, whoever sent it. A human agent answering five
-- minutes ago means the customer is still here.
--
-- `ai_reply_window_stale` is that rule, written once. Both the engine's
-- cheap pre-check and the atomic claim below call it, so they can never
-- disagree about whether a thread has gone cold.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- Both this migration's helper and `buildConversationContext` order a
-- conversation's messages by time. The 001 index covers the lookup but
-- not the sort.
CREATE INDEX IF NOT EXISTS idx_messages_conversation_created_at
  ON messages (conversation_id, created_at DESC);

-- ============================================================
-- Has the thread been silent long enough to start a new exchange?
--
-- False when the conversation has fewer than two messages: there is no
-- gap to measure, and a fresh conversation's counter is already zero.
-- ============================================================
CREATE OR REPLACE FUNCTION public.ai_reply_window_stale(
  p_conversation_id uuid,
  p_idle_minutes integer
)
RETURNS boolean AS $$
  SELECT COALESCE(
    (
      SELECT newest.created_at - previous.created_at
               >= make_interval(mins => p_idle_minutes)
      FROM (
        SELECT created_at FROM messages
        WHERE conversation_id = p_conversation_id
        ORDER BY created_at DESC
        LIMIT 1
      ) AS newest,
      (
        SELECT created_at FROM messages
        WHERE conversation_id = p_conversation_id
        ORDER BY created_at DESC
        OFFSET 1 LIMIT 1
      ) AS previous
    ),
    false
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- Reads `messages` as the definer, bypassing RLS. Only the engine needs
-- it; leaving it callable by `authenticated` would let any signed-in user
-- probe message timings on conversations they cannot read.
REVOKE ALL ON FUNCTION public.ai_reply_window_stale(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ai_reply_window_stale(uuid, integer) TO service_role;

-- ============================================================
-- Atomic claim, now window-aware.
--
-- Still one UPDATE, so the cap check and the increment can never be
-- separated by a concurrent inbound — the property migration 029 added
-- this function for, and the reason the app must not read-then-write.
--
-- A stale window claims the slot unconditionally and restarts the count
-- at 1: the reply about to be sent is the first of the new exchange.
--
-- Two inbounds arriving in the same second can, in principle, both see a
-- stale window and both restart the count, so an exchange may begin with
-- its counter one short. It is self-correcting — once the first message
-- lands, the gap to the one before it is seconds, and the window is no
-- longer stale — and it errs toward answering the customer, which is the
-- direction to err in. Exactness here would cost a row lock on every
-- inbound.
-- ============================================================
CREATE OR REPLACE FUNCTION public.claim_ai_reply_slot(
  conversation_id uuid,
  max_replies integer,
  idle_reset_minutes integer
)
RETURNS boolean AS $$
  WITH window_state AS (
    SELECT public.ai_reply_window_stale(conversation_id, idle_reset_minutes) AS stale
  ),
  claimed AS (
    UPDATE conversations
    SET ai_reply_count =
      CASE WHEN (SELECT stale FROM window_state) THEN 1 ELSE ai_reply_count + 1 END
    WHERE id = conversation_id
      AND ((SELECT stale FROM window_state) OR ai_reply_count < max_replies)
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM claimed);
$$ LANGUAGE sql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.claim_ai_reply_slot(uuid, integer, integer) TO service_role;

-- ============================================================
-- The old two-argument form stays, delegating to the new one.
--
-- Deploys are not atomic: this migration runs while the previous build is
-- still serving, and that build calls `claim_ai_reply_slot(uuid, integer)`
-- on every inbound. Dropping it here would make the bot go silent for the
-- minutes until the new build ships. Postgres overloads on arity, so both
-- coexist without ambiguity.
--
-- Safe to drop once no deployment calls it.
-- ============================================================
CREATE OR REPLACE FUNCTION public.claim_ai_reply_slot(
  conversation_id uuid,
  max_replies integer
)
RETURNS boolean AS $$
  SELECT public.claim_ai_reply_slot(conversation_id, max_replies, 360);
$$ LANGUAGE sql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.claim_ai_reply_slot(uuid, integer) TO service_role;
