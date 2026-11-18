# Pepperstone DEMO — independent-day net-profit forecast calibration

**18 November 2026, 13:20 UTC snapshot. RESEARCH ONLY.**

The owner requested that Early Transition and Confirmed Reversal retain their lot sizes/exposure and entry authority while the team improves profitability and avoids premature exits. Those execution rules are not changed by this work. The existing active tiered profit protector remains enabled, the recent persistent adverse-cut pilot and aggressive TP-progressive overlay remain disabled; the older five-minute broker-native DEMO drawdown guard remains active.

## Why calibration matters

The latest owner Pepperstone USD DEMO audit found serious optimistic expected-profit scoring. Many trades were directional winners at some point but commission and asymmetric losses wiped out net performance. The seven-day expected-R study across 135 trades observed +0.256R mean predicted net versus -0.228R realized net. Earlier 17–18 Nov position-level research found 93 completed Early Transition/Confirmed Reversal trades with actual combined -$1,192.96 net, with 52 of 89 in-position first-minute quote marks initially moving adversely. The 60-second delayed-entry price-only challenger did not establish a profitable or even reliable direction classifier.

It is unsafe to pretend a future booked P&L is known at entry. This audit therefore **purges an entire UTC trading date**: to estimate correction for a position entered on date D, the only historical learning examples are prior positions on other dates with confirmed CLOSE timestamps before D 00:00 UTC. Even a position that closed hours earlier on date D is excluded from D's calibration. The same user and broker/demo USD account, original submitted strategy route, original as-of risk allocation and actual settled gross/commission/swap are required.

## Frozen preliminary correction (NO execution)

For each Early Transition or Confirmed Reversal route independently:

- Require at least 10 properly priced prior broker-settled trades from at least 3 distinct previous UTC entry dates, all closed BEFORE the new UTC entry day.
- Each training example error in units R: actual net after recorded commissions and swap divided by original as-of capital risk at stop, minus the ORIGINAL submitted expected net R.
- For research robustness, cap each individual calibration residual to plus/minus 3R. Then compute the mean residual and shrink it by n/(n+20), equivalent to 20 prior neutral examples. This is a FROZEN exploratory adjustment, not a trained production parameter and not claimed to improve trades.
- Never infer zero commission from a missing value or use a capital allocation recorded after trade open.
- Evaluate the corrected and original expected net R against the SAME fully held-out trades. Unadjustable prior days stay INSUFFICIENT rather than fabricated historical forecasts.

This calibrates a projected score, not a trade side, lot size, stop, target or execution policy.

## First audited result

The matched owner USD DEMO study has **106 settled, fully priced trades** across six UTC entry dates (10, 11, 12, 13, 17, 18 Nov). Actual net booked across the cohort is **-$1,011.83**, original mean expected +0.2862R versus mean actual -0.2031R. This is not exactly the same date-only cohort as previous studies; it includes earlier November dates.

The minimum prior-day-history policy qualified ONLY the 24 trades from 18 November; earlier 82 trades had insufficient independent historical evidence. On the 24 comparable held-out trades:

| Evaluation of expected net R | Original submitted model forecast | Conservative prior-day bias adjusted forecast |
|---|---:|---:|
| Mean absolute forecast error (R) | 0.7593 | 0.7008 |
| Mean squared forecast error (R²) | 0.9059 | 0.6071 |

The adjusted forecast's **preliminary prediction-error metric improved**. It does NOT show that any loss was avoided or any new profitable trade was made. The after-cost losses remain actual, and there is only ONE eligible held-out trading day. Mean error can also be lower merely because predicting poor outcomes on a losing day is easier; trade selection and regime effects must be evaluated on different unseen dates. No promotion of this correction is authorized.

Early Transition qualified 11 of 24 held-out trades with original error 0.7281R versus adjusted 0.6459R; Confirmed Reversal qualified 13 with 0.7857 versus 0.7473R. These two small, correlated samples cannot establish strategy reliability.

## Added read-only operation

- Standalone: apps/api/scripts/audit-owner-demo-net-r-walkforward.cjs
- Tests: apps/api/scripts/audit-owner-demo-net-r-walkforward.test.cjs
- Read-only timed wrapper: apps/api/scripts/watch-owner-demo-net-r-walkforward.cjs
- Wrapper tests: apps/api/scripts/watch-owner-demo-net-r-walkforward.test.cjs
- PM2 configuration: apps/api/scripts/irexpro-owner-net-r-walkforward-shadow.pm2.config.cjs
- Private atomic report, mode 0600: /home/lightworld/webapps/irexpro-research/entry-calibration/latest-report.json
- A 30-minute research watch only, not execution. The wrapper uses a bounded child process, read-only PostgreSQL repeatable-read transaction, <=800 broker trades, <=45-second cycle timeout and capped output. No new data subscriptions.
- The prospectively capturing entry-timing tracker runs independently and is NOT restarted by this research audit; its separate detailed quote/entry/settlement journal remains unchanged.

## Forward decision conditions

1. Capture additional independently dated actual DEMO fills and the 1/3/5/10-minute quote-side paths already collected by irexpro-prospective-entry-timing-shadow.
2. Compare original and frozen calibrated net-R estimates on future market days, grouped by pair/side/strategy and session. Report missingness, model-policy versions and drawdown alongside actual booked signed commission/swap. Model versions change; calibration must not silently treat old policy versions as current performance without a caveat.
3. Require a meaningful sustained reduction in out-of-day error AND positive after-cost expectancy on separate actual broker sessions before proposing any executable score or entry rule. Lower score error ALONE is not sufficient.
4. Preserve Early Transition and Confirmed Reversal lot size and existing original broker SL/TP, active tiered profit protection, and five-minute drawdown guard. No additional gates or experimental trailing-stop authority while evidence remains insufficient.
5. LIVE promotion is not warranted at this stage.

## Verification

From apps/api:

    node --test scripts/audit-owner-demo-net-r-walkforward.test.cjs scripts/watch-owner-demo-net-r-walkforward.test.cjs
    node scripts/audit-owner-demo-net-r-walkforward.cjs
    node scripts/watch-owner-demo-net-r-walkforward.cjs
    pm2 start scripts/irexpro-owner-net-r-walkforward-shadow.pm2.config.cjs
    pm2 logs irexpro-owner-net-r-walkforward-shadow --nostream --lines 10

To pause this research watcher without touching the trading API:
pm2 stop irexpro-owner-net-r-walkforward-shadow

No real-money trade, model weight, execution authority, lot allocation, stop, take profit or broker connection is changed.
