# iRexPro AI Engine V2 — P1-5 exit-intelligence unification spec

Date: 2026-11-28 · Branch: `research/ai-engine-v2-champion-challenger-20261127` (post-sync with main `ce447f47`, PR #874's reconciliation and native position identity corrections included) · Research-only: no runtime file changed, no constants changed, no order authority granted.

Executable mirror: `apps/api/scripts/research/v2-exit-intelligence-contract.cjs` (+ `.test.cjs`, CI step in `api-ci.yml`). This document and the contract are cross-checked by the tests.

## 1. Problem (audit A7 / G1)

Six production engines protect the same concept — favorable-excursion
retention — with six divergent constant sets and two non-parameterized
evaluation policies (component map §5):

| # | File (path-verified on the synced baseline) | Shape | Constants (byte-exact, cited) |
| --- | --- | --- | --- |
| X1 | `broker/adapters/paper-broker.adapter.ts` | ladder + route arms + M1 rescue | arm 0.50R; bands 0.50→0.70, 0.75→0.75, 1.00→0.80, 1.50→0.85, 2.00→0.90; M1 rescue 0.395R→40%; CONFIRMED_REVERSAL 1.00R, EARLY_TRANSITION 0.75R (l.660-680, 719-725) |
| X2 | `execution/reconciliation/pepperstone-demo-net-profit-lock.ts` | ladder from peak 0 | <0.5→0.55, [0.5,0.75)→0.65, [0.75,1)→0.75, ≥1→0.80; TP overlay 0.91 (l.30-34, 88-93, 107) |
| X3 | `execution/reconciliation/live-demo-profit-protection.service.ts` | evaluation-based | continuation recovery grace 4.5 min (l.48) — **recorded divergence, not a ladder** |
| X4 | `ai/post-entry-demo-drawdown-guard.service.ts` | drawdown guard | checkpoint 5 min, deadline 7 min, close ≤ −0.4R, 15 s cadence (l.12-15) |
| X5 | `execution/reconciliation/pepperstone-demo-post-peak-rescue.ts` | band rescue | unprotected band 0.30–0.50R; giveback 0.3R; bleed floor −0.7R; ≥12 obs; ≥2 min (l.144-156) |
| X6 | `execution/reconciliation/verified-profit-stop-runner-policy.ts` | fee floor | ≥ max(0.1·risk, $1) else fail-closed `FEE_INCLUSIVE_STOP_FLOOR_UNPROVABLE` (l.226-232) — **recorded divergence** |

Exit management is the audit's dominant economic lever (G1); a challenger
cannot be attributed against six inconsistent baselines.

## 2. EI-1 — the unified parameterized exit policy

One schema subsumes every parameterized engine (X1, X2, X4, X5) and keeps
slots for the two evaluation-based engines as recorded divergences
(`EI1_EMULATION_NOT_PARAMETERIZED` is a typed refusal, never a silent
default):

```
stopAtrMultiple, minStopPips, targetR          # geometry (champion: 1.1 / 5 / 1.6)
armR, bands[{fromR, retain}]                   # retention ladder on peak R
rescue{armR, retain}                           # sub-arm rescue band (X1 M1)
routeArmOverrides{CONFIRMED_REVERSAL, EARLY_TRANSITION}   # X1 route evidence
tpOverlayFraction                              # X2 progressive overlay (0.91)
drawdownGuard{checkpointMinutes, deadlineMinutes, closeR} # X4
unprotectedBand{fromR, toR, givebackFraction,  # X5
  currentRBleedFloorR, minObservations, minElapsedMinutes}
timeStopBars                                   # EI-1 slot (challenger preset)
```

Validation is typed and fail-closed: bands must be strictly ascending,
start at `armR`, retain ∈ (0,1]; rescue strictly below `armR`; guard
`closeR < 0` with `deadline ≥ checkpoint`; all refusals are listed in
`EI1_REFUSALS`.

Decision precedence (bar-close evaluation):

```
TARGET → DRAWDOWN_GUARD → UNPROTECTED_BAND_RESCUE → LOCK_TRAIL/RESCUE_LOCK
  → TIME_STOP → HOLD
```

with `m1Rescue` faithful to X1: fires only below the standard arm and only
for the M1 strategy flag; route arming overrides substitute the arm
threshold (X1 l.660-680).

## 3. Comparison baseline — frozen

`EI1_CHAMPION_BASELINE` = S1's audited geometry
(`m1-tactical-candidate.ts` l.24-27): stop `max(1.1×ATR14, 5 pips)`,
target `1.6R`, **no retention ladder**. The champion baseline is frozen and
never modified; V1 preservation is absolute in this track.

## 4. V2 challenger exit preset — pre-registered

`V2_CHALLENGER_EXIT_PRESET` (artifact `v2-ei1-challenger-preset-v1`):
champion geometry + the X1 retention ladder (0.50/0.75/1.00/1.50/2.00 arms,
retains 0.70/0.75/0.80/0.85/0.90 + 0.395R→40% rescue) + the X4 drawdown
guard (−0.4R from minute 5) + a 288-bar time stop. Pre-registered before
any paired campaign so exit-attribution is a pre-registered comparison, not
a post-hoc choice. It is a research preset only — nothing here edits any
runtime engine or constant.

## 5. Acceptance criteria (verified by the contract tests)

- [x] Six-engine inventory path-verified on the synced baseline (drift
  detector refuses on any missing path).
- [x] Every pinned constant is a byte-exact copy of the cited lines; X3/X6
  recorded as evaluation-based divergences (2 of 6), not emulated.
- [x] X2 tiered retention mirror reproduces the frozen peak table
  (0.55/0.65/0.75/0.80).
- [x] X1 standard ladder, route arming overrides and the M1 rescue band
  reproduce pinned decisions.
- [x] X4 guard and X5 band-rescue conditions are conjunctive and pinned.
- [x] Malformed ladders are typed refusals (`EI1_BANDS_*`,
  `EI1_RETAIN_INVALID`, `EI1_BANDS_MISALIGNED_WITH_ARM`, …).
- [x] Champion baseline frozen (hard geometry only); challenger preset
  validates and its time stop fires.
- [x] No constants changed: production engines untouched; summary
  `noConstantsChanged: true` asserted.

## 6. Downstream use

The paired-engine simulator (P2-2) drives both engines with EI-1:
champion = `EI1_CHAMPION_BASELINE`, challenger = `V2_CHALLENGER_EXIT_PRESET`.
Exit efficiency / profit retention / decomposition metrics (P2 harness) then
attribute per-exit-reason deltas through `v2-entry-exit-decomposition.cjs`
without re-deriving any baseline constant.
