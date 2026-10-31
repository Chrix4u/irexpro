# Profit Protection Exit Quality Report Design

## Goal
Give each authenticated iRexPro user an auditable view of how Profit Protection exits performed after closure, without mixing counterfactual research with authoritative financial truth.

## Source of truth
- Actual trade economics come only from `trading.trades`.
- Counterfactual outcomes come only from `trading.post_entry_shadow_observations` rows where:
  - `artifact = 'profit-protection-counterfactual-v1'`
  - `checkpoint_minutes = 240`
  - `execution_authority = 'NONE'`
  - `modifies_execution = false`
- Every query is scoped by `t.user_id = authenticatedUserId`.

## API
Add authenticated `GET /api/v1/trading/reports/profit-protection-exit-quality`.

Supported filters:
- `brokerConnectionId`
- `from`, `to` (trade close timestamps)
- `instrument`
- `direction` (`BUY`/`SELL`)
- `strategyRoute` (`CONFIRMED_REVERSAL`, `EARLY_TRANSITION`, `TREND_CONTINUATION`, `UNKNOWN`)
- `outcome` (`TP_FIRST`, `SL_FIRST`, `AMBIGUOUS_SAME_M1`, `NEITHER_4H`, `DATA_GAP`)
- `smallProfitOnly=true` for realised profit `> 0` and `<= 6` in the trade's account currency
- `page`, `pageSize` (max 100)

The response contains:
- overall summary for the entire filtered result, never just the page;
- route breakdown;
- paginated trade detail rows.

## Metrics
Summary includes:
- total evaluated exits;
- resolved barrier exits (`TP_FIRST + SL_FIRST`);
- TP-first and SL-first counts/rates;
- ambiguous/neither/data-gap counts;
- small-profit count and small-profit TP-first count/rate;
- actual realised P&L only when all filtered rows share one proven account currency; otherwise aggregate P&L is `null` and currency breakdown is returned;
- average actual exit R from the tracer's durable `actual_exit_r` value;
- average theoretical counterfactual R for resolved barrier outcomes;
- average R delta (`counterfactualR - actualExitR`) for rows where both are known.

Counterfactual barrier R uses the original trade barriers and fill price (fallback requested entry):
- risk distance = `abs(entry - stopLoss)`;
- TP target R = `abs(takeProfit - entry) / risk distance`;
- `TP_FIRST` counterfactual R = TP target R;
- `SL_FIRST` counterfactual R = `-1`;
- all other outcomes have no counterfactual R.

This R comparison is explicitly theoretical and excludes later execution costs/slippage. It must never be presented as realised P&L.

## UI
Add `/trade/history/profit-protection` using the existing DashboardShell/history visual language.

The page shows:
- summary cards for Evaluated exits, TP later, SL later, Small wins that later hit TP, and Average R delta;
- an explanation that counterfactual outcomes are research evidence, not realised returns;
- one-row filters with date range, instrument, direction, route, outcome, and Small profits only;
- route breakdown table;
- paginated detail table with close time, pair/side, route, actual P&L/currency, actual exit R, later outcome, minutes to barrier, theoretical counterfactual R and R delta;
- link back to Closed Trade History.

## Safety / correctness constraints
- Read-only: no execution or policy mutation endpoints.
- Tenant-scoped by authenticated user on every query.
- No cross-currency monetary summation.
- No fabricated barrier ordering for ambiguous/data-gap outcomes.
- Numeric R calculations return `null` when entry/barrier/risk evidence is invalid.
- Server owns all calculations; the browser only formats returned values.
