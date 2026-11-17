# iRexPro - 3-to-7 Lot Historical Risk Sensitivity

17 November 2026 | Owner Pepperstone cTrader USD DEMO | RESEARCH ONLY

## Objective
The owner reports USD 48,064 in DEMO equity versus a USD 50,000 starting reference (USD 1,936 / 3.872% down). This is a user-reported observation, not an independently reconciled broker account snapshot. The requested 3, 4, 5, 6 and 7 standard-lot cases are analyzed from previously settled owner DEMO trades; the study does not open new orders.

## Method
- Pure historical analysis: apps/api/scripts/research-owner-demo-lot-ladder.cjs
- Unit tests: apps/api/scripts/research-owner-demo-lot-ladder.test.cjs
- Read-only owner/broker-scoped runner: apps/api/scripts/run-owner-demo-lot-ladder.cjs
- CI: .github/workflows/research-post-stop-direction-ci.yml

The runner opens a READ ONLY PostgreSQL transaction, selects up to 800 CLOSED Pepperstone cTrader USD DEMO positions from the past seven days for EURUSD, AUDUSD, USDJPY and USDCAD, and joins original Plan B route and initial risk-at-stop. Only complete signed realized gross, commission, and swap records are used. Candidate outcomes and charged commission are multiplied linearly by proposed lots divided by original lots, using the SAME past price path. No new broker fills, price path, spreads, stop placement, margin availability or slippage are simulated.

Small positions below 0.5 lots, scaling beyond 5x, and unsettled financials are excluded or flagged. Missing risk at stop is explicitly UNKNOWN, never safe. Results are grouped by Early Transition, Confirmed Reversal, Trend Continuation or UNCLASSIFIED. Any apparent summed hypothetical profit is NOT projected equity and cannot establish a new profitable strategy.

## Execute when VPS access resumes
Change to /home/lightworld/webapps/irexpro-staging/apps/api and run:

    node --test scripts/research-owner-demo-lot-ladder.test.cjs
    node scripts/run-owner-demo-lot-ladder.cjs --equity=48064 --reference=50000 --out=/tmp/irexpro-owner-demo-3-to-7-lot-ladder.json

Use a freshly reconciled broker equity before treating the 0.25% risk-budget comparison as current. The output explicitly labels the equity OWNER_REPORTED_NOT_BROKER_VERIFIED, and the private JSON report is written with mode 0600.

## Risk and fee interpretation
At user-reported USD 48,064, 0.25% initial stop risk is about USD 120.16. Illustratively a 10-pip EURUSD SL at 3/4/5/6/7 standard lots entails roughly USD 300/400/500/600/700 potential price loss before fees, above the cap. Estimated Pepperstone cTrader forex round-trip charges at USD 6 per lot would be USD 18/24/30/36/42 respectively. This pricing illustration must not be treated as a verified commission bill for every instrument or account.

A scenario marked WITHIN_STOP_RISK_CAP_OTHER_GATES_UNVERIFIED is NOT approved to execute. Broker free margin, actual stop geometry, spreads, lot steps, risk limits and correlated exposure still apply. A 7-lot historical shadow win and a 7-lot shadow loss grow by the same multiplier and do not improve directional accuracy.

## Client report and deployment status
A separate one-page client interim PDF has been prepared with owner-reported figures, visible caveats, and the evidence-led next stage. This repository change is research-only: no change to the 6-lot optional DEMO ceiling, the existing risk-at-stop, profit protection, live trading, or order settings. Run the new analysis against actual broker records before making performance or strategy-ranking claims.

Local pure-analysis test result: 9/9 pass. GitHub Actions run 44110216073: success. The authorized VPS connection remains blocked by its monthly usage cap, so the fresh broker comparison and any new 3-7-lot actual execution remain unverified.
