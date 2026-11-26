# iRexPro AI V2 — Execution Backlog (Research Program)

**Branch:** `research/ai-v2-challenger-architecture-20261127`
**Status:** research-only backlog. Nothing below authorizes execution, deployment, broker contact or production change; every workstream is individually reviewed and gated. Deployment hold remains active.

Workstreams are ordered by dependency, not priority. "R" = research-only (no runtime impact); "E" = engineering on isolated challenger paths only; "G" = gated (requires pre-registered acceptance criteria + independent review).

---

## WS0 — Foundation (this branch, DONE)

- [x] Full-engine audit findings (`V2_ENGINE_AUDIT_FINDINGS.md`) — component inventory, defect register D-01..D-05, economic/calibration evidence.
- [x] Architecture proposal (`V2_ARCHITECTURE_PROPOSAL.md`) — P1–P10 principles, L0–L6 layers.
- [x] Champion-Challenger DEMO evaluation design (`V2_CHAMPION_CHALLENGER_DEMO_EVALUATION_DESIGN.md`).
- [x] Evaluation-metrics engine + tests (23 tests total, synthetic fixtures, `v2-*.cjs`).
- [x] CI wiring for the three research suites.

## WS1 — Evidence ledger contract (R→E, prerequisite for everything)

| ID | Task | Acceptance criteria | Coordination |
|---|---|---|---|
| 1.1 | Specify the V2 decision-record schema (C1–C6) as a versioned JSON schema | Schema validates all synthetic fixtures; contract tests green | Builds on #834 evidence coverage |
| 1.2 | Supersede-counting persistence design (never first-write-wins) | Design review; migration sketch for a research-side table (no production table changes) | Fixes D-04 documented defect |
| 1.3 | Outcome-linkage spec: settled fill ↔ decision SHA join contract | Round-trip test on synthetic ledger | Mirrors `order_fill_evidence` pattern |

## WS2 — Calibration program (R, core of the Challenger)

| ID | Task | Acceptance criteria |
|---|---|---|
| 2.1 | Calibrator-in-bundle format: isotonic/Platt serialized, SHA-pinned, load-verified | Load-time verification demo on synthetic bundle |
| 2.2 | Purged chronological calibration pipeline for the outcome model | Purge ≥ horizon; inner-window-only fit; leakage tests |
| 2.3 | Calibration monitoring series (Brier/ECE/reliability over time) | Report on synthetic drift fixture |
| 2.4 | Predicted-vs-realized cost model calibration (commission-inclusive) | Detects the documented 3× understatement case in fixture |

## WS3 — Exit-intelligence research (R; measured top economic lever)

| ID | Task | Acceptance criteria |
|---|---|---|
| 3.1 | Exit state machine spec with single precedence order | Spec review; no emergent-authority paths |
| 3.2 | Pre-registered hold-vs-close counterfactual shadow spec (+1/+15/+60 min, first-touch brackets) | Protocol frozen before any data is examined; fixture tests |
| 3.3 | Profit-retention ladder re-derivation vs measured +0.42R protected class | Analysis doc; no threshold adopted without Stage-1 shadow |
| 3.4 | Partial-close (scale-out) representability design | Ledger + close-path spec; no dispatch authority |
| 3.5 | Inherit corpus open questions (5m-guard value, evening scarcity, hour harmonics) as pre-registered experiments | Each has a written hypothesis + power statement |

## WS4 — Entry-intelligence research (R)

| ID | Task | Acceptance criteria |
|---|---|---|
| 4.1 | Single decision-core model design (outcome distribution, one confidence semantics) | Design doc + fixture inference demo |
| 4.2 | Route labels demoted to features/regime inputs (no rule ladders) | Analysis showing route-conditional effects as covariates |
| 4.3 | Drift/OOD runtime gate design (PSI/KS vs frozen manifest) | Gate fires on synthetic shifted fixture |
| 4.4 | M1 abstention six-slot record integration into decision core | Reuses #836/#837 taxonomy verbatim |

## WS5 — DEMO evaluation infrastructure (E→G)

| ID | Task | Acceptance criteria |
|---|---|---|
| 5.1 | Engine-identity + account-isolation provisioning runbook (two Pepperstone cTrader DEMO accounts) | Runbook review; credentials/identifiers stay out of repo |
| 5.2 | Attribution-ledger implementation (append-only, engine-bound) | Immutability + ownership tests green (mirror of `v2-champion-challenger-attribution.cjs` invariants) |
| 5.3 | Comparative dashboard (metrics from `v2-evaluation-metrics.cjs`) | Blocks on equivalence/sufficiency; never declares a winner |
| 5.4 | Stage-2 paired-run protocol execution (owner-authorized) | Pre-registered thresholds frozen; sufficiency ≥100 settled/engine before any verdict |
| 5.5 | Stage-3 independent review package | Frozen artifacts + ledger + reports; manual DEMO-only decision only |

## WS6 — Operational hygiene from the audit (E, low risk, high value)

| ID | Task | Acceptance criteria |
|---|---|---|
| 6.1 | Fix or delete `bounded_final_campaign.py` broken v41/v42 imports | Import fails closed with clear error, or module removed |
| 6.2 | `before`-cursor contract honored by cTrader/OANDA adapters (or explicit `UNSUPPORTED`) | Adapter test proves no silent latest-bars return |
| 6.3 | Per-row candle provenance preserved through the internal API | Mixed-provenance guard becomes reachable |
| 6.4 | Eviction/size cap for the adaptive calibration cache | Bounded-memory test |

*WS6 items are candidates for ordinary engineering PRs to `main`; they do not belong to the V2 research branch and each is independently reviewable.*

---

## Milestones

- **M1 (research contract frozen):** WS1.1, WS2.1–2.2, WS3.2 protocol pre-registered. Exit: schemas + protocols under review; nothing executed.
- **M2 (offline Challenger):** WS2.3–2.4, WS4.1–4.3 complete on synthetic/authorized-anonymized data; Stage-0 replay report issued.
- **M3 (shadow Challenger):** Stage-1 shadow on live feed; decision-record violations = 0 for a full pre-registered window.
- **M4 (paired DEMO):** WS5.1–5.4 executed with owner authorization; broker-confirmed paired report under equivalence.
- **M5 (verdict review):** Stage-3 package; independent reviewers; manual DEMO-only decision. LIVE is out of scope for this program.

## Risks and standing constraints

- No authorized row-level feature export has been analyzed (carried limitation from #838); Stage-0 replay depends on separately authorized anonymized exports.
- The Champion is never modified; all Challenger work stays on isolated research paths.
- Every threshold in this backlog is pre-registered before the data window that could invalidate it.
- Deployment hold `DEPLOY-HOLD-ACTIVE-BROKER-20261122.txt` remains intact throughout.
