# iRexPro — prospective Plan B reversal / M1 continuation disagreement monitor
**Frozen hypothesis 13 November 2026 UTC/Ghana | Pepperstone cTrader DEMO | NO BROKER ORDER AUTHORITY**

## Why this specific research branch

The connected Pepperstone FULL_AUTO DEMO has four executable scan pairs:
EURUSD, AUDUSD, USDCAD, USDJPY. The core 4 November Plan B
primary model is intact, but primary admission and M1 timing
rarely align.

At 00:42 UTC 13 November, the trailing six-hour scanner showed:

| Instrument | Decisions | Plan B paper-admitted | M1 routes | Both | Primary authorized |
|---|---:|---:|---:|---:|---:|
| AUDUSD | 697 | 10 | 72 | 4 | 0 |
| EURUSD | 703 | 19 | 68 | 1 | 0 |
| USDCAD (recently enabled) | 90 | 7 | 7 | 0 | 0 |
| USDJPY (recently enabled) | 90 | 3 | 5 | 0 | 0 |

A full read-only 15-minute broker-candle timing counterfactual from
12 November 12:00 UTC through its 13 November 00:4x maturity cutoff
found 81 de-duplicated Plan B-admitted/M1-timing-rejected episodes:
70 with modeled after-cost observed outcomes; 27 positive,
43 negative, net approximately **−10.72R**.

By Plan B route:
- CONFIRMED_REVERSAL: 50 evaluable, 20 positive, 30 negative,
  **−9.40R**.
- TREND_CONTINUATION: 10 evaluable, 3 positive, 7 negative,
  **−2.69R**.
- EARLY_TRANSITION: 10 evaluable, 4 positive, 6 negative,
  **+1.375R**, still a small retrospective cohort.

The narrower **AUDUSD SELL** mismatches were 17 evaluable,
10 positive and 7 negative, approximately **+4.07R** under
the M1 candle/fee assumptions. Some had Plan B's higher-level
`CONFIRMED_REVERSAL` regime and the same-direction M1 route
`M1_TREND_CONTINUATION`. This is a legitimate label-compatibility
*research hypothesis*, not evidence of broker-fill profitability:
many other reversal mismatches lost money, and recent AUDUSD SELL
samples had M5 momentum still pointing against the trade.

## New immutable prospective classification

`apps/api/src/modules/ai/planb-reversal-m1-continuation-shadow.ts`

This zero-network, pure decision-time observer records:
- all Plan B reversal / same-direction M1 continuation mismatch
  cases, including those NOT eligible for the hypothesis;
- original Plan B admission and governance agreement;
- M1 directional quality, score edge and completed higher-timeframe
  agreement;
- completed M5 momentum, body pressure and latest body;
- existing event, drift and broker spread evidence;
- expert contradiction and contemporaneous failure to break out.

A fixed, *non-executable* candidate hypothesis requires:
1. Plan B fully admitted as CONFIRMED_REVERSAL, M1 route
   `M1_TREND_CONTINUATION` on the same explicit side;
2. no strongly opposing broker-native expert, no failed
   breakout with direction, M1 route reason either
   `TREND_STRUCTURE_ALIGNED` or `FRESH_M5_CONTINUATION`;
3. event CLEAR, drift NORMAL, original broker spread evidence
   valid and Plan B modeled netExpectedR above 0.1;
4. M1 directional score edge at least 0.30, direction quality
   at least 0.68 and completed higher-timeframe agreement
   at least 0.20;
5. completed M5 aligned momentum 1-bar at least 0.18 ATR,
   3-bar at least 0.10 ATR, 3-bar body pressure at least
   0.12 and latest completed body pressure at least 0.30.

The thresholds are **frozen hypotheses for future measurement**.
They are NOT fitted or qualified on the 17 historical positive
AUDUSD SELL outcomes and carry no execution authority.

## How it is integrated

The existing `M1TacticalSchedulerService` computes the diagnostic
once per already-computed M1 + Plan B decision, after the ordinary
authority evaluator has run. It persists the complete observation
under `trading.m1_tactical_decisions.governance.planBReversalM1ContinuationShadow`.

The diagnostic is never referenced by:
- `preliminaryCanExecute` or `canExecute`;
- Plan B admission, primary authority or M1 route classification;
- broker risk/margin/spread/rollover/SL/TP validation;
- lot sizing, trade-intent dispatch, broker order creation,
  position-closing or live-account promotion.

Every result records `shadowOnly=true`,
`modifiesExecution=false`,
`brokerOrderAuthority='NONE'` and
`automaticPromotionEligible=false`. The 23-unit-test regression
asserts these invariants and source wiring.

## Prospective evidence gate

Accumulate 30-minute de-duplicated episodes across at least
10 distinct forex sessions and multiple market conditions,
with the original pre-entry thresholds frozen.
Join subsequent verified Pepperstone BID/ASK marks and paid
commission to unbiased stop-first 15-minute and 30-minute
paths. Record missing quotes, ambiguous intrabar stop/target
ordering, execution latency, spread widening, and matched
opportunity costs. Then compare against ordinary primary
Plan B fills and excluded mismatches, including the number of
good opportunities that never enter.

No improvement in execution is claimed from this monitor.
No current primary Plan B or legacy 4 November gate is changed.
