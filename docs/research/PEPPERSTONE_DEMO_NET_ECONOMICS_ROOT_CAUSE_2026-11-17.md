# iRexPro | Why the winning trades still lose money after costs

**Audit:** 17 November 2026, 20:39:56 UTC\
**Scope:** Active owner-owned Pepperstone cTrader **USD DEMO**, last seven days, closed broker trades with complete entry capital allocation and final fee/swap evidence.\
**Mode:** **Research only. No change to DEMO/LIVE execution or risk gates.**

## Verified economics

The existing read-only `audit-commission-r-calibration-gap.cjs` returned **126 closed trades**, with 126/126 complete entry-risk, realized gross P&L, commission and swap records. It reports *per-trade R*: cash outcome divided by each trade's own recorded capital-allocation risk at entry, **not dollars, account equity, total-return percentage, or broker stop-distance P&L**.

| Route | Closed trades | Net-positive | Net-negative | Mean gross R | Mean commission R | Mean net R | Pre-entry modeled M1 net R* |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Early Transition | 31 | 19 | 12 | +0.012 | 0.154 | **−0.142** | +0.076 |
| Confirmed Reversal | 44 | 24 | 20 | −0.001 | 0.153 | **−0.154** | +0.114 |
| Trend Continuation | 51 | 24 | 27 | −0.151 | 0.135 | **−0.287** | +0.124 |
| **Combined** | **126** | **67** | **59** | **−0.058** | **0.146** | **−0.205** | **+0.109** |

*The stored pre-entry expected-net model excludes explicit broker commission. Spread/slippage assumptions may already be included in that forecast. Group means are rounded and are not suitable for summing into portfolio profit.

### Two distinct problems

1. **Forecasting the gross market opportunity is optimistic.** The combined pre-entry forecast was +0.109R while the realized gross outcome was −0.058R: a gap of approximately **0.167R per trade**. By route, that gross opportunity/exit gap was **0.064R Early Transition**, **0.115R Confirmed Reversal**, and **0.275R Trend Continuation**. The last route is the weakest before commission.
2. **Explicit commissions remove approximately 0.146R per trade on average**, turning −0.058R gross into −0.205R net. These costs are significant, but **eliminating 100% of commissions would still not make the combined risk-normalized strategy profitable on this sample**.

The same audited cohort included **67 individually net-positive trades and 59 net-negative trades**, with **zero examples of an individually gross-positive trade becoming nonpositive solely after commission** under the script's exact classifications. This matters: the correct story is not that all winning trades are individually converted into losses by charges. The **aggregate negative expectancy** results from the size/mix of outcomes *plus* costs. A higher win rate alone cannot solve it.

Early Transition's tiny +0.012R gross average, against 0.154R commissions, would require a **hypothetical ~92.2% reduction** of the commission burden to merely break even at unchanged gross outcomes. This is arithmetic, **not an achievable broker pricing offer**. Reversal and Continuation cannot achieve positive average gross R even with a zero-commission thought experiment.

## Safe next engineering priorities

1. **Commission-aware ex-ante research shadow**: compare the archived pre-entry model forecast against a commission estimate derived strictly from earlier *closed*, same-instrument, same-account DEMO trades. Do not infer the future commission from the trade being evaluated, and do not treat a spread-only model cost as complete.
2. **Gross prediction calibration**: inspect why early-entry/confirmed-reversal forecasts and exits realize less gross R than predicted, especially the major Continuation gap. Examine MAE/MFE, stop-out pathways, quote gaps, horizon mismatch and market regime by strategy and instrument.
3. **Preserve existing profit protection** while testing patience/hold alternatives as shadow counterfactuals, not automatic wider stops or untested profit giveback.
4. **No chasing the equity deficit through 4–7 lot escalation**. Larger lots increase commission dollars, stop-at-risk exposure and drawdown; capital protection must remain the controlling constraint.
5. **Run separate later prospective trading-day windows** and require positive realized USD net after commission, swap and all other relevant charges, stable drawdown and sufficient samples before considering LIVE promotion.

## New reproducible root-cause scorecard

`apps/api/scripts/research-owner-demo-net-economics-review.cjs` accepts only the exact Pepperstone USD DEMO commission audit and fails closed on missing routes, incomplete risk or cost records, mixed denominators, or inconsistent gross–commission–net reconciliation.

```sh
cd /home/lightworld/webapps/irexpro-staging/apps/api
node scripts/audit-commission-r-calibration-gap.cjs > /tmp/irexpro-commission-audit.log
node scripts/research-owner-demo-net-economics-review.cjs \
  --audit=/tmp/irexpro-commission-audit.log \
  --out=/tmp/irexpro-owner-net-economics.json
node --test scripts/research-owner-demo-net-economics-review.test.cjs
```

**Source and safety:** the above is a read-only database audit and a pure arithmetic compiler; neither changes models, broker credentials, orders, size, stops, trade gates or account balances. Models must not be promoted based on retrospective data. The 7-day selected-trade sample is **not a valid prospective test** of any new candidate gate. Its profit factors or cash sums should not be inferred from averaged R.

**Decision:** the next optimization must address the underlying market-opportunity/exit prediction mismatch **and** full broker commission estimates, without falsely promising that higher lot sizes or a high trade win rate will recover equity.
