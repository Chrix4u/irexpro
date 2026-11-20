# iRexPro: independent broker-native expert abstention forward validation (20 Nov 2026)

## Objective and provenance

This **read-only** research examines the owner's verified Pepperstone cTrader **USD DEMO** account, focusing on the recurring **20:00–22:00 UTC Ghana time** no-entry period from **17–20 November 2026**. The study was written after the 2026-11-20 Friday trading session, without access to future market prices beyond the already archived period. It does **not** change lot sizes, stop protection, admission floors, model weights, orders or LIVE readiness.

Replay: `node apps/api/scripts/audit-owner-demo-expert-abstain-forward.cjs`. Tests: `node --test apps/api/scripts/audit-owner-demo-expert-abstain-forward.test.cjs`. Output: `/home/lightworld/webapps/irexpro-research/expert-abstain-forward/latest-report.json` (research output outside the Git repository).

The evaluator selects the **first expert-direction-aligned candidate per pair / direction / non-overlapping 5-minute UTC bucket**, only from saved, broker-native expert states with a credible decision-time timestamp. It then prices the candidate at the **first archived broker bid/ask quote at or after that candidate**, within 12 seconds, and similarly at **5, 10 and 15 minutes**. Missing timely entry/exit evidence stays **UNKNOWN**. The entry and exit sides pay the observed bid/ask spread. The main results also assume a further **1.0 pip round-trip equivalent commission/slippage charge**, and test 0 and 0.5 additional-pip sensitivity. It is NOT the actual strategy stop/TP, a broker fill, a tick-level replay or calibrated financial P&L.

## Four-evening observations

<escape>
| Fixed simulated horizon | Selected episodes | Quoted outcomes | Positive after 1-pip additional charge | Positive fraction | Estimated pips summed across quoted episodes | Mean pips per quoted episode |
|---|---:|---:|---:|---:|---:|---:|
| 5 minutes | 449 | 371 | 57 | 15.36% | −540.2 | −1.456 |
| 10 minutes | 449 | 369 | 92 | 24.93% | −590.6 | −1.601 |
| 15 minutes | 449 | 365 | 92 | 25.21% | −629.5 | −1.725 |
</escape>

5-minute extra-cost sensitivity, on the same 371 priced episodes:

<escape>
| Extra cost beyond observed spread | Positive outcomes | Positive fraction | Summed estimated pips |
|---|---:|---:|---:|
| 0.0 pip | 142 | 38.27% | −169.2 |
| 0.5 pip | 100 | 26.95% | −354.7 |
| 1.0 pip | 57 | 15.36% | −540.2 |
</escape>

Four separate dates had 110, 109, 114 and 116 selected five-minute expert-direction-aligned episodes, respectively. There were **78 missing timely 5-minute quotes** and 80/84 missing at the longer horizons. All observed expert states in this selected cohort were **ABSTAIN**. The above reported pip sums are **unweighted virtual snapshots**, not booked broker losses or an executable strategy; they must not be added to actual broker P&L. Only 9 scored observations in the top reported 0.40–1.00 probability band had usable 5-minute quotes, so its results are not suitable for a policy threshold.

## Independent calibration comparison

A pre-existing research artifact `entry-calibration/latest-report.json`, as of 2026-11-20T21:58:02 UTC, covers a **different 302 settled owner-DEMO trades over 8 independent market days**: net USD −4,629.57. Its prior-whole-day-only adjustment improved mean squared error preliminarily but **did not demonstrate a profitable execution gate**. A naive adjusted nonpositive-score filter among 220 compared trades would exclude **92 winning trades** while still retaining **25 losing trades**; it is NOT a live-trading admission rule.

Another pre-existing counter-direction research report `counter-direction/latest-report.json` at 22:22:10 UTC shows **80 actual closed trades on Nov 20** with **−$2,009.06 net**, and a paired opposite direction **virtual** estimate of −$2,396.55 for 79 comparable trades. The opposite study has different price path, exit assumptions, possible selection bias and cohort definition. Do not add the P&Ls across studies.

## Engineering conclusion

- Do not equate **3:0 independent direction votes** with model-confirmed *tradable opportunity*. On the Friday pre-close owner-scoped checks, expert opportunity probabilities stayed under ~0.425 while every expert admission was ABSTAIN. The direction with more votes can still have negative return after spread/fees.
- The Friday `counterPilot v3` repaired a genuinely unreachable source-evaluation branch and expires automatically at **22:00 UTC**. It did **not** generate a profitable strategy or qualifying opposite entry. This new research is an isolated script only; no new broker permission/restriction is introduced.
- Extending the holding horizon mechanically from 5 to 10/15 minutes does not fix the average after-cost result in this observed market period. It is therefore unsafe to loosen the expert's admission threshold or force opposite-direction orders to increase frequency.
- The next model-development step is to **retrain/calibrate forecasts against fully mature, causally timestamped forward after-cost outcomes across diverse market sessions** and then hold out entire future days (and broker quote regimes) before any demo admission change. Validate expectancy and stop-first/target-first outcomes **by strategy, instrument, directional expert agreement and time-of-day**. Adopt only when a new policy improves net after-fee expectancy and risk-adjusted drawdown without erasing a disproportionate share of winning trades.
- Until then keep LIVE promotion blocked by the existing qualification process. Maintain unchanged broker margin, active-position, fee, user Start/Stop, trailing stop, profit-protection and capital-risk controls. No arbitrary order generation.

## Verification

`apps/api/scripts/audit-owner-demo-expert-abstain-forward.test.cjs`: **8/8 Node tests passed**, covering exact broker scope, deterministic episode de-duplication, as-of expert provenance, sample freshness, bid/ask/fee mathematics, missing data and variable horizons.

The 4 daily database extracts had **960, 932, 941 and 854** persisted decisions respectively (none truncated at the 2,200-row per-day cap), with quote archives already existing before study execution. The live trading API, profit-protection service and exact owner demo session were inspected and unchanged at study start; the study itself made no service restarts.
