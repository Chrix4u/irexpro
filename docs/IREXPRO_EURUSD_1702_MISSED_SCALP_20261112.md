# iRexPro — EURUSD 17:02 missed SELL opportunity, independent M1 research
**12 November 2026 | Pepperstone cTrader DEMO | Trading authority unchanged**

## Verified market sequence

The user identified a plausible missed EURUSD SELL at approximately 17:02 UTC:

| Broker M1 candle UTC | High | Low |
| --- | ---: | ---: |
| 17:02 | 1.10579 | 1.10560 |
| 17:04 | 1.10592 | 1.10577 |
| 17:05 | 1.10592 | 1.10574 |
| 17:07 | 1.10552 | 1.10538 |

The **17:02 decision** was a broker-native EURUSD `M1_TREND_CONTINUATION`
SELL with suggested entry **1.105635**, stop **1.106135** (~5 pips)
and TP **1.104835** (~8 pips). The candidate M1 paper governance
was eligible and had positive forecast net expected R ~+0.102;
the Plan B route rejected with predicted net expected R ~-0.372,
TREND_WEAK. The four displayed wrapper vetoes were the **same
Plan B admission failure** repeated across its status layers:
MULTIMODEL_PLAN_B_NOT_ADMITTED, MULTIMODEL_GOVERNANCE_BLOCKED,
ENSEMBLE_NOT_PAPER_ADMITTED, ENSEMBLE_NOT_PROMOTABLE_ADMISSION.

The market reached ~1.10592 against the SELL, below the proposed
stop of 1.106135. The 17:07 broker-observed positive ask was
~1.10542. Had the hypothetical SELL entered near 1.105635 and
closed near 17:07, there was a ~2.15pip price difference *before*
commission/slippage. Subtracting 1.1pip assumed extra costs leaves
~1.05pip, before any fill-price variance. **Not a real broker fill**.

Crucially: the original 8pip TP was NOT touched. The profitable
5–6-minute opportunity required a different, evidence-based **exit
policy**, not just opening the old order and holding indefinitely.

## Contradictory evidence: do NOT auto-execute all M1 approvals

A narrow one-hour read-only quote-mark check of nine first-of-5min
EURUSD M1-approved SELL cohorts around 16:23–17:14 showed mostly
negative fixed-duration outcomes at five minutes. This preliminary
sample was not a full nonoverlapping tick-accurate backtest and some
quote-derived stop/TP outcomes are approximate. It demonstrates
that one missed winner does not prove blanket removal profitable.
The 17:01 SELL, at a worse entry ~1.10550, was materially less
profitable than 17:02 at ~1.105635 — minute-level entry timing
and pullback geometry are key.

## Implemented: independent prospective M1 entry/exit research

- `independent-m1-opportunity-shadow.ts`: independently scores the
  M1 specialist after its own price/cost, regime, route and actual
  reliability evidence. **Plan B is not used to veto its research
  eligibility**; disagreement is recorded explicitly.
- Snapshot in `trading.m1_tactical_decisions.governance`:
  `independentM1OpportunityShadow`, immutable decision-time entry,
  SL, TP, M1 confidence/quality, realised pair-side reliability,
  Plan B disagreement and 3/5/6/7/10m exit-horizon hypotheses.
- `audit-independent-m1-profit-window.cjs`: a READ-ONLY broker
  bid/ask counterfactual that requires genuine positive spreads
  in EVERY evaluated minute, uses first prospectively eligible
  signal per pair/side/15m slot, and reports fixed-hold outcomes,
  stop-first pessimistic proxy and short profit captures
  of 1.5, 2 and 3 pips. Commission/slippage budget of 1.1pip
  is an estimate and may differ by actual broker lot size/fees.
- A root-owned single-flight weekday 21:45 UTC job retains private
  reports for comparison across new market conditions.
- No changes to risk gates, trading authority, portfolio limits,
  position sizes, stop-losses, LIVE privileges or existing orders.
  **No broker orders were forced.**

## Promotion criteria before changing DEMO execution

The model must show prospectively positive after-cost and stop-first
results across multiple independent market sessions and entered
price/exit geometries (not a cherry-picked rebound), plus
broker-realistic fills and account-level risk. If it qualifies,
a separate explicit DEMO-only micro trial can replace the redundant
Plan B veto for *that specific independent entry route*, while
all account-risk/stop/margin/kill-switch safety checks remain.
Until then, treating Plan B admission as universally 'unnecessary'
would be unsupported by the observed distribution.

The current user's concern that too many gates are suppressing
trades is valid. This audit distinguishes genuine adverse
predictions from duplicate wrapper labels and creates an
independent performance-evaluation path.
