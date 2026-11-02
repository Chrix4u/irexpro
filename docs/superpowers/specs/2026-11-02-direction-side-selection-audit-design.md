# Direction Side-Selection Mirrored-Path Audit — Design

## Intent
Build a read-only, leak-resistant research audit that turns realised iRexPro entries into three research labels: `KEEP`, `FLIP`, and `ABSTAIN`. The audit exists to answer whether pre-entry patterns can distinguish profitable original directions from losses where the same entry taken in the opposite direction would have won, without changing PAPER/DEMO/LIVE execution.

## Existing system to reuse
- The AI engine already has a bounded USDJPY three-class research model (`SHORT / NO_TRADE / LONG`) with purged walk-forward validation and locked qualification gates.
- The API already stores rich pre-entry `trade_intents.metadata` and broker candle history in `market_data.provider_quote_candles`.
- `resolveEnsembleShadowOutcome()` already implements conservative 72-bar M5 first-hit TP/SL replay.
- Current DEMO profitability reliability vetoes already hard-block `EARLY_LOSS_STREAK` and degraded early-transition pair-side reliability; this audit must not duplicate or weaken them.

## Label semantics
For a closed executed trade with non-zero realised P&L:
- `KEEP`: the executed trade won. We already had a profitable direction and do not relabel it merely to chase a potentially larger counterfactual.
- `FLIP`: the executed trade lost and the mirrored opposite trade, entered at the same fill with the same stop distance and reward distance, hits TP first over the replay horizon.
- `ABSTAIN`: the executed trade lost and that mirrored opposite trade hits SL first.
- `UNRESOLVED`: trade geometry is incomplete, the replay has insufficient candles, the first-hit result is ambiguous/expired, or the executed trade is flat.

The mirrored post-entry path is a label source only, never a predictive feature source.

## Mirrored geometry
Given entry `E`, original stop distance `R = abs(E - SL)`, and original reward distance `T = abs(TP - E)`:
- original BUY -> mirrored SELL with `SL = E + R`, `TP = E - T`
- original SELL -> mirrored BUY with `SL = E - R`, `TP = E + T`

The audit uses the same estimated execution-cost R when available and replays up to 72 persisted completed M5 candles through the existing first-hit outcome resolver.

## Causality rules
- Features come only from metadata known at or before entry.
- Future candles are used only to derive the supervised target label.
- Never use trade close time, realised P&L magnitude, MFE/MAE, counterfactual result, or other post-entry telemetry as model features.
- Use a repeatable-read, read-only database transaction.
- The audit has no execution authority and cannot alter trading state.

## Pre-entry feature families to summarize
- pair and executed side
- Plan-B route and M1 tactical route
- M1 route-reliability reason
- M1 shadow pair-side reliability reason/tier
- market regime and position-sizing tier
- trained-expert relation to the executed side (`SUPPORTS`, `OPPOSES`, `ABSTAIN_SUPPORTS`, `ABSTAIN_OPPOSES`, `UNAVAILABLE`)
- pre-entry confidence/candidate score/net expected R where present

## Report
Return a JSON report with:
- immutable research metadata (`executionAuthority: NONE`, `modifiesExecution: false`, `qualificationEvidence: false`, `productionEligible: false`)
- counts of closed, resolved and unresolved trades
- overall KEEP/FLIP/ABSTAIN counts and rates
- summaries by pair-side, Plan-B route, M1 route, reliability reason, pair-side reliability reason, and trained-expert relation
- an observational pattern table sorted by sample count, with no automatic promotion decision

Do not print user IDs, connection IDs, credentials, or raw database configuration.

## Non-goals
- No automatic trade reversal.
- No execution veto or lot-size change.
- No model promotion.
- No use of post-entry data as features.
- No claim that a same-day or small-sample pattern is stable.

## Promotion path after this audit
If the labels show stable separation, the next phase can build a larger multi-pair `KEEP / FLIP / ABSTAIN` dataset from shadow opportunities and train a model using purged walk-forward time splits plus fresh holdout evaluation. Only a later, separately reviewed change may grant DEMO execution authority.
