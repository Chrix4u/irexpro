# Owner DEMO multi-horizon entry timing observational patch — 2026-11-20

## Research scope and purpose
- Broker-scoped, owner-scoped Pepperstone cTrader USD **DEMO only**.
- Append-only causal capture of original order context, the frozen 60-second checkpoint, and broker-side quote observations at **1, 3, 5, 10, 20 and 30 minutes**.
- No permissions to place/alter/cancel orders, change risk gates or lots, or promote any model to live.
- Stops / profits are **real** only when reported from settled broker records. Delayed-entry checks and quote marks are **not executable broker fills**.
- Censor observations after the real position closed; track missing or stale quote marks as missing, never impute them.
- Historical event stages are not retrospectively backfilled. Previously recorded NOT_MATURED events remain visible and unaltered.

## Verified defect and correction
The collection scheduler previously allowed checkpoint observations at **+8 seconds after the horizon** whereas the independent evaluators require **+10 seconds**. This could irreversibly journal `CHECKPOINT_NOT_MATURE` and `NOT_MATURED`, even though market data could become usable moments later. The scheduler now waits at least 10 seconds; no journal overwrite is performed.

## Observational baseline captured at 2026-11-20 00:44 UTC
- Enrolled 90 owner DEMO trades, 89 settled; settled net **-$1,242.80**.
- CONFIRMED_REVERSAL: 69 settled, **-$1,340.47**.
- EARLY_TRANSITION: 20 settled from 21 enrolled, **+$97.67**.
- 21 tracked trades had `CHECKPOINT_NOT_MATURE` under the old collector schedule.
- These are scoped research-cohort counts, not total account results and **not** evidence of a profitable strategy.

## Example: recent EURUSD BUY
- Opened 2026-11-20 00:24:26.406Z (EARLY_TRANSITION), broker entry 1.09739; 1.72 lots; original stop 1.09682.
- In the sampled broker-side quotes, minimum observed bid 1.09703 at 00:34:08.229Z (approx -3.6 pips); around 20 minutes the last sampled bid was +0.3 pip from entry.
- Observed bid did not cross the reported stop during the sampled period, but sampled quotes do not prove the exact broker stop/fill event sequence.

## Future model design, **not** activated by this patch
Train separate **causal, out-of-sample** horizon-path labels for 1/5/10/20/30m, distinguishing:
1. direction at horizon,
2. early maximum adverse excursion / first stop touch,
3. time to first favorable move and profit barrier,
4. immediate entry versus optional short-lived pullback/confirmation limit,
5. expected *net* reward after spread, slippage, commission and swap.

The primary model proposes direction; a second timing meta-model recommends `ENTER_NOW`, `WAIT_FOR_CONFIRMATION`, `WAIT_FOR_PULLBACK`, or `SKIP`, with explicit uncertainty and trade-expiry rules. It must be tested in shadow and independent unseen trading dates before any DEMO execution rollout. Never derive a retrospective broker fill from later market quotes.

## Tests
`node --test apps/api/scripts/collect-owner-demo-prospective-entry-timing.test.cjs apps/api/scripts/audit-owner-demo-prospective-entry-outcomes.test.cjs apps/api/scripts/owner-demo-entry-timing-checkpoint-shadow.test.cjs`
