// ============================================================
// Output guards — deterministic checks on what the model produced,
// before it reaches the customer.
//
// A system prompt is a request, not a constraint. Anything the business
// treats as a hard policy ("never quote a price") has to be enforced
// outside the model, where a jailbreak or an off day can't reach it.
// ============================================================

/**
 * Currency-token patterns. Deliberately precise rather than broad: each
 * one needs an explicit currency marker adjacent to a number, so a reply
 * like "la reunión es 100% gratuita" or "respondemos en 24 hs" passes
 * untouched.
 *
 * The trade-off is recall — "te lo dejo en 80 lucas" slips through. A
 * looser rule keyed on verbs (`sale`, `vale`, `cuesta`) misfires on
 * ordinary Spanish ("el agente sale a responder en 2 segundos"), and a
 * guard that cries wolf gets switched off. Prefer the false negative.
 */
const MONETARY_PATTERNS: readonly RegExp[] = [
  // $1000 · $ 3.500 · US$ 50 · €20 · £15
  /[$€£¥₡₲]\s*\d/,
  // U$S 50 (River Plate shorthand the symbol rule above misses)
  /U\$S\s*\d/i,
  // USD 500 · ARS1000 · EUR 20
  /\b(?:usd|ars|eur|brl|mxn|clp|cop|pen|uyu|gbp)\s*\.?\s*\d/i,
  // 500 pesos · 20 dólares · 1.000,50 euros · 1 dolar
  /\d[\d.,]*\s*(?:pesos?|d[óo]lar(?:es)?|euros?|real(?:es)?|usd|ars|eur)\b/i,
]

/**
 * True when `text` states a monetary amount.
 *
 * Used by the auto-reply path when `AI_BLOCK_MONETARY_REPLIES=true`, to
 * hand the thread to a human rather than send a price the business never
 * authorised. Not applied to drafts — a human reads those before they go
 * out, which is exactly the review this guard substitutes for.
 */
export function containsMonetaryAmount(text: string): boolean {
  return MONETARY_PATTERNS.some((re) => re.test(text))
}
