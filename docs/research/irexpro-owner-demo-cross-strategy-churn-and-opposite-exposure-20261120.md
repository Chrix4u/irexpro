# iRexPro owner DEMO — unexpected USDCAD close/re-sell and EURUSD BUY+SELL overlap

**Observed on:** 2026-11-20 UTC, verified against owner-scoped Pepperstone cTrader USD DEMO broker-backed trade records and audit close requests.

## USDCAD immediate same-side churn
- Trade A: USDCAD **SELL**, opened **00:59:33.826Z**, main ensemble `EARLY_TRANSITION`, **2.00 lots**. Closed **01:04:53.672Z**, broker settled net **-$31.53**, persisted reason `AI_CLOSE_SIGNAL`.
- Close request audit at **01:04:49.561Z** records **`aiCloseTrigger.source = DEMO_DRAWDOWN_GUARD`**, `reasonCode = plan-b-v89-demo-5m-drawdown-guard-v1`. The 5-minute guard was the direct closer; the research-only forming-candle expert did not close the order.
- Trade B: same USDCAD **SELL**, opened **01:06:24.676Z**, ensemble `CONFIRMED_REVERSAL`, **2.00 lots**, after **91 seconds** from the prior broker close.
- Trade B was also force-closed **01:11:38.202Z**, broker settled net **-$30.14**, with another audit close request from `DEMO_DRAWDOWN_GUARD` at **01:11:36.057Z**.
- Combined recorded net of the pair: **-$61.67** including broker-recorded costs.
- The existing owner DEMO three-minute same-side reentry logic covered `PROFIT_PROTECTION` only. It did not cover `AI_CLOSE_SIGNAL` generated explicitly by the `DEMO_DRAWDOWN_GUARD`.

## EURUSD opposing positions
- Older **BUY**, opened **00:24:26.406Z**, ensemble `EARLY_TRANSITION`, 1.72 lots; tactical advisor `ABSTAIN`; still OPEN at check around **01:13Z**.
- New **SELL**, opened **01:07:36.162Z**, ensemble `CONFIRMED_REVERSAL`, 1.31 lots; tactical advisor `M1_EARLY_TRANSITION`; was simultaneously OPEN.
- These are real distinct broker trades, not just an incorrect UI direction. Both have `external_provider_paper_only=true`, `M1` timeframe, and valid ensemble provenance.
- `M1TacticalEvidenceService.loadOpenPaperPositions` previously discarded the existing BUY from its open-position result because its metadata `m1_tactical_route=ABSTAIN` was not one of the allowed M1 tactical execution labels. It was a real ensemble-created position nonetheless. Its direction was therefore not counted by the M1 scheduler's opposite-exposure protection.
- The scheduler also contained a `confirmedDirectionFlip` side effect that could close the old opposite position just because a new confirmed reversal proposal arrived. A new entry proposal should not automatically liquidate an existing position without independent exit authority.

## Targeted correction
1. The existing M1 scheduler's opposite-position check now admits any real OPEN, owner/account/instrument-scoped internal iRexPro M1/M5 DEMO position regardless of whether the tactical route is `ABSTAIN` or missing. Broker-trade identity, instrument and direction remain mandatory. Ordinary M1 metadata are still retained where available, but their absence no longer makes open exposure invisible.
2. A candidate that disagrees with an existing open direction is recorded as `M1_ACTIVE_OPPOSITE_POSITION`; its entry waits. The automatic `M1_CONFIRMED_DIRECTION_FLIP` liquidation of old positions has been removed. Separately authorized risk/profit/owner exits remain unchanged.
3. The prior three-minute, same-pair, same-side post-`PROFIT_PROTECTION` reentry hold now **also** recognizes an immutable `TRADE_CLOSE_REQUESTED` audit event explicitly sourced to `DEMO_DRAWDOWN_GUARD`, with exact owner, trade, pair, side and as-of timestamp match. Generic `AI_CLOSE_SIGNAL` from any other source is not sufficient. Other symbols and directions stay eligible.
4. This correction does **not** close any currently open position, adjust stops/targets/lot sizing, change the separate 5-minute drawdown guard threshold, enable the research candlestick expert for broker orders, or promote to live.

## Evidence and verification
- Reproduced with read-only script `apps/api/scripts/audit-owner-demo-close-reopen-opposite-20261120.cjs`. It queries only the owner Pepperstone cTrader USD DEMO account, includes auditable close trigger source and original model route, and never writes to the DB or submits orders.
- Focused regression tests: `pnpm exec jest src/modules/ai/m1-tactical-evidence.service.spec.ts src/modules/ai/m1-tactical-scheduler.service.spec.ts --runInBand --silent`.
- **195 focused tests passed** before build.
- Remaining research issue: whether the five-minute -0.4R drawdown guard's exit policy truly improves **after-cost** outcomes in conjunction with entry timing. Do not automatically disable it or infer a successful counterfactual from later price recovery.
- Historical opposite positions already open at the time of deployment are not force-closed by this patch. They remain subject to preexisting authorized exit handling. No automatic account-wide flattening is performed.
