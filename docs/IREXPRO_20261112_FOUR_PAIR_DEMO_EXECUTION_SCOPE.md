# iRexPro — operator-authorized FOUR executable Pepperstone DEMO instruments
**Requested 12 November 2026, Ghana UTC | Exact-symbol execution-scope change**

## Four pairs now permitted to reach existing execution qualification

- EURUSD
- AUDUSD
- USDCAD
- USDJPY

GBPUSD and USDCHF remain unavailable for new M1-scanner DEMO orders
and are not in the high-frequency M1 scanning queue.

This supersedes ONLY the prior immutable focused-two policy binding,
not the prior policy declaration (which stays available for rollback).
A new `DEMO_FOCUSED_ENTRY_INSTRUMENTS_V4` constant and
`M1_TACTICAL_ROLLOUT_POLICY_V8_FOCUSED_FOUR_FEE_SHADOW` are bound in
the actual `AiModule` injection provider.

**Scope is DEMO FULL_AUTO only**, not an automatic signal or guaranteed
order. No changes to any of:
- PRIMARY_PLAN_B admission or route confidence
- independent M1 continuation fallback probation, which remains
  restricted for lacking verified independent settled after-cost history
- M1/M5/H1/H4 direction/entry safeguards, event/news/OOD vetoes
- after-cost realised P&L brake and broker commission shadow data
- broker account risk allocation, max position exposure, equity
  drawdown protection, actual broker lot sizing and risk-per-stop
- native stop-loss/take-profit, turnover, spread and rollover gates
- account ownership, DEMO versus LIVE validation
- already-open positions or historical trade outcomes

## Scanner fairness

The original focused-two scan policy only evaluated EURUSD and AUDUSD.
The exact four-pair list is now a scan as well as execution allowlist.

Each completed minute rotates the first pair; all four are evaluated
in the same serial, owner-bound loop when the scan is able to complete.
This prevents the newly restored USDCAD/USDJPY from being permanently
late priority. If the VPS is overloaded, scan latency and incomplete
per-minute coverage remain possible and need separate monitoring.

Previous six-pair policy and historical two-pair policy keep their own
scan ordering. An arbitrary malformed/duplicate four-pair list
never gains the scoped shortcut.

## Historical rationale; not a profitability promise

A reconstructed owner-bound cTrader EUR account audit:
- 04 Nov 2026: 14 closed, 9 after-fee net winners, +€14.53,
  with the PRIMARY_PLAN_B route contributing +€23.29.
- 04–09 Nov: 35 closed, net −€22.42 over four days;
  the old primary Plan B alone was ~breakeven (−€0.95).
- USDCAD SELL: five closes, four net wins, +€11.67 over TWO
  distinct historical trading days.
- USDJPY BUY: three closes, two net wins, +€3.74 on ONE day.
- Active Pepperstone 10–12 Nov: 44 closed, net −$1,259.71
  after actual commissions/swap at markedly larger volumes
  and different broker/currency.

Operator explicitly requested four executable DEMO instruments,
not merely shadow research; USDCAD and USDJPY therefore join the
existing source-of-truth DEMO allowlist subject to every independent
execution risk check. Do NOT treat the historical positive
pair-side subsets as qualified profitable strategies.

## Acceptance checks

1. New immutable policy has exact list and version
   `m1-tactical-v8-demo-primary-fee-shadow-focused4-v4`.
2. AiModule actually binds that policy.
3. Scan ordering includes exactly four and rotates priority across
   each four completed minute slots; no GBPUSD/USDCHF fallback to entry.
4. Tests verify other risk settings, historical 2 and 6 focus,
   PAPER/SHADOW non-authority and malformed symbols.
5. NestJS API build passes and PM2 reload applies the compiled code
   only when the actual broker DEMO is healthy and no active
   position needs continuous profit protection.
6. Live DB should then show persisted M1 tactical decisions for
   all FOUR symbols, not just broker quote candles.
7. No-availability/no-trade assertions are limited to the exact
   observed after-deployment period; never claim an approved
   or filled order without actual broker-native evidence.

## Critical independently enforced dispatcher gate

The first implementation review found a second authorization check:
`StrategyOrchestratorService.processSignal` Gate 3.6 calls
`isCurrentFocusedDemoEntryInstrument`, which had hard-coded the
historical V3 two-pair list. Without updating that *separate*
central execution guard, freshly scored USDCAD and USDJPY signals
would still fail just ahead of broker risk validation with
`DEMO_INSTRUMENT_RESEARCH_ONLY`, despite the new scanner policy.

That helper now references exact immutable V4 four-pair scope.
The orchestrator rejection message is updated from "two" to "four";
GBPUSD/USDCHF and suffixed symbols still fail before risk or broker
dispatch. Strategy-orchestrator tests explicitly verify that USDCAD
and USDJPY reach the normal downstream risk validation without
bypassing it. All old two-pair policy fixtures stay immutable for
replay/rollback.
