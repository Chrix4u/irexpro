# iRexPro — prospective profit-lock patience validation

**Date:** 17 November 2026. **Scope:** owner-only Pepperstone cTrader USD DEMO. **Status:** GitHub research code, not a live exit-policy change.

## Decision being tested

The owner observed that the current profit protection often closes winning positions before the full movement, but does not want gains to turn into losses merely to extend the holding period. The correct next experiment is NOT to widen all profit locks. Instead evaluate whether the already-deployed, prospective `DEMO_PROFIT_LOCK_TREND_RECHECK` HOLD_CANDIDATE actually distinguished trades that later benefited from a limited hold, after known signed commissions and swaps.

iRexPro already runs `ProfitExitAlternativesService` with artifact `exit-alternatives-verified-m1-v2`, which stores retrospective 15/30/60 completed M1 candle outcomes. It also already logs the prospective M1 and expert trend recheck **at close-request time**, before any future bars. This new audit evaluates the two together; it does not duplicate their trading logic, forecast new prices or move broker stops.

## Files

- `apps/api/scripts/research-owner-demo-profit-lock-hold-validation.cjs`: pure comparison of actual settled PROFT_PROTECTION close and prior HOLD/CLOSE recommendation versus subsequently observed barrier-censored price/P&L evidence.
- `apps/api/scripts/research-owner-demo-profit-lock-hold-validation.test.cjs`: deterministic unit tests for time causality, direction signal provenance, after-fee reconciliation, 15/30/60 minute horizons, censoring and no execution authority.
- `apps/api/scripts/run-owner-demo-profit-lock-hold-validation.cjs`: a read-only PostgreSQL runner that selects only exact-owner Pepperstone cTrader USD DEMO closed positions and reconciled shadow rows.
- `.github/workflows/research-post-stop-direction-ci.yml`: syntax and behavior CI without broker or VPS secrets.

## Run on authorized VPS when its management quota permits

```sh
cd /home/lightworld/webapps/irexpro-staging/apps/api
node --test scripts/research-owner-demo-profit-lock-hold-validation.test.cjs
node scripts/run-owner-demo-profit-lock-hold-validation.cjs \
  --out=/tmp/irexpro-owner-demo-profit-lock-hold-validation.json
```

The runner uses `BEGIN READ ONLY`, exact owner and broker connection, DEMO/USD and trade status, first-party post-entry research artifacts and matching same-trade `DEMO_PROFIT_LOCK_TREND_RECHECK` audit with identical observedAt. It considers up to 500 eligible closed positions in the previous 21 days that have been closed for at least 65 minutes. Results are private file-mode 0600. No external service, trade execution, session update or risk-gate change is invoked.

## What results mean

The output compares prospective `HOLD_CANDIDATE` and `CLOSE_CANDIDATE` across Early Transition, Confirmed Reversal, Trend Continuation and UNCLASSIFIED, separately. Each 15-, 30-, 60-minute snapshot may be `OPEN_AT_HORIZON`, `POSSIBLE_STOP_FIRST`, `POSSIBLE_TARGET_FIRST`, `SAME_BAR_AMBIGUITY`, `DATA_GAP` or `MONEY_CONVERSION_UNAVAILABLE`. Only fully reconciled, quote-verified, no-barrier, OPEN_AT_HORIZON snapshots have a **hypothetical delta versus the actual settled close**. Gross conversion uses the original broker fill and closed-trade commission/swap. Future FX conversion, slippage, spread and broker fill price are not guaranteed.

**Crucial:** later favorable prices cannot prove a real protected stop would have survived the intervening intraminute path. The uncensored survivors are a selected subset; a high improvement percentage among them is not a population success rate. Missing history is excluded and counted, never filled with zero P&L. A `HOLD_CANDIDATE` is not granted execution authority and cannot delay the existing protective close.

Future deployment of an optional 1–3 minute protected grace would first require (a) a verified broker-held stop preserving a positive *net-after-cost* floor, (b) no valid opposite-direction model signal, (c) mature independent M1/M5 evidence at close time, (d) sufficient **prospective** later trade episodes per route and instrument, and (e) a demonstrated net improvement including bad-path, censored and dropped-sample cases. No automatic promotion threshold is implemented here.

## Current verification boundary

The VPS Desktop Commander connection is usage-limited, so fresh Pepperstone positions and shadow rows were **not queried this turn**. Code changes are committed to GitHub and CI validates the pure study, but no numerical profit improvement or safe active delay has yet been established.

### Related ongoing work

The conditional DEMO 6-lot ceiling and original 0.25% stop-risk limit are unchanged. The user-reported account equity of USD 48,064 has not been independently broker reconciled, so neither this study nor the earlier client report should treat it as a real-time broker statement.
