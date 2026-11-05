# iRexPro out-of-distribution (OOD) research and safe retraining path — 2026-11-05

## Executive finding

The current generic error `DRIFT_OUT_OF_DISTRIBUTION` is **not a learned model's proof that a regime is unseen**. It is a deterministic strategy-specific feature-range safety test in `apps/api/src/modules/ai/ensemble-governance.ts`, derived from an earlier **4,599-event** development corpus (`triple-route-direction-aligned-momentum-v4`). A hard out-of-range diagnostic is generated when any feature breaches its frozen per-route safety envelope. Treating it as permission to **relax** ranges is unsafe.

The six measurements for continuation are confidence, price extension in ATR, volatility score, EMA separation, multi-timeframe strength and RSI. Confirmed reversal and early transition have separate bounds, and may include direction-aligned momentum.

## Verified OOD rates on the three focused DEMO pairs

Read-only SQL against stored M1 decisions for AUDUSD, GBPUSD and EURUSD, sampled over the rolling 24 hours on November 5, 2026 (values change over time):

| Route | Recorded decisions | OOD decisions | OOD share | Most frequent diagnosed excesses |
| --- | ---: | ---: | ---: | --- |
| M1 trend continuation | 744 | 540 | 72.6% | Extension above max 414; EMA separation above max 288; RSI above max 166 |
| M1 early transition | 957 | 932 | 97.4% | Extension above max 652; EMA separation above max 446; momentum above max 357 |
| ABSTAIN | 6,498 | 5,920 | 91.1% | EMA separation below min; low MTF strength and confidence |

**Do not train an OOD-entry classifier on ABSTAIN rows as if they were eligible executable trades.** Many ABSTAIN vectors are zeros/weak features and not trade opportunities. Per-condition counts overlap because a decision can violate multiple bounds.

## Causally timestamped OOD data extraction

Read-only SQL file: `services/ai-engine/app/domain/training/ood_shadow_cohort_readonly.sql`.

- Bounded rolling **35-calendar-day** lookback (to include at least 12 separate trading days once evidence matures); only exact configured scanner user and matching **cTrader DEMO** broker connection.
- Only the three eligible instruments, non-ABSTAIN continuation/early-transition routes and persisted OOD candidates.
- Earliest independent quote at or before decision (latest 3-minute lookback, original `last_quote_sample_at` no later than decision), and separate first quote 15–18 minutes **after** decision.
- Decision-time fields only for features; ask/bid future observations used **solely as labels**. No raw user, tenant, broker ID, user balance or credential is exported.
- Every quoted row is validated again by the Python pipeline for correct event ordering, positive values, finite data and valid horizons.
- The observational price label includes observed entry/exit bid-ask spread plus an **extra 1 pip proxy** for unverified slippage/commission; this does **not** certify actual broker net P&L.
- Repeated decisions on the same instrument, route, direction and bar collapse to the first observation.

Executed privately on VPS with PostgreSQL on 2026-11-05:

| Evidence measure | Result |
| --- | ---: |
| Exported research examples | 2,172 |
| Fully causally verified | **2,131** |
| Verified AUDUSD / EURUSD / GBPUSD | 727 / 686 / 718 |
| Verified trend-continuation / early-transition | 979 / 1,152 |
| Dates with verified quotes | **3 UTC days (Nov 3–5)** |
| Positive 15-minute quote+fee-proxy examples | **33.27%** |
| Mean 15-minute quote+fee-proxy result | **−1.40047 pips** |
| Training status | **BLOCKED — insufficient separate quoted days** |

The above short-horizon outcomes are proxy labels, not real orders, profit claims or qualified backtest Sharpe. Existing M1 quotes extend to October 2, but historical records for Oct 27–Nov 2 lacked original `last_quote_sample_at` timestamps; these cannot be represented as proven at-decision quotes. This is why there are more OOD decisions than **causally verified** labeled OOD examples. Data collection continues without wiping older raw market data.

## Shadow training safety

The isolated Python module `services/ai-engine/app/domain/training/ood_shadow_candidate.py`:

1. Validates quote causality, symbol/route allowlists, finite feature values and timestamp ordering, never using any future outcome column as an input feature.
2. Builds 15-minute market-price-proxy labels for OOD candidates, including spread and one additional *estimated* pip, not audited commission.
3. **Refuses** a fit unless at least **12 distinct quoted UTC market days** (each with at least 120 verified observations across all three pairs) and **600 labeled examples per pair**, plus sufficient balanced data in three out-of-time periods.
4. If qualified, creates one offline-only XGBoost research fit with chronological 60% train, 20% validation and 20% untouched test windows separated by at least a 60-minute purge. A frozen 0.65 probability threshold is reported, not optimized on the test sample. Research outputs include classification and after-proxy spread metrics.
5. Saves **no executable model artifact**, never replaces an AI engine model, never dispatches orders, and keeps `promotion_allowed=false` regardless of the research metrics. Genuine final-model promotion **still separately requires the existing 100,000 M1 rows per pair**, full multi-month independent economic validation, confirmed broker net expectancy and current trading risk/kill controls.

The existing deployed Plan B and risk, commission, drawdown, 0.20 preferred/4.00 max lot policy, focused DEMO entry permissions and user-required explicit risk reset are **unchanged**.

## Automatic research collection (no extra paid API)

`scripts/research/run_ood_shadow_training.sh` and `.github/workflows/vps-ood-shadow-research.yml` add a private read-only weekday study at **16:20 UTC**. It uses the existing staging SSH connection and PostgreSQL/quote corpus, no MetaAPI or external paid service, writing exactly one bounded private latest CSV and JSON under `/home/lightworld/webapps/irexpro-research/ood-shadow/`; old files are atomically replaced to avoid filling the VPS. Sanitized workflow output contains only the readiness/count status.

On insufficient evidence it produces a readiness report **without fitting or promoting** a model. Once the explicit multi-day gate is met, it can fit a **research-only** candidate and report untouched-test metrics, still without changing any broker execution authority. CI tests include future-leakage rejection, quote ordering, independent chronological split/purge and an actual synthetic-data offline XGBoost fit.

## Next decision

Review prospective multi-week OOD outcomes by pair/route and underlying cause. Distinguish market extension (which may require better *abstention*) from genuinely profitable new regimes. Only retrain/promote after verified broker-execution fees and independent economic and risk qualification; **do not widen the current hard envelopes just to force more trades**.
