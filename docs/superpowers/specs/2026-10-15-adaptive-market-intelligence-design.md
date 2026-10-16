# Adaptive Market Intelligence Design

## Goal
Make iRexPro materially more analytical and adaptive in the forex market by unifying current market regime, pair/direction/session evidence, execution economics, portfolio/currency exposure, drift, and realised trade feedback into one causal pre-trade intelligence layer.

The first release is active PAPER execution authority when deployed to the production application: it alters candidate ranking immediately and may down-size/normal-size PAPER risk immediately; evidence-backed up-sizing above 1.00x remains gated by maturity. It does not create DEMO/LIVE authority, does not automatically promote a strategy, does not self-train model weights, and does not weaken the existing Risk Engine, event-risk gate, spread/cost governance, post-loss guards, margin checks, broker limits, or qualification gates.

## Existing Architecture To Preserve
The implementation must extend, not bypass, the following existing authorities:

- `scorePlanBMultimodelShadow()` already produces regime, strategy route, direction quality, trade quality, exit quality, session quality, expected-R, portfolio quality, consensus and admission evidence.
- `ensemble-governance.ts` owns cost-aware execution governance, drift, sleeve evidence and PAPER/promotion blockers.
- `paper-route-reliability.ts` already tracks route and pair/side realised evidence including closed episodes, profit factor, Sharpe, max drawdown and positive-window fraction.
- `plan-b-multimodel-shadow.ts` already converts open positions into base/quote currency exposure and penalises aligned concentration.
- `paper-cost-aware-entry.ts`, calibrated PAPER spread authority and calibrated-cost rescue own execution-cost decisions. Adaptive intelligence must consume their economics; it must not estimate a competing spread or cost model.
- `PositionSizingService` remains the authoritative lot-size calculator. The adaptive layer may supply a bounded risk multiplier and a lot upper bound, but cannot directly force the final lot.
- PAPER research sizing currently supports realistic risk-based sizing up to the 1.0-lot safety ceiling. This design preserves that ceiling for this release.
- `ExternalSignalPerformanceService` owns qualification reporting and the established review gates. Adaptive trades do not bypass the existing minimum evidence and DEMO review process.

## Scope
This release consists of six cooperating units:

1. Adaptive Market State Engine.
2. Pair × Direction × Session × Regime Edge Matrix.
3. Adaptive Opportunity Scorer.
4. Currency/Portfolio Exposure Intelligence.
5. Bounded Adaptive Risk Multiplier.
6. Durable Decision and Outcome Feedback.

The change is deliberately pre-trade. Post-entry stop movement, take-profit changes, partial exits, autonomous model retraining, new instruments, and DEMO/LIVE promotion policy are separate future work.

## 1. Adaptive Market State Engine

### Purpose
Create one explicit market-state object for every candidate from causal M5/M15/H1/H4 evidence already available at decision time.

### States
The canonical state enum is:

- `TREND_HEALTHY`
- `TREND_EXTENDED`
- `TREND_WEAK`
- `RANGE`
- `TRANSITION`
- `REVERSAL`
- `HIGH_VOLATILITY`
- `DISLOCATED`
- `ROLLOVER_RISK`
- `UNKNOWN`

`REVERSAL` corresponds to the current confirmed-reversal family. `TRANSITION` corresponds to the current early-transition family. Existing persisted legacy regime labels remain readable for evidence compatibility; new decisions persist both the legacy route/regime and the adaptive canonical state.

### Inputs
Use only information whose `available_at` is no later than the candidate decision timestamp. Inputs may include:

- current Plan-B regime and strategy route;
- M5/M15/H1/H4 directional alignment;
- EMA separation and multi-timeframe strength;
- ATR-normalised extension and short-horizon momentum;
- volatility score and recent volatility percentile;
- RSI directional evidence;
- execution spread/cost evidence;
- session and rollover state;
- drift diagnostics.

No future candle, revised future state, later trade result, or retrospectively known macro outcome may affect the market-state result.

### Output
`AdaptiveMarketState` persists:

- `state`;
- `confidence` in the state, 0–1;
- `trendStrength`;
- `transitionScore`;
- `reversalScore`;
- `volatilityState`;
- `higherTimeframeAgreement`;
- `session`;
- `reasons[]`;
- `dataFreshness`;
- `artifact` and policy version.

State confidence is not trading confidence. It measures confidence that the state classification itself is stable.

### Fail-closed rules
Stale or incomplete higher-timeframe data yields `UNKNOWN` or a reduced state confidence. Severe drift, materially inconsistent timeframes, abnormal price gaps, or invalid spread evidence can produce `DISLOCATED`. `DISLOCATED`, `ROLLOVER_RISK`, and `UNKNOWN` cannot receive an upward risk multiplier.

## 2. Pair × Direction × Session × Regime Edge Matrix

### Purpose
Measure where iRexPro is actually demonstrating realised edge instead of treating all EURUSD BUY trades, for example, as one homogeneous population.

### Cell key
A matrix cell is keyed by:

`instrument | direction | session | adaptiveState | strategyRoute | decisionPolicyVersion`

Sessions use the same canonical UTC buckets as execution-cost calibration:

- `ASIA`
- `LONDON`
- `NEW_YORK`
- `ROLLOVER`

The decision policy version is part of the key so evidence from materially different policies is never silently pooled.

### Evidence
Each cell tracks resolved, causally tagged PAPER outcomes only:

- closed trades and effective sample size;
- wins and losses;
- smoothed win rate;
- realised R and average realised R;
- gross profit/loss and profit factor;
- evidence-window Sharpe;
- max drawdown;
- positive rolling-window fraction;
- average and median execution cost R;
- average slippage when available;
- average MFE and MAE in R;
- average profit give-back;
- calibration gap between submitted confidence and observed win rate;
- recent-vs-reference degradation;
- latest resolved outcome time.

Interrupted/manual/kill-switch/reconciliation closes remain censored for qualification and must not be silently treated as normal strategy wins or losses.

### Evidence hierarchy and shrinkage
Sparse cells must not create extreme scores. Use hierarchical shrinkage:

1. pair + direction + session + state + route;
2. pair + direction + session + route;
3. pair + direction + route;
4. route-wide PAPER evidence;
5. neutral prior.

The most specific cell receives increasing weight only as effective sample size grows. The first implementation uses deterministic empirical-Bayes-style shrinkage or an equivalent bounded weighted prior; it does not train a new predictive model.

### Maturity states
Cells expose:

- `SPARSE`
- `COLLECTING`
- `MATURE`
- `DEGRADED`

A cell cannot be `MATURE` before at least 20 resolved outcomes with both wins and losses represented. A degraded cell can demote ranking or risk before it becomes statistically mature when current hard risk evidence is poor, but sparse positive evidence must never increase authority.

## 3. Adaptive Opportunity Scorer

### Purpose
Rank all otherwise executable counterfactuals in the same scan using one transparent, cost-aware score.

### Candidate prerequisites
The scorer is downstream of existing hard eligibility. A candidate that fails a non-bypassable risk, event-risk, market-data, execution-cost, post-loss, episode, or account control cannot become executable merely because its adaptive score is high.

### Score components
For eligible or research-eligible candidates, compute a 0–1 `adaptiveOpportunityScore` from:

- 25% current net expected R quality;
- 15% regime/route fit;
- 12% direction quality;
- 10% trade quality;
- 8% exit feasibility;
- 10% pair/session/state realised-edge quality;
- 8% execution-cost quality;
- 7% currency/portfolio diversification quality;
- 5% recent stability/drift quality.

Weights are versioned constants in the first release. They are not autonomously changed by recent P&L.

Net expected R is the existing governance value after authoritative execution costs. The adaptive layer must never reconstruct a more favourable net expected R from a different spread source.

### Ranking semantics
- Rank candidates within the scan by `adaptiveOpportunityScore` after hard gates.
- Preserve BUY/SELL ambiguity protection: a pair with two nearly equal opposing edges can still abstain.
- Multiple instruments may execute in one scan when each independently passes governance and portfolio/currency capacity.
- Ranking is not a single-trade global cap. It decides priority when margin, exposure, or correlated-risk capacity is limited.
- Persist both the adaptive rank and the pre-adaptive counterfactual rank so performance can be compared.

## 4. Currency/Portfolio Exposure Intelligence

### Purpose
Prevent hidden concentration such as simultaneously treating EURUSD BUY, GBPUSD BUY and USDCHF SELL as unrelated trades when they all express material USD-short exposure.

### Exposure representation
Reuse the existing base/quote currency decomposition. For each open position and candidate:

- BUY base/quote adds long base and short quote exposure;
- SELL base/quote adds short base and long quote exposure.

Normalise exposure using risk-at-stop rather than raw ticket count. Lot size may be retained as a diagnostic, but risk contribution must be the primary authority because 1.0 lot with a tight stop is not equivalent to 1.0 lot with a wide stop.

### Portfolio outputs
Persist:

- currency risk map for USD, EUR, GBP, JPY, AUD, CAD and CHF;
- candidate incremental currency risk;
- largest aligned currency concentration;
- same-instrument directional exposure;
- shared-currency correlated exposure score;
- diversification quality;
- capacity state: `CLEAR`, `REDUCED`, or `BLOCKED`.

### Behaviour
In the first release, correlation means structural shared-currency risk (for example, several positions that all express USD-short risk). It does not introduce a rolling statistical pair-correlation model; that would require its own validated data and stability policy.

- Opposing currency exposure offsets only to the extent that authoritative risk-at-stop genuinely offsets.
- Splitting one economic exposure across many tickets cannot improve portfolio quality.
- A candidate that increases already-dominant currency exposure receives a lower score and may receive a reduced multiplier or block.
- This layer cannot increase the account-level risk allowance above the existing Risk Engine limits.

## 5. Bounded Adaptive Risk Multiplier

### Purpose
Let the best evidence-backed PAPER opportunities use more of their justified risk budget without using fixed arbitrary lots.

### Multiplier bands
The adaptive layer returns one of:

- `0.50x` — weak but still permitted research/normal edge;
- `0.75x` — below-neutral evidence or moderate concentration;
- `1.00x` — normal authoritative risk sizing;
- `1.10x` — mature, positive, stable edge with low concentration;
- `1.25x` — highest first-release multiplier for exceptional mature edge.

No first-release multiplier exceeds `1.25x`.

### Upsize eligibility
A multiplier above `1.00x` requires all of the following:

- normal PAPER authority, not rejected-edge canary;
- non-rollover session;
- market state not `UNKNOWN`, `DISLOCATED`, `HIGH_VOLATILITY`, or `ROLLOVER_RISK`;
- mature pair/direction/session/state evidence;
- positive smoothed expected R;
- profit factor at or above 1.15;
- max drawdown at or below 12%;
- no current degradation state;
- valid authoritative spread/cost evidence;
- positive current net expected R;
- portfolio capacity `CLEAR`;
- no hard governance blockers.

Research routes may be risk-sized up to their existing 1.0-lot safety ceiling but cannot receive an adaptive multiplier above `1.00x` in this release.

### Downsize behaviour
Negative or degraded adaptive evidence may reduce a permitted candidate to `0.50x` or `0.75x`. Hard blockers remain blockers; the multiplier is never used to turn a blocked trade into a small trade.

### PositionSizingService integration
`PositionSizingService` receives the existing allocation/risk inputs plus `adaptiveRiskMultiplier`. It computes base risk amount, applies the bounded multiplier, then continues through broker min/max/step, stop distance, margin, allocation, profile constraints and route lot ceiling. Persist both base and adjusted risk amounts.

## 6. Durable Decision and Outcome Feedback

### Decision metadata
Every evaluated candidate persists an `adaptiveMarketIntelligence` object containing:

- artifact/policy version;
- market state and state confidence;
- session;
- edge-cell key and maturity;
- cell evidence metrics;
- opportunity score and component scores;
- scan rank;
- currency exposure diagnostics;
- capacity state;
- adaptive risk multiplier;
- original and adjusted risk budget;
- active hard blockers;
- explicit reasons for rank and multiplier.

The object must be available in the durable ensemble decision ledger and copied into trade-intent metadata for executed signals.

### Outcome attribution
When a trade closes, the existing trade record remains the source of truth. The edge matrix resolves the original decision key against:

- realised R;
- realised P&L;
- close reason;
- execution cost/slippage evidence;
- MFE/MAE and give-back when available;
- duration;
- state persistence/change after entry.

No mutable row rewrites the original pre-trade evidence. Outcome aggregation is derived from immutable decision metadata plus authoritative trade outcomes.

## Data Flow

1. Scanner builds causal BUY/SELL candidates from the closed M5 snapshot and supporting timeframes.
2. Existing Plan-B scoring determines legacy regime/route and quality features.
3. Existing governance computes authoritative execution cost, net expected R, drift and blockers.
4. Adaptive Market State Engine produces the canonical state from evidence available at that timestamp.
5. Edge Matrix loader retrieves the causal historical cell and its hierarchical priors.
6. Currency/Portfolio Exposure Intelligence evaluates incremental risk concentration from current open positions plus the candidate.
7. Adaptive Opportunity Scorer assigns a transparent score and component breakdown.
8. Existing execution-route eligibility still decides whether the candidate may execute.
9. Eligible candidates are ranked; ambiguity and portfolio-capacity rules are applied.
10. Bounded Adaptive Risk Multiplier is calculated.
11. The emitted signal uses the classified adaptive state (or a documented compatibility mapping) for `marketRegime`; the current hard-coded `TRENDING` value is removed.
12. `PositionSizingService` computes the final lot under authoritative risk, stop, margin, broker and route-ceiling constraints.
13. Decision metadata is persisted before/with TradeIntent creation.
14. Closed outcomes later feed the matrix through cohort-safe aggregation.

## Database and Evidence Model
Prefer durable derived evidence over a second opaque model store.

The implementation may use either a dedicated aggregate table/materialized read model or bounded queries over the existing durable decision/trade ledger. The selected implementation must guarantee:

- cohort isolation by model/decision-policy version;
- timestamp-causal evidence;
- idempotent aggregation;
- no double-counted retries/duplicate intents;
- no mixing of PAPER with DEMO/LIVE outcomes;
- no mixing of qualification-excluded research cohorts into qualification evidence;
- deterministic recomputation from source records.

If a new table is introduced, migrations must be additive and rollback-safe; deployment cannot require destructive historical rewrites.

## Failure Handling

### Missing edge evidence
Use neutral/shrunk evidence. Never infer a positive edge from absence of data. Multiplier cannot exceed `1.00x`.

### Evidence query failure
Fail closed to `adaptiveRiskMultiplier <= 1.00x`. Normal existing execution may continue only if its original governance is otherwise valid and the adaptive layer is configured as non-mandatory for that route; metadata records `ADAPTIVE_EVIDENCE_UNAVAILABLE`.

### Stale portfolio snapshot
No upsize. If existing authoritative portfolio/risk logic requires the snapshot, preserve its existing fail-closed behaviour.

### Invalid market state
Return `UNKNOWN` or `DISLOCATED`; no upsize and no adaptive override of existing blockers.

### Cost disagreement
Authoritative existing governance cost wins. Adaptive intelligence never chooses the cheaper source.

### Database or persistence failure
Do not execute a trade whose adaptive decision cannot be durably tied to the TradeIntent when adaptive logic changed its ranking or multiplier. Execution must remain exactly-once and auditable.

## Observability
Add structured logs and operational counters for:

- state distribution by pair/session;
- edge-cell maturity distribution;
- adaptive score distribution;
- multiplier distribution;
- number of candidates down-sized/up-sized/unchanged;
- currency concentration blocks/reductions;
- old-rank vs adaptive-rank disagreements;
- realised R by adaptive score decile;
- realised R by multiplier band;
- realised R by state/session/pair/direction;
- evidence query failures and fail-closed events.

Admin/user surfaces can expose these later, but API metadata and durable evidence are required in the first release.

## Deployment And Active Authority

### Production application deployment
Deploy the completed, verified feature through the normal protected release pipeline to the production application. The active trading authority in this release remains PAPER-only; this wording does not grant broker DEMO/LIVE execution authority.

### Immediate active PAPER ranking
There is no observer-only rollout. On deployment, adaptive market state, shared-currency exposure and adaptive opportunity ranking actively select among candidates that already satisfy existing hard PAPER governance. The previous rank is still persisted as a counterfactual comparison, but it does not remain the execution authority.

### Immediate bounded PAPER sizing
On deployment, the adaptive multiplier may actively reduce permitted risk to `0.50x` or `0.75x` or leave it at `1.00x`. A multiplier above `1.00x` is active only when the already-specified mature positive-edge requirements are satisfied. Research routes remain capped at `1.00x` multiplier and the 1.0-lot research ceiling.

### Activity objective, not forced cadence
The scanner continues evaluating every closed M5 opportunity cycle and must persist the best ranked opportunity and explicit abstention reason for every scan. The system does not force a trade every 2, 5 or 10 minutes. A frequency target cannot override negative net expected R, OOD/dislocated state, invalid cost evidence, event risk, post-loss confirmation, margin or portfolio-capacity controls. Productive activity comes from finding more genuinely positive post-cost opportunities and avoiding unnecessary suppression.

### Review for DEMO
No automatic transition. DEMO review requires the existing qualification gates plus a dedicated comparison showing adaptive policy performance, drawdown, calibration, cost burden and portfolio concentration are acceptable. LIVE remains a separate explicit approval stage.

## Testing Strategy

### Pure unit tests
- canonical regime/state classification boundaries;
- causal timestamp/freshness handling;
- hierarchical edge shrinkage;
- sparse evidence cannot upsize;
- degraded evidence cannot upsize;
- score monotonicity for higher net expected R with other inputs equal;
- worse execution cost cannot improve score;
- currency exposure sign math for all six pairs and BUY/SELL;
- split-ticket invariance;
- opposite exposure offsets only genuine risk;
- multiplier band thresholds;
- research routes never exceed `1.00x` multiplier;
- rollover/dislocated/unknown never upsize.

### Integration tests
- full collector path persists adaptive metadata and no longer emits a hard-coded `TRENDING` regime;
- two executable candidates are reordered by mature evidence without bypassing either candidate's governance;
- correlation capacity can reduce/block the lower-priority candidate;
- selected candidate passes multiplier to PositionSizingService;
- final lot remains bounded by stop-distance risk, margin, broker step/min/max and route ceiling;
- retries do not duplicate edge outcomes or TradeIntents;
- evidence-store failure fails closed without fabricating edge;
- historical outcomes from another policy version do not leak into the active cell.

### Regression tests
All existing PAPER research, calibrated-cost rescue, route reliability, pair-side reliability, Plan-B ensemble, governance, risk, position-sizing, execution and promotion tests must remain green.

## Performance Constraints
The scanner cadence must not be materially delayed by adaptive evidence queries. Evidence should be pre-aggregated or cached where necessary, with deterministic cache keys including policy version and latest resolved-outcome watermark. Stale cache must never produce higher authority than the underlying evidence permits.

## Security and Authority Boundaries
- No secrets or broker credentials enter adaptive metadata.
- No direct broker execution is added.
- No DEMO/LIVE authority is granted.
- No event-risk bypass is added.
- No hard risk limit is relaxed.
- No qualification metric is rewritten.
- No historical backfill is allowed to masquerade as prospective evidence.
- No autonomous strategy-weight mutation occurs from recent profit/loss.

## Success Criteria
The first complete release is successful when:

1. Every six-pair candidate has a causal, persisted adaptive market-state object, and executed signals no longer report a hard-coded `TRENDING` regime.
2. Every candidate has a versioned pair/direction/session/state edge assessment with explicit maturity.
3. Executable candidates receive a transparent adaptive opportunity score and component breakdown.
4. Currency concentration is assessed using economic risk rather than ticket count alone.
5. Adaptive ranking is the active PAPER selection authority immediately after deployment and cannot bypass existing execution gates.
6. Normal PAPER immediately uses `0.50x`, `0.75x`, or `1.00x` as justified; `1.10x–1.25x` is active only under mature positive evidence, and research cannot exceed `1.00x` multiplier.
7. PositionSizingService remains final authority and the 1.0-lot PAPER research safety ceiling remains intact for this release.
8. Every adaptive decision and resulting trade is auditable end-to-end.
9. Sparse, stale, unavailable or conflicting evidence cannot increase execution authority.
10. Existing qualification gates remain unchanged: balanced accuracy >= 0.52, evidence-window Sharpe >= 1.0, profit factor >= 1.15, max drawdown <= 12%, positive window fraction >= 60%, positive instrument fraction >= 67%, confidence >= 60%, and at least 100 qualifying closed trades.
11. The adaptive policy produces prospective PAPER evidence that can be compared directly with the prior selection/sizing policy before any DEMO review.

## Explicit Non-Goals
This design does not include:

- a promise of profitability;
- fixed 1-lot trading regardless of risk;
- >1.0-lot PAPER research authority;
- new forex instruments outside the existing six majors;
- reinforcement learning or self-modifying production weights;
- LLM authority to place trades;
- post-entry stop/TP optimisation;
- news prediction from untrusted sources;
- automatic DEMO or LIVE promotion.
