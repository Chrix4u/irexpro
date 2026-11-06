# cTrader DEMO screenshot: research-only pair and Plan-B/M1 timing conflict

Date: November 6, 2026. Read-only status and UI clarity only.

## Confirmed reasons

The screenshot displayed GBPUSD BUY at readiness 69: Plan B admitted an
EARLY_TRANSITION idea, but M1 returned HIGHER_TIMEFRAME_CONFLICT. The
independent M1 confirmation rule correctly withheld dispatch.

The second screenshot displayed USDJPY BUY with a -0.01R net model
forecast. USDJPY is one of the three research-only instruments under
the current focused DEMO policy. AUDUSD, EURUSD and GBPUSD alone can
place DEMO orders. The -0.01R is the model's estimate after baseline
spread/slippage, NOT the historical p90 broker-commission admission
floor, which has already been switched to SHADOW only in the current
cTrader DEMO rollout. This distinction was poorly surfaced by the UI.

Live read-only 30-minute decision audit (as of 11:38 UTC):
GBPUSD had 58 M1 decisions, 4 non-ABSTAIN routes, 29 HTF conflicts,
29 economic-return vetoes, 7 Plan-B paper-admitted decisions, and
no broker-authorized entries. USDJPY had 54 M1 decisions,
27 economic-return vetoes and six Plan-B paper-admitted decisions,
but remains research-only and must never dispatch.

## Read-only missed-timing outcome study

Ran the repository's standalone read-only counterfactual
audit-planb-m1-timing-counterfactual.cjs. It sampled 4,000
decisions (truncated, NOT an exhaustive independent time window)
and 192 de-duplicated Plan-B-admitted timing-rejected episodes.
These are simulated 15-bar outcomes with an estimated cost,
not filled broker trades, and should not be promoted to policy.

- HIGHER_TIMEFRAME_CONFLICT: 115 observed episodes,
  50 positive versus 65 negative, sum -5.7725R.
- GBPUSD BUY with a timing veto: 20 episodes, 5 positive
  versus 15 negative, sum -7.5275R.
- Timing-only vetoes: 162 episodes, summed -13.17R.

This evidence argues AGAINST removing the independent HTF
conflict veto simply to increase entry count.

## Narrow display fix

1. Exact server-authoritative DEMO entry list is passed from
   the current M1 runtime status to the user-scoped latest
   decision SQL. Real broker authority remains top priority;
   otherwise, at the same completed bar, eligible entry pairs
   are preferred above research-only instruments. No order
   or model changes.
2. A research-only pair, if surfaced, is explicitly marked
   "Research-only pair — no DEMO entry", with the actual
   allowed list and a separation of baseline model expectancy
   from historical commission shadow.
3. A Plan-B admitted, M1 abstained HTF conflict has the
   distinct headline "Plan-B admitted — M1 timing conflict".
4. Keep the original signal confidence as a score but never
   mark a research-only or HTF-conflicted setup executable.

No changes to live model weights, lot sizes, order dispatch,
commission veto, Plan B rules, M1 timing, news or account
risk checks, stop-loss, take profit or allowed instruments.
