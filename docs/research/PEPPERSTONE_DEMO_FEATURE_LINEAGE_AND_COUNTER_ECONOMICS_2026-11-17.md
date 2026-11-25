# Pepperstone DEMO feature-lineage and opposite-direction qualification (17 Nov 2026)

## Scope and audit conditions

Owner-scoped, currently active Pepperstone cTrader USD DEMO FULL_AUTO session. Research uses a PostgreSQL REPEATABLE READ READ ONLY transaction; output contains no user identifier, account number, quote vectors, access tokens or broker credentials. It **does not** modify M1 authority, trading rules, instruments, lot sizing, risk, SL/TP, model promotion, session status or existing positions. No API restart is necessary.

Auditor: `apps/api/scripts/audit-pepperstone-demo-feature-lineage.cjs`. Run from `apps/api` with `node scripts/audit-pepperstone-demo-feature-lineage.cjs`. The script resolves the exact owner-bound connected/authorized Pepperstone DEMO session from server settings, limits its six-hour window to 4,800 decision observations (fails instead of reporting a truncated sample), validates as-of records, and writes a bounded sanitized report to `/home/lightworld/webapps/irexpro-research/feature-lineage/latest-report.json` with private file permissions. Unit tests: `node --test scripts/audit-pepperstone-demo-feature-lineage.test.cjs`.

## Actual feature-lineage result

Read-only audit window: 16 November 18:39–17 November 00:39 UTC/Ghana.

- **2,833** owner-scoped M1 decisions observed (repeated minute/instrument/direction evaluations, not 2,833 separate broker orders).
- Source-to-stored governance feature comparisons: **0 EMA transform mismatches**, **0 M15 transform mismatches**, **0 missing/invalid lineage**.
- **1,414** raw negative direction-aligned EMA observations were intentionally converted to zero by the existing `clamp01(alignedEmaSeparationAtr / 2)` transform; **1,416** negative M15-alignment observations converted to zero by `clamp01(alignedM15)`.
- Of **2,798** TREND_CONTINUATION Plan-B checks, **2,570** were OOD. By contrast, **34** CONFIRMED_REVERSAL and **one** EARLY_TRANSITION checks were all **NORMAL** against their own route-specific drift ranges; all 35 were initially paper-admitted and governance-eligible, and none was broker-authorized.
- Of the 35 admitted alternate scans, **nine** had an M1 direction-quality score below 0.55 and **27** showed an expert direction opposing the candidate side (counts can overlap; repeated observations are not independent trials).
- Most frequent model-range flags: EMA separation HARD_LOW 1,537; M15 strength HARD_LOW 1,399; extension in ATR HARD_HIGH 959; volatility HARD_LOW 766. Overlapping labels include unadmitted TREND_CONTINUATION scans and must never be interpreted as missed executable trades.
- Feature quantiles across the full six-hour sample: signed aligned EMA p10 −0.882/median 0.0017/p90 0.884; normalized EMA p10 0/median 0.0009/p90 0.442. Signed M15 p10 −0.566/median 0.004/p90 0.566; normalized strength p10 0/median 0.004/p90 0.566. Neither distribution shows a transformation mismatch. They **do not** directly demonstrate that the underlying EMA or M15 market-feature estimators are calibrated to the historical 4,599-event training/reference population.

### Interpretation

The blanket “OOD is blocking everything” impression is misleading: the large OOD rate is mainly a consequence of negative/weak directional readings in repeated trend-continuation/ABSTAIN scans measured against a frozen continuation envelope. This is legitimate diagnostic behavior, not demonstrated malformed mathematical normalization. Normalising these raw features differently without retraining would invalidate the current model's inputs and risk controls.

The **reversal/early-transition execution starvation is separate**, originating in independent M1 quality/stop requirements, expert opposition, and/or after-fee market conditions. Removing OOD would not cure the observed admitted reversal/transition failures.

## Independent prospective chosen/opposite-side study

Ran the existing `audit-pepperstone-forward-direction-calibration.cjs` on 17 Nov at 00:39 UTC. Study began prospectively 16 Nov 17:50 UTC and used fresh owner-scoped native bid/ask quotes, chronological candidate selection and a 15-minute same-instrument de-duplication. **33 research episodes** were selected, with both direction price marks available; 17 overlapping candidates were excluded. The research estimates $6 round-trip commission per standard lot plus 0.2-pip extra slippage and includes spread by using broker bid/ask.

| Fixed holding horizon | Chosen direction: mean estimated net pips | Opposite direction: mean estimated net pips |
|---|---:|---:|
| 3m | −1.153 | −1.156 |
| 5m | −1.186 | −1.165 |
| 10m | −1.074 | −1.253 |
| 15m | −1.083 | −1.538 |

These are **after-cost quote-path proxies**, not genuine filled trades, realized P&L, barrier-exact stop/target or independently profitable model promotion evidence. Some paths have possible stop-first events/unknown intrabar order. The time window is too short and may include thin liquidity/rollover. In this sample, the system's chosen side and naive opposite counter side **both had negative average fixed-horizon marks**; reversing each rejected side is not a validated edge.

## Next research and release gate

1. Continue collecting causal independent broker quote history on reversal/transition side/route, separated by liquid session and rollover. Compare next 3/5/10/15m chosen/opposite outcomes **with verified first-hit stop/target**, commission, slippage and missing-data accounting.
2. Study the existing original M1 direction quality and independent expert vote disagreement at same-bar decision time, without changing 0.55, 0.67 or 0.25 thresholds until true out-of-sample cost-adjusted evidence supports a candidate.
3. Shadow-test any proposed route-specific score recalibration; qualify it on multiple separate days and held-out market sessions, using actual broker net risk and profit-protection outcomes. Never infer a valid model from repeated M1 scans alone.
4. Existing advisory DEMO trial remains separately timeboxed to **17 Nov 20:00 UTC/Ghana**, with a maximum of four intents/4.00 lots and unchanged allocation-risk and broker safety caps. **No extension or LIVE-account promotion** from this research.

**Code status:** audit tool and unit tests only. No executable trading or market-data processing code changed.
