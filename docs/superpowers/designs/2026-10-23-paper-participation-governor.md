# PAPER Participation Governor Design

## Intent
Increase qualified PAPER participation so the six-pair M5 engine does not remain silent for hours while preserving positive post-cost economics and hard safety controls.

## Goal
Use a 30-minute soft participation target across the six-pair portfolio. Idleness may relax only soft predictive admission thresholds and must reduce position size as thresholds relax. Idleness never forces a trade.

## Non-goals
- Do not trade every M5 candle.
- Do not guarantee a trade count or profitability.
- Do not relax event-risk, execution-cost, portfolio/risk, post-loss, entry-alignment, stop/target, broker, or mature weak pair/side reliability gates.
- Do not reopen confirmed-reversal or early-transition routes.

## Chosen approach: idle-aware scout tiers
Keep the existing `paper-opportunity-scout` as the single participation boundary and add `idleMinutes` plus a mode to its decision.

- BASE (<30m or idle unavailable): confidence >= 0.60, net expected R >= 0.08, quality >= 0.30, >=4 consensus, lot cap 0.05.
- ACTIVE (>=30m): confidence >= 0.58, net expected R >= 0.06, quality >= 0.25, >=4 consensus, aligned momentum >=0.15 ATR, lot cap 0.03.
- RECOVERY (>=60m): confidence >= 0.56, net expected R >= 0.04, quality >= 0.20, >=4 consensus, aligned momentum >=0.15 ATR, lot cap 0.02.
- OUT_OF_DISTRIBUTION: never gets idle relaxation; retain confidence >=0.62, net expected R >=0.12 and normally 5/6 consensus.

Hard gates remain: TREND_CONTINUATION route only, scoutable trend regime only, eventRisk=CLEAR, usable execution cost, portfolioQuality >=0.35. Existing downstream reliability, post-loss, adaptive ranking, entry alignment, sizing/risk and broker controls remain authoritative.

## Telemetry
Persist and log scout mode, idle minutes, 30-minute target window, reason and lot cap. Bump scout model artifact to v2 so forward outcomes can be separated from v1.

## Approaches considered
1. Lower normal admission thresholds globally — rejected because it increases full-size exposure and weakens all regimes.
2. Force one trade every N bars — rejected because time alone cannot create edge.
3. Idle-aware reduced-risk scout — chosen because it converts inactivity into bounded exploration while keeping hard safety authoritative.

## PAPER execution size invariant

- Executable external-provider PAPER trades use an overall product lot band of **0.10 to 2.00 lots**; **0.10 is reserved for explicitly eligible opportunity scouts**, while normal PAPER starts at 0.20.
- Opportunity-scout idleness may relax only soft predictive floors and may size an eligible scout at 0.10 lots; it must never lower normal PAPER below 0.20 or bypass hard safety.
- `PositionSizingService` remains authoritative for stop-distance risk and margin. It honors an explicit 0.10 scout floor or the 0.20 normal floor only when the actual stop-loss risk fits the durable ceiling; otherwise execution fails closed with `POSITION_SIZE_BELOW_POLICY_MINIMUM`.
- Calibrated OOD ideas may execute only through the evidence-backed 0.10 scout tier; legacy 0.01/0.02/0.03/0.05 execution remains disabled.
- M1 tactical V4 remains an immutable historical 0.01-lot cohort, but active wiring uses `m1-tactical-rollout-v5-meaningful-size-shadow`: M1 continues observing at one-minute cadence and cannot execute until it qualifies for the 0.20-lot product floor.
