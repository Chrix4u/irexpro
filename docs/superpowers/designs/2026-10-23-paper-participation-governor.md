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

- Every executable external-provider PAPER trade uses a product lot band of **0.20 to 2.00 lots**.
- Opportunity-scout idleness may relax only soft predictive floors; it must never shrink an executed trade below 0.20 lots.
- `PositionSizingService` remains authoritative for stop-distance risk and margin. If safe computed volume is below 0.20 lots, execution must fail closed with `POSITION_SIZE_BELOW_POLICY_MINIMUM` rather than round risk upward.
- Calibrated OOD ideas that only justify micro sizing remain shadow-only; they must not execute at 0.01/0.02/0.03/0.05 lots.
