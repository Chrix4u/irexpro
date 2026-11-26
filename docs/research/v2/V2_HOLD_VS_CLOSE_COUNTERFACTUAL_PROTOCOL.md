# iRexPro AI V2 — Pre-Registered Hold-vs-Close Counterfactual Shadow Protocol (V1)

**Branch:** `research/ai-v2-challenger-architecture-20261127`
**Status:** pre-registered research protocol (WS3.2). Frozen on 2026-11-27 **before any exit-path fixture was examined**. Nothing in this protocol changes any exit policy, threshold, guard, runtime path, or risk control. The deployment hold remains active.

Executable implementation: `apps/api/scripts/research/v2-hold-vs-close-shadow.cjs` (+13 tests, synthetic fixtures only). The protocol is frozen and SHA-pinned by `freezeProtocol()`; `evaluateHoldVsClose()` **refuses to evaluate under any protocol whose canonical hash does not match its pin** (`PROTOCOL_MISMATCH`) — post-hoc amendment of horizons, brackets, cost, or statistics is structurally impossible.

---

## 1. Why this protocol exists (audit grounding)

The full-engine audit's economic decomposition of 214 settled DEMO trades found:

| Observed exit class | Mean realized R | Notes |
|---|---|---|
| PROFIT_PROTECTION | +0.4155R | the only class ahead of the 1.6R design target's direction |
| BROKER_CLOSE | −0.8821R | time/margin-forced exits |
| 5m-guard | −0.7571R | the 5-minute guard |
| Commission drag | 0.146–0.202R/trade | vs a 0.073R spread-only cost model (3× understated) |

**The open question:** are the protective/guard/broker exits destroying expectancy, or are they correctly cutting trades that would have deteriorated further? No retrospective threshold-fitting exercise can answer this — it is exactly how V1's exit lattice became an 8-classifier emergent system. The answer requires a **pre-registered counterfactual measured on the same observed paths**: hold the position past the observed exit for fixed horizons and evaluate it under a uniform bracket.

## 2. The frozen protocol (default values, verbatim from the module)

| Field | Frozen value | Rationale |
|---|---|---|
| `protocolId` | `V2_HOLD_VS_CLOSE_SHADOW_V1` | version-pinned identity |
| `registeredAt` | 2026-11-27T00:00:00Z | pre-registration timestamp |
| `horizonsMinutes` | `[1, 15, 60]` | immediate (1m), the 5m-guard neighborhood scaled to a realistic re-decision window (15m), and one full design horizon (60m) |
| `evaluationRule` | `FIRST_TOUCH_BRACKET_WORST_CASE_STOP` | first-touch semantics; a minute touching both bracket arms resolves as the **stop** (conservative, pre-committed) |
| `bracket` | target `+1.6R`, stop `−1.0R` | the uniform design geometry: the 1.6R target V1 was designed around, with a 1.0R uniform stop |
| `perTradeCostR` | `0.2` | commission-inclusive round-trip, matching the audit's realized 0.146–0.202R rather than the 0.073R spread-only model |
| `statistics.pairedDifference` | `HOLD_MINUS_OBSERVED` | per case, per horizon: counterfactual net R minus observed net R |
| `statistics.signTest` | `EXACT_TWO_SIDED_BINOMIAL`, α = 0.05 | exact binomial tails, hand-verified in tests; no normal approximation |
| `statistics.minPairedCases` | `30` | below this the report is descriptive only (`INSUFFICIENT_PAIRED_CASES`) |
| `claims` | `DESCRIPTIVE_ONLY` | the protocol structurally cannot adopt, retire, or recommend a policy |

## 3. Case input contract (Stage-1 export shape, synthetic in tests)

```
{ caseId, instrument, direction,
  observed: { closeMinute, exitType, realizedNetR },   // the broker-confirmed observed exit
  path: [ { minute, mfeR, maeR, closeR } ] }          // strictly increasing minutes from 0
```

- `mfeR`/`maeR` are **running excursions** (non-decreasing / non-increasing) in R; `closeR` is the mark at that minute.
- The hold window is `(closeMinute, closeMinute + horizon]`. A path that does not provide **every** minute of the window yields `PATH_GAP` for that horizon: excluded and counted, never imputed, never interpolated.
- Duplicate `caseId` removes the case entirely from paired evaluation (ambiguous identity corrupts pairing) and is reported as a refusal.
- `realizedNetR` is already net of costs (broker-confirmed); the hold side applies the same `perTradeCostR` so both legs carry identical friction.

## 4. Computation (deterministic, hand-verifiable)

For each case and each horizon `h`:

1. Collect the path minutes in `(closeMinute, closeMinute + h]`.
2. Scan chronologically: minute with `maeR ≤ −1.0R` → hold outcome `−1.0R − 0.2R`; minute with `mfeR ≥ +1.6R` → `+1.6R − 0.2R`; same-minute double touch → **stop wins** (worst case).
3. No touch → mark-to-path: `closeR(closeMinute + h) − 0.2R`.
4. Paired difference: `holdNetR − observed.realizedNetR`.
5. Aggregate per horizon: paired count, mean difference, excluded count, observed exit-class distribution, exact two-sided sign test on non-zero differences.

## 5. Power honesty (pre-registered)

For a two-sided exact sign test at α = 0.05 with the alternative "hold beats observed exit with probability p":

| p (true positive rate) | n for 80% power | n=30 power | n=60 power |
|---|---|---|---|
| 0.65 | ≈ 70 | ≈ 0.36 | ≈ 0.62 |
| 0.70 | ≈ 47 | ≈ 0.58 | ≈ 0.86 |
| 0.75 | ≈ 34 | ≈ 0.80 | ≈ 0.97 |

**Statement of intent:** with the pre-registered minimum of 30 paired cases the protocol can only *describe*; detecting a modest 65/35 hold-advantage requires ≈70 paired cases. The Stage-1 export must therefore target ≥70 non-overlapping cases per exit class being compared before any sign-test result is treated as evidence, and overlap between case outcome windows (the same market minutes counted twice) is a reported caveat, not a hidden assumption.

## 6. Verdict semantics (the whole vocabulary)

`DESCRIBED_PAIRED_DIFFERENCE` — paired differences are reported with exact sign-test p-values; **nothing is adopted, retired, or recommended.**
`INSUFFICIENT_PAIRED_CASES` — paired count below the pre-registered minimum; descriptive only.
`REFUSED_INPUT` — every case malformed/duplicated; no statistics.

The output carries a standing disclaimer and the tests assert no `ADOPT`/`RECOMMEND` vocabulary can appear in any output JSON.

## 7. Relationship to the V2 architecture and the directive

- Implements **L3 (exit policy plane)** evaluation discipline of `V2_ARCHITECTURE_PROPOSAL.md`: exit variants are evaluated "by pre-registered counterfactual shadow on the same observed paths... never by retrospective threshold fitting."
- Entry intelligence is untouched: the entry admission gate (`v2-challenger-admission.cjs`) and this exit protocol never share a fixture decision — **entry and exit are measured separately** (audit category e).
- Stage gating: this protocol runs on **synthetic fixtures now (Stage 0)**; on separately authorized anonymized MFE/MAE path exports at Stage 1; it never touches a broker account, order, or production service.
- The corpus's inherited open questions (5m-guard value, evening scarcity, hour harmonics, profit-lock arming levels) are answered *by this protocol's future Stage-1 runs*, not by edits to production thresholds.

## 8. Explicit non-goals

No exit policy change, no guard/threshold adoption, no claim that holding beats exiting, no claim that exiting beats holding, no LIVE or production path modification, no private dataset in the public repository. Any future exit-policy proposal must come from a Stage-1 run of this protocol on authorized exports, reviewed independently before any shadow deployment is discussed.
