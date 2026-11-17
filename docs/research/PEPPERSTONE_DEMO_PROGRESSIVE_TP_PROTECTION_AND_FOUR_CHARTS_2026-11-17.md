# iRexPro four-pair chart alignment and progressive TP-relative profit harvesting — 17 Nov 2026

## User observation and verified cause

The owner supplied a 17 Nov 2026 trading-page screenshot with **EURUSD** and **AUDUSD** tabs only, while the AI focus panel displayed **GBPUSD BUY**. The screenshot does **not** show that GBPUSD was authorized or executed. Source-of-truth on the API's *active binding*:
`apps/api/src/modules/ai/ai.module.ts` uses `M1_TACTICAL_ROLLOUT_POLICY_V8_FOCUSED_FOUR_FEE_SHADOW`; `demoEntryInstruments` is exactly `EURUSD, AUDUSD, USDCAD, USDJPY`. `GBPUSD` and `USDCHF` are **research-only/dormant**, with no added DEMO/LIVE entry authority.

The web helper `apps/web/src/lib/trading-chart-focus.ts` still had a pre-V4 **two-pair fallback** when the server's M1 tactical status was absent/refreshing or malformed. This caused two chart tabs even though four were executable on the active DEMO policy. The independent broader VPS scanner could still report GBPUSD as AI market *research* focus, but `nextAiFocusedChartInstrument` correctly prohibited auto-switching to a non-executable pair.

### UI fix

- Presentation-only fallback now displays the **four currently approved DEMO instruments**, matching V4. When valid `DEMO_FULL_AUTO` status arrives, it remains authoritative over the fallback, including future opt-in changes; avoid displaying legacy six automatically.
- The focus panel explicitly labels a `GBPUSD` or `USDCHF` scanner focus as **Research-only focus**, explaining why it is not executable and why the chart stays on an approved pair.
- When focus moves among `EURUSD/AUDUSD/USDCAD/USDJPY`, the existing auto-follow logic switches the chart. Manual selection is respected until the focused instrument changes.
- No model, session, broker, risk or account authorization changed.

## Progressive after-fee TP-relative peak retention

Previous owner-verified Pepperstone USD DEMO `CONFIRMED_REVERSAL` and `EARLY_TRANSITION` profit protection already retained 65%/75%/80% by peak-to-initial-risk R. The owner requested a more responsive rule so a trade that could achieve ~$140 at TP can tighten progressively as observed profit grows, preserving more at peaks such as $55–$86 while still letting strong runners continue.

Opt-in flag `IREXPRO_PEPPERSTONE_DEMO_PROGRESSIVE_TP_RETENTION=enabled` **in addition to** existing owner ID, original after-fee lock, alternate-route lock and tiered-retention flags. The service only sends the flag to the pure evaluator on **verified owner-scoped Pepperstone cTrader USD DEMO** positions with exact M1 admitted `CONFIRMED_REVERSAL` or `EARLY_TRANSITION` entry lineage. The engine must also verify symbol, side, volume, original broker SL/TP, current profitable price within original barriers, >=15s age, <=60s last observation freshness, >=3 observations, causal historical fee samples and positive remaining after-extra-fee economics before an exit.

Calculate theoretical TP P&L from **broker-verified order geometry**:
`initialRiskAtStop * abs(originalTakeProfit-brokerEntryPrice) / abs(brokerEntryPrice-originalStop)`.
This normalizes lot size and original R/R and does *not* claim any future TP fill. Divide broker-observed peak net P&L by that theoretical TP amount. Keep the old R-tier floor, then apply a continuous piecewise-linear boost (if peak >=3x the conservative historical fee reserve):

| Peak fraction of geometric TP potential | Suggested retention floor |
| --- | --- |
| 25% | 65% |
| 35% | 72% |
| 40% | 80% |
| 55% | 86% |
| 70% | 89% |
| 85% or more | 91% |

The actual retention is the **max** of the above interpolated percentage and existing 65%/75%/80% R tier, capped at 91%. Above the new floor, HOLD; only an independently observed falling broker P&L that crosses below the floor and still satisfies buffered after-fee positivity requests `PROFIT_PROTECTION`. The independent expert trend consultation remains **non-veto, audit only**, as it cannot assure a broker-side positive stop. No SL or TP amendments. The extra exit reserve is still enforced. Ordinary continuation, LIVE, other owners and brokers retain existing behavior.

Example ($140 theoretical TP, $100 initial risk, $10 extra fee reserve): a $62 peak is ~44.3% of TP, new guard ~82% of broker-observed peak, floor around $51, compared with existing 65% tier floor $40.30. **A gap or delayed fill can still close below the intended floor**, and net after commission will be lower than broker-reported gross if the broker has not included all charges. It is not a guaranteed +$51 trade or proof of improved realized net expectancy.

Every executed protective close logs `progressiveTP`, `tpPotential`, `peakFractionTP`, `peakRetention`, the legacy 55% comparison, **and** the prior tiered policy counterfactual `oldTierWouldClose`. These are *decision-time comparisons only*; no hypothetical fills are created. See regression tests for geometry, fee cushion, monotonic interpolation, continued HOLD above floor, scope fail-closed.

## Existing positions preflight

At 03:43:28 UTC two owner Pepperstone USD DEMO positions were OPEN: USDJPY BUY 3.18 lots (recorded peak +$18.39, sampled mark −$11.54, initial risk ~$99.76) and USDCAD SELL 2.86 lots (peak +$37.41, sampled mark −$10.58, initial risk ~$99.97). Neither was at >=0.50R activation, so merely activating the progressive lock should not trigger a close on these recorded observations. This is not a forward market guarantee. Risk gates and original broker protection remain.

## Tests and operations

Chart unit + UI regression: 20 Jest tests passed. Pure lock/service regressions: 113 Jest tests passed (including new TP-relative interpolation tests). API Nest and web Next.js production builds and runtime PM2 restarts must be verified before claiming deployment. The flag can be disabled to revert only the progressive overlay without rolling back the existing 65/75/80 policy. Continuous trial timebox remains unlimited but portfolio brakes remain active. No LIVE promotion.
