# iRexPro — Champion-Challenger DEMO Evaluation Design (Research-Only)

**Branch:** `research/ai-v2-challenger-architecture-20261127`
**Status:** design specification. No account has been opened, connected, or contacted. No broker order, credential, database access or production change exists in this branch.

---

## 1. Purpose

The comparative testing environment for AI V1 (Champion) vs AI V2 (Challenger) is **isolated, broker-connected Pepperstone cTrader DEMO accounts** — not internal paper trading. Historical replay and offline validation are preliminary stages only. The decisive stage measures **broker-confirmed DEMO outcomes**: actual reported costs, execution quality, drawdown and consistency.

Executable invariants for this design live in `apps/api/scripts/research/v2-champion-challenger-attribution.cjs` (+7 tests, synthetic fixtures only).

## 2. Isolation model

### 2.1 Accounts and engine identities

| Property | Champion | Challenger |
|---|---|---|
| Engine identity | `AI-V1-CHAMPION` (frozen production engine, untouched) | `AI-V2-CHALLENGER` (research engine, isolated code path) |
| Role | CHAMPION | CHALLENGER |
| Account | Pepperstone cTrader DEMO account A (existing or newly opened) | Pepperstone cTrader DEMO account B (**separate** account, separate login) |
| Account type | DEMO only (LIVE impossible by design) | DEMO only |

Each engine identity carries: `engineId`, `role`, `accountRef`, `accountCurrency`, `startingBalance`, `leverage`, `instruments`, `windowStart`/`windowEnd`, `engineVersion`, `decisionPolicySha` (hash of the frozen decision policy), `costModel` (versioned). `defineEngineIdentity` rejects any identity missing these fields or with `accountType != DEMO`.

### 2.2 Equivalent starting conditions (verified before any comparison)

`verifyEquivalentConditions` requires all of: equal starting balance; equal account currency; equal leverage; identical instrument set; identical evaluation window; both DEMO; equal cost model; **and distinct accounts** (isolation is itself a condition — if both engines somehow share an account, comparison is blocked). A failed equivalence check blocks the comparative dashboard entirely (`STARTING_CONDITIONS_NOT_EQUIVALENT`).

Equivalence is **re-verified at report time**, not just at setup — balance drift caused by trades is expected (it is the measurement), but the *starting* conditions must have been equal and the ledger must show both engines consumed the same cost model version.

### 2.3 Independent position ownership

- Every position opened by an engine is owned by that engine's identity for its whole life. The attribution ledger binds each fill to exactly one `engineId` + `accountRef`.
- `requestClose({engineId, tradeId})` is **rejected** when the requesting engine is not the owning engine (`CROSS_ENGINE_CLOSE_REJECTED`). V1's cross-strategy churn incident (one guard closing, another re-entering 91 s later) is structurally impossible.
- Engine-account binding: a fill posted to an account that does not match its engine's registered account is rejected (`ENGINE_ACCOUNT_MISMATCH`).
- Each engine sees only its own positions, equity and history. No shared session, no shared scanner, no shared cooldown state.

### 2.4 Immutable performance attribution

- **Append-only attribution ledger**: one row per settled fill: `fillId`, `engineId`, `accountRef`, `tradeId`, `instrument`, `direction`, `openedAt`, `closedAt`, `realizedNetAfterCost`, `exitType`, `decisionProvenance` (the exact decision record, bound by digest `decisionProvenanceSha`).
- Duplicate attribution of the same fill is rejected (`DUPLICATE_FILL_ATTRIBUTION`); any mutation attempt is rejected and audit-logged (`IMMUTABLE_ATTRIBUTION`).
- Attribution by engine is computed **per account**; cross-account netting is never performed (the ledger only groups within engine+account; there is no whole-portfolio number).
- The fill-side mirror of V1's append-only `order_fill_evidence` ledger (DB triggers) is the intended implementation substrate — the design deliberately reuses the proven pattern.

## 3. Comparative dashboard

`comparativeReport(championIdentity, challengerIdentity, ledger, sufficiency)` emits **only** when:
1. starting-condition equivalence holds,
2. both engines have ≥1 settled fills,
3. zero unresolved cross-engine actions,
4. the pre-registered sample sufficiency is met (e.g., ≥100 settled trades per engine).

Even when emitted, the report carries paired metrics (net after-cost per engine, delta) with the standing note: *"Paired difference is descriptive until the pre-registered sufficiency and significance protocol is met; no winner is declared here."* Any blockage is reported as structured blockers, not as missing data.

Per-engine metrics are computed by `v2-evaluation-metrics.cjs`: settled trades, net after-cost R, risk-normalized expectancy, profit factor, max drawdown, calibration (Brier/ECE/AUC), predicted-vs-realized gap, stability segments, sufficiency — plus broker-confirmed cost accounting: actual reported commissions, spreads and swaps per trade, execution-quality stats (fill slippage vs decision-time quote), and drawdown consistency across the window. Win rate is reported, never gated.

## 4. Staged evaluation protocol

| Stage | Environment | What it measures | Gate to advance |
|---|---|---|---|
| 0 — Offline replay | Chronological anonymized/synthetic data, purged walk-forward, replayed costs | Does the calibrated model beat its own calibration gates out-of-sample? | Pre-registered: ECE ≤ ceiling, PF gate, DD gate, sufficiency, zero leakage findings |
| 1 — Shadow paper | Live feed, no orders | Decision latency, evidence completeness, drift-gate behavior, no missing-field decisions | Decision-record contract violations = 0; drift-gate coverage = 100% |
| 2 — Paired DEMO | Two isolated Pepperstone cTrader DEMO accounts, broker-connected | Broker-confirmed after-cost outcomes, execution quality, drawdown, consistency | Pre-registered sufficiency (≥100 settled/engine) + significance protocol + independent review |
| 3 — Review | Independent reviewers, frozen artifacts | Verdict on the pre-registered questions; manual, explicit, DEMO-only promotion decisions | Never auto-promotion; LIVE is out of scope for this program |

Stage-2 pairing rule: both engines must trade the **same evaluation window** with equivalent starting conditions; staggered or unequal windows block the dashboard. Historical replay never substitutes for Stage-2 broker-confirmed results, per the assignment amendment.

## 5. Statistical protocol (pre-registered, no post-hoc thresholds)

- Primary endpoint: per-engine mean net after-cost R per settled trade, with dispersion; paired secondary endpoints: profit factor, max drawdown R, ECE, execution slippage.
- Sample sufficiency: required n computed from observed R dispersion for the pre-registered MDE (encoded in `sampleSufficiency`); no verdict below the required n.
- Bias controls carried from the corpus: overlapping same-instrument exposure reported (never silently accepted); correlated USD-pair positions not counted as independent; settled outcomes only — unfilled candidates are counterfactuals, never merged with fills; currencies never mixed across accounts.
- Hypothesis discipline: thresholds fixed **before** Stage 0; any post-hoc finding is labeled exploratory and cannot gate.

## 6. Boundaries

- AI V1 Champion is **preserved untouched**: same production engine, same risk controls, same deployment hold. Nothing in this program modifies, redeploys, restarts or reconfigures the Champion.
- The Challenger runs an isolated research code path with execution authority limited to its own DEMO account B; it cannot read, close, or net against Champion positions.
- No production credentials or databases are used for this program; DEMO accounts are separately provisioned and their identifiers are kept out of the repository.
- No LIVE execution, no qualification claim, and no profitability claim of any kind is made or implied by this design at any stage. Promotion requires the corpus's existing manual, explicit, DEMO-only regime plus the Stage-2/3 gates above.
