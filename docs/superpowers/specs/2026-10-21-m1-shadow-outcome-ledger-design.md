# M1 Shadow Outcome Ledger Design

## Intent

iRexPro needs evidence about whether the existing M1 tactical routes would have produced useful outcomes **without re-enabling M1 PAPER execution**. The goal is to turn the current SHADOW decisions into prospective, causal, independently-counted outcome evidence so a later promotion decision can be made from data rather than from raw candidate volume.

Success for this phase means iRexPro can answer: “How many independent M1 opportunities did we observe, what happened over the next causal 15 completed M1 bars, and how did each route/pair/side perform?” while keeping M1 execution authority at `NONE`.

## Scope

This phase will:

- settle governance-clean M1 SHADOW candidates prospectively from future completed M1 candles;
- collapse correlated minute-by-minute candidates into independent episode leaders before counting evidence;
- persist versioned shadow outcomes separately from real execution outcomes;
- expose route/pair/side metrics in R-multiples for later promotion analysis;
- fail closed when future candle history is incomplete or ambiguous;
- preserve all existing M5 thresholds, M1 rollout phase, sizing, risk, and broker execution behavior.

This phase will **not**:

- switch M1 from `SHADOW` to `PAPER_CONTINUATION` or `PAPER_ALL_ROUTES`;
- lower any model, consensus, drift, event-risk, net-edge, or execution threshold;
- create synthetic trades, trade intents, broker orders, or realised P&L;
- define the eventual minimum sample count or promotion threshold for an M1 canary;
- use stale historical provider candles to manufacture retrospective evidence;
- add UI promotion controls.

## Existing Foundations

The implementation must build on the existing M1 subsystem rather than create a parallel engine:

- `trading.m1_tactical_decisions` already stores immutable candidate, governance, blockers, policy version, execution authority, and real execution linkage.
- `M1TacticalEvidenceService` already persists decisions idempotently and appends non-execution observations into `governance` with `jsonb_set`.
- `M1TacticalMarketDataService` already supplies the current causal M1/M5/M15/H1/H4 window and preserves broker-native versus PAPER-provider authority rules.
- `evaluateM1DriftCounterfactual15m()` already proves the required causal semantics: first future M1 bar open as entry, exactly 15 contiguous completed bars, TP/SL first-hit handling, and `AMBIGUOUS` when stop and target are both touched in the same candle.
- `M1TacticalSchedulerService` already receives the current 60-bar M1 window and settles mature counterfactual observations without modifying execution.

## Architecture

### 1. A generic causal M1 outcome resolver

Extract the candle-settlement mechanics from the drift-specific counterfactual into a small pure module, `m1-causal-outcome.ts`.

It accepts direction, evaluation time, stop distance, target distance, estimated execution cost R, and completed M1 bars. It uses the first M1 bar opening one minute after the decision as the hypothetical entry and requires exactly 15 contiguous causal M1 bars.

The resolver returns one of:

- `TP` — target touched before stop;
- `SL` — stop touched before target;
- `MTM` — neither boundary touched; mark to the 15th bar close;
- `AMBIGUOUS` — both stop and target touched in the same candle and fill order is unknowable.

`AMBIGUOUS` never receives an invented R result. Missing, stale, non-contiguous, or invalid candles return no result. The existing drift counterfactual will delegate to this resolver so its current behavior and artifact contract remain unchanged.

### 2. Independent episode leaders

Raw M1 SHADOW decisions are not independent samples. One market setup can persist for several consecutive minute bars. Evidence counting therefore uses **episode leaders**, not raw decision rows.

A decision is eligible to lead a shadow episode only when:

- `route <> 'ABSTAIN'`;
- `execution_authority = 'NONE'`;
- its blockers contain no blocker other than `M1_PHASE_SHADOW` (zero blockers is also acceptable);
- it belongs to the active M1 policy version;
- it does not already contain the current shadow-outcome artifact.

For the same user, broker connection, instrument, direction, route, and policy version, consecutive eligible decisions belong to one episode while the gap between them is **5 minutes or less**. The first decision after a gap greater than 5 minutes is the next episode leader. The raw decisions remain unchanged; episode identity is derived from persisted decision chronology so one continuous signal cannot inflate the evidence count.

### 3. Versioned shadow outcome persistence

Real execution fields (`outcome_state`, `outcome_reason`, `signal_id`, `trade_intent_id`) keep their existing meaning and are not reused.

Shadow evidence is appended to the leader decision’s `governance` JSON under the versioned key:

`shadowOutcome15mV1`

The stored object contains:

- `artifact: 'm1-shadow-outcome-15m-v1'`;
- `modifiesExecution: false`;
- episode leader decision id and episode start bar time;
- route, pair, side, and policy version;
- source/authority metadata;
- causal entry/terminal bar times and prices;
- stop and target prices;
- estimated execution cost R;
- outcome (`TP`, `SL`, `MTM`, `AMBIGUOUS`, or `UNOBSERVABLE_DATA_GAP`);
- gross and net R when observable;
- observation timestamp.

Writes are idempotent: once `shadowOutcome15mV1` exists, later scheduler cycles do not replace it.

### 4. Settlement timing and restart behavior

The scheduler may attempt settlement only after the 15-bar causal horizon has matured. It reuses the current 60-bar M1 window already supplied by the M1 market-data path.

If the full causal window is not yet available, the leader remains pending. If the leader becomes older than the available 60-minute M1 history and a complete contiguous causal window still cannot be reconstructed, it is finalized as `UNOBSERVABLE_DATA_GAP` with no R result.

This is the restart rule: a restart or provider gap is never filled by inference. Unverifiable episodes are visible as missing evidence and excluded from profitability metrics.

### 5. Shadow evidence metrics

`M1TacticalEvidenceService` will expose filtered shadow metrics by route, instrument, direction, policy version, and time window. Metrics count only episode leaders with the current shadow artifact.

The result includes:

- total episode leaders;
- evaluable episodes (`TP`, `SL`, `MTM`);
- ambiguous episodes;
- unobservable data-gap episodes;
- positive, negative, and flat evaluable outcomes;
- cumulative net R and average net R;
- gross positive R and absolute gross negative R;
- profit factor when defined;
- maximum drawdown in R over chronological evaluable outcomes.

`AMBIGUOUS` and `UNOBSERVABLE_DATA_GAP` are excluded from P&L-style metrics but remain in coverage counts. No metric in this phase changes execution authority.

## Data Flow

1. The M1 scheduler evaluates the current pair exactly as it does today and persists raw decisions.
2. After current-bar persistence, it asks the evidence service for mature episode leaders for that pair and active policy version.
3. The scheduler passes each leader plus the already-loaded causal M1 bar window to the pure outcome resolver.
4. Observable results are persisted under `governance.shadowOutcome15mV1`.
5. Mature leaders that can no longer be causally reconstructed from the 60-bar window are persisted as `UNOBSERVABLE_DATA_GAP`.
6. Metrics queries read only versioned leader outcomes; raw decision counts never substitute for episode counts.

## Safety and Failure Semantics

- Every new artifact states `modifiesExecution: false`.
- The rollout policy remains `M1_TACTICAL_ROLLOUT_POLICY_V1` / `SHADOW` / authority `NONE`.
- The scheduler never calls `AiSignalService.receiveSignal()` because of shadow outcome evidence.
- Missing database evidence, invalid JSON, incomplete candles, or timing gaps fail closed and cannot produce a positive outcome.
- Same-candle TP/SL contact is `AMBIGUOUS`, not a guessed win or loss.
- Real execution outcomes and shadow outcomes remain semantically separate.
- The current M5 engine and six-pair scanner are untouched by this phase.

## Testing Strategy

Pure resolver tests must prove BUY/SELL TP, SL, MTM, same-bar ambiguity, first-causal-open semantics, exact 15-bar contiguity, and invalid-price rejection.

Evidence-service tests must prove episode collapsing across consecutive minute decisions, a new leader after a gap greater than 5 minutes, phase-only eligibility, exclusion of drift/edge/event blockers, idempotent persistence, current-artifact filtering, and metrics that exclude ambiguous/unobservable outcomes from profit factor.

Scheduler tests must prove mature leader settlement in SHADOW, retry while a causal window may still arrive, `UNOBSERVABLE_DATA_GAP` after the 60-bar observability boundary, and—most importantly—no signal/trade dispatch or rollout-policy change.

Existing drift-counterfactual tests must remain green after the resolver extraction.

## Rollout

This ships as a PAPER-research observability change only. After deployment, the ledger must accumulate prospective independent episode evidence before any separate proposal to enable an M1 PAPER canary. Promotion criteria will be designed from the resulting episode distribution and existing iRexPro portfolio-quality gates; they are intentionally outside this phase so the system does not invent a threshold before it has evidence.
