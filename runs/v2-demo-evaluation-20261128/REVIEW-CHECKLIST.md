# iRexPro V2 Challenger — DEMO evaluation environment review checklist

Scope: OFFLINE evaluation only. P5 (broker-connected DEMO) is blocked and
nothing in this environment connects to, provisions or authorizes a broker.

## Environment assertions (fail-closed assembly)

- [x] R1 account isolation: asserted (research stub connections A/B).
- [x] R2 engine identities: champion `V1-CHAMPION-MIRROR` and challenger `V2-CHALLENGER`, generation 1 frozen, authority RESEARCH_SHADOW.
- [x] R4 equivalent starting conditions: balance 50000, leverage 30, instruments EURUSD, identical cost basis.
- [x] R5/R6 ledger: append-only, duplicate-refusing; dashboard derived from it.

## What the reviewer should verify

1. Reproduce byte-identically: `node apps/api/scripts/research/v2-demo-evaluation-run.cjs --seed 20261128` and compare the SHA-256 hashes printed by both runs.
2. Open `comparative-dashboard.html`: every figure must trace to `attribution-ledger.jsonl` or the campaign metric objects.
3. Confirm the four broker-evidence verification checks in the dashboard's section 3 (net total, balance chain, realized match, duplicate guard).
4. Confirm the null campaign's false-positive rates are at or below the 5% nominal.
5. Confirm the known-edge campaign recovers the planted AUCs within stated uncertainty.
6. Confirm the exit-dominance attribution shares meet the >= 90% acceptance.
7. Confirm the champion baseline mirror constants equal the audited S1 constants (see the frozen canary test).

## Binding limits

- All engine comparisons are synthetic; no profitability claim is derivable.
- The only real performance datum is the V1 broker evidence window (reported as-is, negative).
- V2 is NOT promoted to LIVE; V1 remains the baseline; P5 stays blocked on this review.
