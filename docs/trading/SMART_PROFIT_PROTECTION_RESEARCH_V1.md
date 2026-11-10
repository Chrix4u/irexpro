# Smart Profit Protection — broker-native research, not trading authority

**Artifact:** `smart-protection-replay-v1`

**Status:** Read-only DEMO replay; **cannot close, modify, partially close or place orders.**
The API is authenticated and chooses the latest user-owned connected cTrader-family
DEMO account. No access to LIVE positions is granted.

## Motivation and historical warning

At 2026-11-10 07:48 UTC the first Pepperstone batch contained 8 completed
trades, 7 with complete M1 quote evidence. Comparing them separately in USD:

| Candidate | Hypothetical total net change versus those trades' actual net | TP winners closed early |
| --- | ---: | ---: |
| Simple full trail at +0.5R, floor +0.25R | −126.37 | 1 of 2 |
| 25% partial at +0.5R, 75% continues to actual exit | −38.87 | 0 of 2 |
| Two adverse M1 bars + adverse M5 and M15 | −249.98 | 1 of 2 |
| 25% partial + trend-confirmed remainder exit | −226.35 | 1 of 2 |

**These four candidates all fail to improve the observed sample. None is
promoted.** Two USDCHF winners illustrate why a mechanical or merely
"trend-aware" trailing rule can close runners before TP. Replaying the same
trades used to think of a rule is NOT independent model validation.

The code returns each policy's actual baseline and its eligible sample
denominator because trend-context availability can differ from quote coverage.

## Causal simulation assumptions and limits

- Every historical M1 price and M5/M15 context candle comes from the exact
  same broker connection and instrument. Only bars fully closed before trade
  closure can produce a signal. Historical future bars cannot be used.
- M1 quotes must have independent positive bid/ask samples and provenance
  `ctrader-broker-native`. Invalid, non-monotonic, gapped or unquoted data are
  excluded or labelled. No guessed fill at an intrabar candle extreme.
- A prospective action is *hypothetically filled at the next independently
  quoted M1 close*, never at the signal close or at a magically exact threshold.
  This is an approximation, **not** broker order replay.
- 25% partial close assumes proportional gross mark-to-market and that the
  original settled transaction costs still apply to the whole position.
  Commissions and swaps are used ONLY when comparing completed outcomes.
  They are never consulted to decide whether a historical signal fired.
- It cannot know if TP would definitely hit for an unclosed counterfactual
  position. Only the *actual* settled TP winner is a known fact.
- An eligible candle cohort is still biased by data availability. A
  purported benefit on 7 usable trades is not statistically reliable.

## Promotion requirements for a separate version and review

1. A frozen strategy version is evaluated on independent later DEMO trades
   (at least 60 qualified, ideally multiple weeks and differing market
   regimes), segregated by broker, pair, currency, route and account cost.
   Report out-of-sample net P&L delta, expected drawdown, TP-winner
   retention, confidence bounds and trade count before proposing a change.
2. Verify the actual cTrader **position** amendment protocol (not pending
   order), broker symbol precision, minimum stop distance and stop direction
   with an isolated DEMO canary. For a BUY, a protective SL must be below
   current executable BID; for a SELL it must be above current executable ASK.
   Never widen an existing protective stop.
3. For broker-held protection, prove exact position-id ownership, no race
   against an already closed position, monotone stop improvement, amendment
   acknowledgement followed by a fresh read-after-write position snapshot.
   On a broker reject/timeout, do not falsely claim protected profit.
4. For partial close, validate supported minimum lot/step and volume at the
   broker (including 4.00-lot and smaller positions), exact settled fill costs,
   final partial fill status, idempotent retries and total exposure reconciliation.
5. Record a durable, account-scoped stop/partial-intent audit, proposal ID,
   as-of quote, resulting broker acknowledgement, stop price and errors.
   A disconnected worker must not report protected stops that were never installed.
6. Preserve original TP (no premature removal) and broker hard SL, kill
   switch, risk ceilings, market-data freshness, shadow fallback and
   operator-controlled start/stop. Explicit operator approval is required
   for any executable canary and any LIVE promotion.

The implemented endpoint intentionally contains **no** adapter or
`ExecutionService` call, no broker mutation and no promotion toggle.
