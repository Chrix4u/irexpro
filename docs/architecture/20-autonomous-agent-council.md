# Autonomous Agent Council — Context Intelligence Foundation

Status: Proposed foundation (paper/UAT only)

## Why

iRexPro already has a quantitative signal engine, deterministic Risk Engine,
broker execution boundaries, model governance, Decision Explorer, and an
explanation-only Copilot. The next useful step toward a genuinely autonomous
trading agent is not to let an LLM replace those controls. It is to add
specialist context agents that challenge and enrich the quantitative signal
while preserving deterministic execution authority.

## Council roles

1. Quant Agent (existing)
   - MTF XGBoost remains the fast numerical signal authority.
   - Produces direction, model confidence, market-data revision, and governance metadata.

2. Macro & News Context Agent (new/future)
   - Reads trusted, timestamped forex-relevant sources: central-bank releases,
     high-impact economic calendar events, reputable financial news, and later
     carefully filtered sentiment feeds.
   - Produces structured evidence only: stance, confidence, credibility,
     freshness, verified-source count, and concise rationale.
   - Never holds broker credentials and never submits orders.

3. Regime Agent (upgrade)
   - Expands the current trending/ranging/volatile telemetry with session,
     spread/liquidity, cross-pair correlation, and event-proximity context.
   - Starts deterministic; learned regime models require their own validation.

4. Risk Guardian (existing authority)
   - NestJS Risk Engine remains authoritative for leverage, position size,
     daily loss, drawdown, trade frequency, stop geometry, liquidity and kill switch.
   - No LLM or context agent may weaken or bypass a hard constraint.

5. Execution Agent (existing authority)
   - Broker adapter/execution engine owns order submission, acknowledgement,
     reconciliation, close, and audit.
   - Specialist agents never call brokers directly.

6. Reflection Agent (new/future)
   - Creates structured post-trade records from outcomes, regime, context,
     friction, model confidence and risk decisions.
   - Reflection may propose research hypotheses; it cannot self-modify the
     production strategy or promote a model.

7. Coordinator / Agent Council (this foundation)
   - Combines specialist evidence deterministically.
   - Explicitly surfaces alignment, conflict, insufficient context and
     credible block conditions.
   - Remains advisory until separately reviewed paper/UAT integration is validated.

## Evidence contract

Every contextual observation must include instrument, source class and stable
source id, observed timestamp, available-at timestamp, stance, confidence,
source credibility, verified-source count, and a concise factual summary.

The available-at contract is mandatory to prevent future-information leakage
in historical evaluation, matching the causality discipline already used by
the MTF corpus.

Before weighting, the coordinator also applies a fail-closed acceptance layer:

- wrong-instrument, stale and future-dated evidence is rejected;
- `MACRO_NEWS` evidence must declare at least one verified source;
- duplicate `(source, source_id)` evidence cannot be counted twice;
- invalid coordinator thresholds are rejected instead of silently changing
  the classification semantics.

Phase B adds the stronger external source-trust registry, content/event
deduplication and provenance validation around these foundation guarantees.

## Safety invariants

- The council has execution_authority=false.
- Context evidence cannot contain broker credentials.
- No direct LLM-to-broker path.
- No self-generated code may execute in the trading runtime.
- No online parameter/model mutation without offline research, untouched
  evaluation, governance metadata and promotion gates.
- Stale, future-dated, wrong-instrument or unverifiable context is rejected.
- Duplicate evidence cannot amplify council support or opposition.
- Missing context never fabricates confidence; it yields INSUFFICIENT.
- A BLOCKED context result does not itself close/open trades; Risk and
  Execution remain authoritative.
- Store concise evidence and rationale, not hidden model chain-of-thought.

## Planned rollout

Phase A — foundation
- typed evidence/assessment contracts;
- deterministic coordinator;
- causality/freshness/credibility and duplicate-suppression tests;
- architecture documentation.

Phase B — trusted forex context
- economic calendar ingestion;
- central-bank / macro release ingestion;
- source trust registry and event/content deduplication;
- event proximity windows;
- paper-only context snapshots in Decision Explorer.

Phase C — context fusion evaluation
- build historical available-at context corpus;
- test context as features/veto signals without leaking future information;
- measure incremental Sharpe, precision, drawdown, turnover and calibration
  versus the quant-only baseline;
- promote only if untouched evaluation improves without weakening risk gates.

Phase D — reflection memory
- post-trade structured outcome ledger;
- recurring error-pattern analysis;
- hypothesis generation for offline research;
- no automatic production strategy rewriting.

Phase E — paper/UAT agent council
- expose specialist opinions and disagreement in the UI;
- allow validated context policy to veto/no-trade or require stronger
  quantitative confidence;
- Risk Engine remains final authority.

## Non-goals

This foundation does not add reinforcement-learning execution, online
self-modification, social-media-driven live trading, or LLM-generated position
sizing. Those ideas require separate evidence and governance before even paper
activation.
