# iRexPro — Three-strategy evidence scorecard

**Research artifact:** `irexpro-owner-demo-strategy-comparison-v1`\
**Scope:** only the configured owner's Pepperstone cTrader **USD DEMO** historical evidence.\
**Created:** 17 November 2026.\
**Execution status:** research-only. No changes to M1 entry permission, Early Transition, Confirmed Reversal, Trend Continuation, risk-at-stop, broker stops, lot sizes, profit protection, or LIVE.

## What has been implemented

The scorecard combines the following two existing read-only reports **without conflating their samples**:

- **Actual settled broker trade audit:** `run-owner-demo-post-stop-direction.cjs`. Includes confirmed stop loss versus ambiguous BROKER_CLOSE, subsequent M1 broker bid/ask price marks, original stop and fill, realized net after signed commission/swap, highest observed floating P&L, and observed profit giveback.
- **Causal decision-direction replay:** `research-owner-demo-direction-horizons.cjs`. Measures recorded model-side direction versus completed broker-native M1 bid/ask closes at/after 1, 3, 5 and 10 minutes, with a *historical fee/R proxy* that is always labeled as an estimate. The replay now produces both `byRoute` (all scanner-decision episodes) **and `byExecutedRoute`** (only `BROKER_NATIVE` decisions with outcome `EXECUTION_SUCCEEDED`). Broker authorization or a green readiness meter alone does not count as execution.

The resulting `research-owner-demo-strategy-scorecard.cjs` compares **Early Transition**, **Confirmed Reversal**, and **Trend Continuation** separately using:

| Evidence group | Metrics | Denominator |
|---|---|---|
| Real completed broker trades | USD realized net after fees, win rate, profit factor, signed commissions, positive peak then net loss, observed profit giveback | Closed trades with complete settlement for financial ratios |
| Verified broker stops and post-close prices | Original fill reclaimed, partial bounce, no observed recovery, no available quote, uncertain broker close near SL | Confirmed stops with valid post-close broker price marks for reclaim rate |
| All scanner hypotheses | Direction accuracy, mean directional R, fee-covered proxy results for each forecast horizon | De-duplicated 20-minute pair/side/route *decision* episodes |
| Successfully executed decision episodes | Direction accuracy and fee proxy for 1/3/5/10 minutes after the decision | De-duplicated `EXECUTION_SUCCEEDED` decision episodes, not total fills |

**Never divide an episode-level count by a settled-trade count.** These reports do not contain a verified one-to-one matched trade identifier. Correlated market episodes and common USD exposure may remain among distinct pair-side-route keys.

## Running the full comparison on the authorized VPS

Run these commands sequentially so that the two source report `asOf` timestamps remain **within 15 minutes**; otherwise the comparator refuses to combine them.

```bash
cd /home/lightworld/webapps/irexpro-staging/apps/api

# No new orders, no database mutations: all underlying queries are READ ONLY.
node --test scripts/research-owner-demo-post-stop-direction.test.cjs
node --test scripts/research-owner-demo-direction-horizons.test.cjs
node --test scripts/research-owner-demo-strategy-scorecard.test.cjs

node scripts/run-owner-demo-post-stop-direction.cjs \
  --out=/tmp/irexpro-owner-post-stop-audit.json \
  > /tmp/irexpro-post-stop-audit.log

node scripts/research-owner-demo-direction-horizons.cjs \
  --out=/tmp/irexpro-owner-direction-horizons.json \
  > /tmp/irexpro-direction-horizons.log

node scripts/research-owner-demo-strategy-scorecard.cjs \
  --stops=/tmp/irexpro-owner-post-stop-audit.json \
  --directions=/tmp/irexpro-owner-direction-horizons.json \
  --out=/tmp/irexpro-owner-strategy-comparison.json
```

The JSON report is written with private-file permissions (mode 0600). No broker API order action is invoked. The output preserves no account IDs, but it can contain individual positions and their amounts, so it should stay in authorized storage rather than a public web directory.

The comparator fails closed if one report has the wrong provenance, nonnative price source, mismatched instruments, missing `researchOnly` marker, or mismatched analysis timestamps. The portable reports are intentionally redacted, so identical broker ownership cannot be mathematically proved from the files alone; generate both in the same controlled VPS session.

## Interpreting results and deciding next work

1. Require adequate **separate** trade, all-decision, executed-decision, and prior-fee coverage before even marking a pattern `ENOUGH_FOR_FURTHER_VALIDATION_NOT_DEPLOYMENT`. Current exploratory minimums are 30 fully settled closed trades, 30 5-minute decision episodes with 25 fee-covered, and 20 executed-decision episodes with 15 fee-covered. These are study-minimum guardrails, **not proof of an edge** and are **not trading gateways**.
2. Evaluate net profitability by pair, side and route and check repeatability on later independent market sessions, not just one profitable day. If a trade briefly profits then loses, compare original M1/M5/H1 expectation and forecast horizon before tightening protection.
3. Reclaiming entry price **after a confirmed SL** may indicate mismatched entry timing or horizon but does **not** prove a wider stop survives intraminute volatility or that keeping the position open would make money after fees.
4. Do not blindly reverse a BUY because a superficially similar prior BUY lost. Shadow-compare both directions using the **same decision-time** broker market data and chronological hold-out evaluation.
5. Any new profitable directional policy must separately demonstrate out-of-sample, realized after-cost benefit and pass unchanged broker controls. No automatic model promotion to LIVE.

**CI:** [GitHub Actions: Research — Pepperstone DEMO Strategy Evidence](https://github.com/Chrix4u/irexpro/actions/workflows/research-post-stop-direction-ci.yml) verifies the pure report classifiers, the executed-versus-authorized directional cohort and the scorecard without broker credentials.

## Actual deployment and fresh data status

This turn's VPS management connection is unavailable due to its monthly usage cap. The code is committed and its GitHub Actions tests have passed, but **the new merged report has not been executed against fresh owner DEMO records**, nor have any trading services been restarted. No current net profitability or strategy ranking is claimed. Running the above read-only commands on the authorized VPS is required to obtain actual current rankings.
