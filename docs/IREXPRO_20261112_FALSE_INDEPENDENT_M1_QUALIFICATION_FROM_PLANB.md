# iRexPro — independent M1 canary falsely qualified by primary Plan B trades

**Incident 12 November 2026 (Ghana/UTC) | Pepperstone cTrader DEMO**

## User-observed facts

- Earlier PRIMARY_PLAN_B orders used 2 or 4 lots.
- At 21:15:19, a QUALIFIED_CONTINUATION exception opened AUDUSD SELL
  **0.01 lots**, filled 0.68053, SL 0.68101, TP 0.67971.
- As of around 21:53, the independent broker-native quote was
  bid 0.68080 / ask 0.68082, roughly 2.9 pips adverse to a SELL
  (the SELL position closes against the ask).
- At 21:52 path observation, max favorable +$0.05, max adverse −$0.38,
  and the trade remained OPEN. Those are running path metrics,
  **not realized net P&L or evidence the stop was hit**.
- At entry, primary Plan B had score **0.494146**, was
  **not paper-admitted**, and its expected net return was
  approximately **−0.087935R**. M1 statistical projected net
  **+0.24620R** with confidence **0.738**, and trained-expert overlay
  was UNAVAILABLE. The independent exception deliberately allowed
  M1 execution without Plan B.
- Plan B's historical realized execution path must not be presented
  as independent M1's own observed success.

## Reproduced root cause

`M1TacticalEvidenceService.loadQualifiedM1ContinuationAfterFeeEvidence`
attempted to prove the independent QUALIFIED_CONTINUATION after-fee
expectancy from seven CLOSED exact owner/broker/pair/side/M1-route trades.
Although correctly scoped by `d.route='M1_TREND_CONTINUATION'`,
it did **not** scope by originating execution authority.

An as-of-21:15 read-only SQL replay of the **exact seven AUDUSD SELL
closed trades** showed that ALL SEVEN had
`ti.metadata->>'multimodel_execution_authority_path'='PRIMARY_PLAN_B'`.
Their sizes were 2–4 lots; five net winners after paid commission and
two net losers. The number of independently closed
`QUALIFIED_CONTINUATION` AUDUSD SELL outcomes was **ZERO**.
This is an attribution error / unproven strategy promotion.

## Contained fix

Add a hard provenance predicate to the **after-fee qualification query**:

```sql
AND ti.metadata->>'multimodel_execution_authority_path'
    = 'QUALIFIED_CONTINUATION'
```

The existing 7-trade, >=5 net-win, positive after-commission and
positive-recent-net-R requirements are unchanged. An empty independent
cohort fails safely (`sampleCount=0`, `complete=false`), so the
additional DEMO probation continues blocking independent fallback
until a legitimate, separately validated promotion is designed.

The primary Plan B path, its features, lot sizing, SL/TP geometry,
broker-risk and account safety checks are **not modified**. No
open-trade row, stop-loss, order or take-profit was edited; no
counterfactual order was placed. Route-level reliability may continue
to observe primary fills for diagnostics, but it **cannot independently
authorize this DEMO exception without the now correctly sourced
after-fee evidence**.

## Follow-up

- Do NOT raise the experimental 0.01-lot cap to 2 or 4 merely
  because the trade lost money.
- Continue observing actual M1 quote paths, prompt entry vs late
  retrace, spread, stop survival and net after-cost outcomes.
- Investigate fallback-vs-primary route precedence in a separate
  test-backed change. Do not claim that fixing historical
  provenance alone will create more Plan B orders.
- Actual broker fills and prospective independent results, not
  backfilled model labels, are required for future promotion.

## Confirmed close and pre-rollover timing defect (22:02 UTC)

The independent 0.01-lot trade closed at 22:01:01 with provider
`BROKER_CLOSE`, exit ask 0.68143, gross realised P&L −$0.90,
commission −$0.06, swap −$0.03; **net −$0.99**.
Its planned stop price was 0.68101, a difference of 0.00042 / 4.2 pips.
The broker's cTrader bid/ask quote recorder, scoped by this EXACT
broker connection, observed at 22:01:21 a bid of 0.68016 and ask of
0.68143: spread **12.7 pips**, compared with 0.3 pip at 21:58:56.
The close price exactly matches the observed post-rollover ask.
This is STRONG evidence of rollover spread/execution exposure but
`BROKER_CLOSE` alone does not prove the internal cTrader stop-trigger
event or precise intrasecond slippage mechanism.

The trade was opened at 21:15 UTC in November, exactly 45 minutes
before the New York 17:00 EST rollover. A 4.8-pip stop is materially
smaller than the 12.7-pip spread observed at rollover; this M1
fallback trial should never enter close to the dealer rollover unless
there is a verified exit lifecycle that will finish before the
liquidity transition.

**Supplemental narrow mitigation:** use the shared timezone-aware
`isForexPreRolloverHour()` clock to deny the independent
QUALIFIED_CONTINUATION canary permission during NY hour 16,
i.e. 21:00–21:59 UTC in winter and 20:00–20:59 in summer.
Keep the existing 17:00 NY rollover veto; neither this new guard
nor provenance correction modifies primary Plan B, LIVE execution,
position sizing, or already-open broker trades.
