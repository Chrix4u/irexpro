# Autonomous Agent Council — Context Intelligence

Status: Phase A merged; Phase B trusted-context foundation in progress (paper/UAT only)

## Why

iRexPro already has a quantitative signal engine, deterministic Risk Engine,
broker execution boundaries, model governance, Decision Explorer, and an
explanation-only Copilot. The next useful step toward a genuinely autonomous
trading agent is not to let an LLM replace those controls. It is to add
specialist context agents that challenge and enrich the quantitative signal
while preserving deterministic execution authority.

## Council roles

1. Quant Agent
   - MTF XGBoost remains the fast numerical signal authority.
   - Produces direction, model confidence, market-data revision, and governance metadata.

2. Macro & News Context Agent
   - Reads trusted, timestamped forex-relevant sources: central-bank releases,
     high-impact economic calendar events, reputable financial news, and later
     carefully filtered sentiment feeds.
   - Produces structured evidence only: stance, confidence, credibility,
     freshness, verified-source count, and concise rationale.
   - Never holds broker credentials and never submits orders.

3. Regime Agent
   - Expands the current trending/ranging/volatile telemetry with session,
     spread/liquidity, cross-pair correlation, and event-proximity context.
   - Starts deterministic; learned regime models require their own validation.

4. Risk Guardian
   - NestJS Risk Engine remains authoritative for leverage, position size,
     daily loss, drawdown, trade frequency, stop geometry, liquidity, and kill switch.
   - No LLM or context agent may weaken or bypass a hard constraint.

5. Execution Agent
   - Broker adapter/execution engine owns order submission, acknowledgement,
     reconciliation, close, and audit.
   - Specialist agents never call brokers directly.

6. Reflection Agent
   - Creates structured post-trade records from outcomes, regime, context,
     friction, model confidence, and risk decisions.
   - Reflection may propose research hypotheses; it cannot self-modify the
     production strategy or promote a model.

7. Coordinator / Agent Council
   - Combines specialist evidence deterministically.
   - Explicitly surfaces alignment, conflict, insufficient context, and
     credible block conditions.
   - Remains advisory until separately reviewed paper/UAT integration is validated.

## Evidence contract

Every contextual observation must include instrument, source class and stable
source id, observed timestamp, available-at timestamp, stance, confidence,
source credibility, verified-source count, and a concise factual summary.

The available-at contract is mandatory to prevent future-information leakage
in historical evaluation, matching the causality discipline already used by
the MTF corpus.

Before weighting, the coordinator applies a fail-closed acceptance layer:

- `QUANT` evidence is rejected by the context list because the quant signal is
  already supplied explicitly; this prevents model self-reinforcement.
- Wrong-instrument, stale, and future-dated evidence is rejected.
- `MACRO_NEWS` evidence must declare at least one verified source.
- Duplicate `(source, source_id)` evidence cannot be counted twice, including
  case/whitespace variants.
- Credential-like keys are recursively rejected from evidence metadata,
  including snake_case, kebab-case, and camelCase forms.
- Non-finite or zero/negative coordinator thresholds are rejected instead of
  silently changing classification semantics.
- Equal directional support and opposition is `CONFLICT` with neutral
  consensus, never `ALIGNED`.

## Phase B.1 trusted-context foundation

The first Phase B layer is provider-neutral and deterministic. It does not make
external network calls and does not grant context any execution authority.

Implemented in this phase:

- Explicit source-trust registry with source type, immutable currency coverage,
  credibility, enable/disable state, optional corroboration requirement, and
  independence groups so aliases of one upstream source cannot fake corroboration.
- Default primary-source coverage for the currencies used by the six-major-pair
  research universe.
- Provider-normalized macro event contract with separate `observed_at`,
  `available_at`, and `scheduled_for` timestamps.
- Canonical event-family identity and cross-source fingerprinting so duplicate
  calendar observations do not amplify a council vote.
- Causal historical filtering: an event is invisible before its recorded
  `available_at`.
- Revision-aware replay: for each provider event id, only the latest revision
  known at the evaluation time is eligible. Later downgrades, reschedules, and
  cancellations supersede earlier observations without leaking future updates.
- Same-timestamp conflicting revisions fail closed instead of depending on
  input ordering.
- Deterministic, bounded high-impact event proximity windows that produce fresh
  advisory `BLOCK` evidence only when the event is relevant to the traded pair.
- Corroboration enforcement counts independent provenance groups rather than
  raw source aliases.
- Fresh derived evidence at each evaluation time so a calendar item learned
  earlier does not become artificially stale while its event-risk window is active,
  while original source observation/availability timestamps remain in audit metadata.

Still separate from this phase:

- HTTP/API adapters for external calendar, central-bank, statistics, or news sources.
- Directional interpretation of released macro values or news text.
- Persistence and replay of historical context snapshots.
- Decision Explorer API/UI projection of council context.
- Any use of council context as a paper/UAT eligibility policy.
- Any live-trading authority.

## Safety invariants

- The council has `execution_authority=false`.
- Context evidence cannot contain broker credentials; credential-like metadata
  keys are rejected at schema validation.
- No direct LLM-to-broker path.
- No self-generated code may execute in the trading runtime.
- No online parameter/model mutation without offline research, untouched
  evaluation, governance metadata, and promotion gates.
- Stale, future-dated, wrong-instrument, or unverifiable context is rejected.
- The explicit quant signal cannot be reintroduced as context to amplify its own vote.
- Duplicate evidence cannot amplify council support or opposition.
- Missing context never fabricates confidence; it yields `INSUFFICIENT`.
- Equal directional support/opposition is `CONFLICT` with neutral consensus.
- A `BLOCKED` context result does not itself close/open trades; Risk and
  Execution remain authoritative.
- Store concise evidence and rationale, not hidden model chain-of-thought.

## Rollout

### Phase A — foundation
- typed evidence/assessment contracts;
- deterministic coordinator;
- causality/freshness/credibility and duplicate-suppression tests;
- architecture documentation.

### Phase B — trusted forex context
- trusted source and macro-event primitives;
- economic calendar adapters;
- central-bank / macro release adapters;
- source trust registry and event/content deduplication;
- event proximity windows;
- paper-only context snapshots in Decision Explorer.

### Phase C — context fusion evaluation
- build historical available-at context corpus;
- test context as features/veto signals without leaking future information;
- measure incremental Sharpe, precision, drawdown, turnover, and calibration
  versus the quant-only baseline;
- promote only if untouched evaluation improves without weakening risk gates.

### Phase D — reflection memory
- post-trade structured outcome ledger;
- recurring error-pattern analysis;
- hypothesis generation for offline research;
- no automatic production strategy rewriting.

### Phase E — paper/UAT agent council
- expose specialist opinions and disagreement in the UI;
- allow validated context policy to veto/no-trade or require stronger
  quantitative confidence;
- Risk Engine remains final authority.

## Non-goals

This work does not add reinforcement-learning execution, online
self-modification, social-media-driven live trading, or LLM-generated position
sizing. Those ideas require separate evidence and governance before even paper
activation.
