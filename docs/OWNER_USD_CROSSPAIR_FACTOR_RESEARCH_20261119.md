# iRexPro — USD Cross-Pair Common Factor and Correlated Portfolio Exposure

**19 November 2026 | Owner Pepperstone cTrader USD DEMO | Research-only**

## 1. Price-quotation convention

A pair is not a direct measure of the standalone USD value. All currency rates are relative. USD weakness against peers normally produces **falling** USDJPY/USDCAD/USDCHF and **rising** EURUSD/GBPUSD/AUDUSD. Pure JPY/CAD/CHF/EUR/GBP/AUD shocks can break the expected co-movement.

The common factor transforms each five-minute completed M1 pair return into USD-strength direction:

- `USD/XXX`: `+10000 * log(price_now / price_5min_ago)`
- `XXX/USD`: `-10000 * log(price_now / price_5min_ago)`

For target pair X, construct the factor using **other pairs only**. Winsorize input movements at +/-30 basis points, use the median, require at least four peers with both base-USD and quote-USD representation, and require at least 67% agreement over three or more meaningfully moving pairs. No target pair can vote for itself.

The six research instruments are AUDUSD, EURUSD, GBPUSD, USDCAD, USDCHF, USDJPY. The latter two non-executable research instruments may supply valid market context **without becoming executable instruments**.

## 2. Causal quote validity

Source: `market_data.provider_quote_candles`, exact active authorized owner Pepperstone USD DEMO connection, M1 `ctrader-broker-native`.

- Only **completed** M1 candles enter the 5-minute features. No current forming candle or subsequent price enters the decision-time common factor.
- The latest recorded broker-native bid and ask must be positive, correctly ordered, and from within the same one-minute bucket.
- Some provider minute bars have equal last bid/ask despite positive-spread samples earlier in that same bucket. For these, the **actual stored last positive** broker bid/ask may be used only if its source timestamp is in the last 20 seconds of that same bucket and at most 20 seconds before the last sample. No synthetic spread, stale previous minute, quote interpolation or future carry-forward.
- Any missing or untrusted price or timestamp excludes that observation. Exact past-minute contiguity is required.
- All database queries are owner-scoped, bounded, and run in a `REPEATABLE READ READ ONLY` transaction.

## 3. First retrospective results

As-of 19 Nov 2026 approximately 02:06 UTC; rolling lookback ~48 hours; data falls across **three UTC dates, not three independent complete trading days**.

| Study | Evaluated target-pair observations | Correct direction | Mean directional move after indicative spread only |
|---|---:|---:|---:|
| Future 5-minute target candle | 1,761 | 50.03% | -0.232 basis points |
| Future 15-minute target candle | 628 | 49.04% | -0.167 basis points |

**These are not trade P&L.** The hypothetical spread-only mark omits commissions, slippage, broker bid/ask first-touch geometry, order admission, stop-loss/take-profit and portfolio risks. Six pairs at the same five-minute timestamps are highly correlated; observations are not six independent strategies. The first simple consensus-as-direction strategy **has not demonstrated profitable standalone predictive power**.

Initial provider-quality screen yielded considerably fewer validated EURUSD rows. Recovery of actual, appropriately recent, positive-spread quotes increased research coverage to ~2,341 completed M1 EURUSD bars; others have ~2,853–2,874. This changes the results substantially versus an earlier invalid-final-spread-only sample and is retained explicitly in the audit.

## 4. Relationship with real DEMO trade outcomes

Among 104 settled owner Pepperstone USD DEMO trades in the bounded lookback, 56 had complete, sufficiently strong independent USD context at the **immediately preceding fully completed** M1 candle. The rest were excluded from the comparison, not called wins or losses.

| Settled trade subset | Aligned with common USD factor | Opposed to factor |
|---|---|---|
| All historical eligible entries | 29 trades / 15 wins / **-$302.94** net | 27 trades / 13 wins / **-$736.36** net |
| Confirmed Reversal only | 24 trades / 13 wins / **-$246.87** net | 12 trades / 4 wins / **-$574.18** net |

These are highly selected, correlated retrospective historical trades over a few days. Even aligned entries had negative net P&L. This is a **feature candidate** for future confidence calibration, not proof that automatically vetoing opposed trades would improve returns.

### Correlated USD directional exposure

Independent of price prediction, the broker-recorded open/close intervals show multiple simultaneous trades expressing the same USD view. A USD directional map is:

- `USDJPY BUY`, `USDCAD BUY`, `USDCHF BUY`, `EURUSD SELL`, etc. = **USD strengthening** view.
- `USDJPY SELL`, `USDCAD SELL`, `USDCHF SELL`, `AUDUSD BUY`, `EURUSD BUY`, etc. = **USD weakening** view.

The observed 19 Nov **AUDUSD BUY, USDCAD SELL, USDJPY SELL** were open simultaneously and all relied on USD weakening; they lost a combined **$120.19** after recorded commissions. Across the bounded 104-trade closed sample, the audit observed a maximum of three simultaneous same-USD-direction positions and 37 historical same-side overlap-on-opening events.

**Important:** A count of overlapping positions is not a risk-adjusted USD notional or proof that USD movement caused every loss. A future portfolio feature should use verified broker exposure, stop-risk in USD, correlations, currencies, trade duration and margin, not simply count pair names. This report does not change trade authorization or Start/Stop.

## 5. What was implemented

- `apps/api/scripts/audit-owner-demo-usd-crosspair-factor.cjs` — repeatable, bounded, read-only research with leave-one-out signal, 5m/15m retrospective labels, separate actual settled broker-trade alignment and historical USD directional-overlap audit.
- `apps/api/scripts/audit-owner-demo-usd-crosspair-factor.test.cjs` — direction inversion, no self-confirmation, stale quote, no lookahead, cost caveat, broker-only read scope, risk-cluster regression.
- `apps/api/scripts/watch-owner-demo-usd-crosspair-forward.cjs` — **prospective** factor observer. Freezes broker-bound activation once, captures new as-of 5-minute feature states, independently attaches later 5m and 15m observed price labels, journals owner-only private research records; no past backfill, order/stop/lot/risk authority.
- `apps/api/scripts/watch-owner-demo-usd-crosspair-forward.test.cjs` — activation and DB snapshot clock matching, evidence scope, missing future quotes, restart persistence, and broker-order-free behavior.
- `apps/api/scripts/irexpro-owner-usd-crosspair-forward-shadow.pm2.config.cjs` — independent optional research worker.

Private runtime research reports:

`/home/lightworld/webapps/irexpro-research/usd-common-factor/latest-report.json` (retrospective) and `/home/lightworld/webapps/irexpro-research/usd-common-factor/forward/` (prospective and frozen).

## 6. Conditions before promoting the factor to model inputs

1. Collect multiple independent future trading days with real quote and fill-quality coverage. Measure stability across London, New York, Asian sessions, volatility regimes, and macro releases.
2. Evaluate matched **actual owner M1 decision features** and future costs, comparing model confidence/calibration and route P&L with and without the USD factor, not only pair price-direction accuracy.
3. Keep the factor **leave-one-out** for each instrument; perform purged, chronological walk-forward validation and avoid choosing thresholds based on the very same results subsequently advertised as proof.
4. Study factor trend, breadth, dispersion, divergence, pair residual/relative strength and currency-concentration risk. Test adding these features independently to Confirmed Reversal, Early Transition and Trend Continuation.
5. Only if the independently held-out, after-cost result is materially improved should an owner-reviewed DEMO trial be considered. No automatic new trade veto, no blind larger lot size, no LIVE promotion, and Start/Stop remains the user's direct control.

**All code and services in this phase are research only.**
