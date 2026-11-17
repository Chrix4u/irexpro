# iRexPro — Owner DEMO stop-loss versus prediction-direction research

**Created 17 November 2026.** Research-only; not deployed as an active trading decision.

## Why this audit exists

Prior Pepperstone DEMO incident reviews showed different cases: some positions were wrong nearly immediately, some first had positive broker-observed floating profit then closed at a loss, and others hit or nearly hit their original stop before the price later reversed. These are **different market patterns**, and an observed favorable price after an exit is not proof that the original stop was incorrectly placed.

The owner prioritizes forecasting **the correct side, expected move size and time horizon** over simply increasing lot size. The existing separate [direction-horizon replay](PEPPERSTONE_DEMO_DIRECTION_HORIZON_CAUSAL_REPLAY_2026-11-17.md) measures the first 1/3/5/10 minutes after the original prediction. This supplement measures those same intervals **after actual broker closure** and separately records original position economics and pre-exit favorable movement.

## Implementation

- `apps/api/scripts/research-owner-demo-post-stop-direction.cjs`: pure, deterministic classifier and route-level summary with no network, database or order action.
- `apps/api/scripts/research-owner-demo-post-stop-direction.test.cjs`: 10 tests.
- `apps/api/scripts/run-owner-demo-post-stop-direction.cjs`: read-only PostgreSQL runner requiring the configured owner's Pepperstone cTrader **USD DEMO** account, native M1 bid/ask price samples, and fully closed, sufficiently aged positions.
- `.github/workflows/research-post-stop-direction-ci.yml`: runs syntax checks and the pure Node tests, with no broker credentials.

The report includes actual fill, original SL, exit, direction, exit reason, observed highest floating P&L, commissions/swaps (only if fully reconciled), and broker M1 close prices 1/3/5/10 minutes **after** the closure. It measures post-close prices relative to both the *original broker fill* and *actual exit*, normalized by original price distance to SL. The BUY reference is the future broker **bid**, SELL reference is future broker **ask**. It does not use a future price to make an entry decision.

**Outcome categories:**

- `STOP_THEN_ENTRY_RECLAIMED` — a confirmed `STOP_LOSS_HIT` followed by a broker close favorable by >=0.1 initial stop-distance beyond original fill.
- `STOP_THEN_PARTIAL_BOUNCE` — price rose (BUY) or fell (SELL) >=0.1 original stop-distance beyond actual exit, without reclaiming the original fill.
- `STOP_WITHOUT_OBSERVED_RECOVERY` — valid follow-up quotes exist but did not meet either threshold.
- `STOP_FOLLOWUP_MISSING` — no valid broker quote samples, **not** a failed directional prediction.
- `BROKER_CLOSE_NEAR_STOP_UNCONFIRMED` — broker-close price near original stop, but the recorded cause is only `BROKER_CLOSE`; **never counted as a broker-confirmed stop**.
- Others remain explicit non-stop closures; an actual profit-protection close or take-profit must not be misclassified as an SL event.

This research intentionally **does not infer whether a wider stop would have survived**. Intra-candle low/high paths, earlier drawdown, new spreads and liquidation/margin impacts are not reconstructable from only end-of-minute prices. A favorable price after the original close also does not prove a profitable entry or exit after commission.

## Running on the authorised VPS

When VPS connectivity is available, run:

```sh
cd /home/lightworld/webapps/irexpro-staging/apps/api
node --test scripts/research-owner-demo-post-stop-direction.test.cjs
node scripts/run-owner-demo-post-stop-direction.cjs \
  --out=/tmp/irexpro-owner-post-stop-audit.json
```

The database runner opens `BEGIN READ ONLY` and selects only fully closed trades from the prior 24 hours with confirmed **USD DEMO** ownership and age of at least 12 minutes, using the four executable instruments (EURUSD, AUDUSD, USDJPY, USDCAD). It does not insert or update a row, call the broker adapter, move stops, alter lots, or change position-protection rules. The output defaults to terminal JSON and can write a protected `/tmp` report with file mode 0600.

## Interpreting performance

Compare each route separately; compute (1) percent of *confirmed* stopped trades later reclaiming original fill, (2) fraction of positions that first showed profit but closed net negative, (3) original stop-distance and after-cost net result, (4) prior M1/M5/H1 model consensus, and (5) whether the original prediction was right over the *original decision-time* 1/3/5/10-minute horizon.

A high reclaim rate is only a **hypothesis** for improved entry timing, a different prediction horizon or a volatility-aware SL design. It cannot automatically raise risk, stretch existing stops or invert trades. Validate any new directional rule on **chronologically later, non-overlapping episodes**, with actual bid/ask, margin, signed fees, and broker-realized net results.

## Validation and deployment status

GitHub Actions run [44092353107](https://github.com/Chrix4u/irexpro/actions/runs/44092353107) **completed successfully**, including all syntax and pure unit tests. The remote VPS connection hit its monthly usage quota during this session, so **the database runner has not been executed against current live DEMO records in this turn**. Current trade performance and this report's contents cannot be claimed without that execution. The baseline DEMO trading API remains intentionally unchanged by these research scripts.
