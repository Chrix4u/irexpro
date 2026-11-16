# iRexPro — MAIN versus COUNTER direction research (16 November 2026)

## Purpose and status

**Running mode: virtual, read-only. No opposite-side orders are submitted to Pepperstone.** The main strategy remains authoritative and unchanged. A counter model, labeled `COUNTER` / `COUNTER_SIM:${trade_id}`, is paired with each actually opened main trade `MAIN:${trade_id}`. This makes the two directions easy to distinguish and compare while preserving the existing account safety gates.

The historical test shows the main engine identity was the same on Friday 13 Nov and Monday 16 Nov: `irexpro-multimodel-ensemble-v1/demo-v1`, policy `m1-tactical-v2-m5-lifecycle`. Verified API process start was Thursday 12 Nov 18:58 UTC; AI engine process start was Thursday 12 Nov 10:22 UTC. Neither service was restarted between Friday and Monday. Friday included distinct strategy routes; all ten Monday trades were `TREND_CONTINUATION`.

## First 16 November comparison (snapshot around 15:35 UTC)

| Day | Actual MAIN trades | Actual MAIN net USD | Virtual COUNTER comparable | Estimated COUNTER same-horizon net USD | Virtual COUNTER wins | Combined virtual hedge estimate |
|---|---:|---:|---:|---:|---:|---:|
| Friday 13 Nov | 20 | +170.35 | 19 | -547.65 | 6 | -376.74 (19 comparable pairs plus 1 main not paired) |
| Monday 16 Nov | 10 | -313.36 | 10 | +63.99 | 8 | -249.37 |

Do **not** mistake the same-horizon estimate for real broker-executable P&L. It uses the original broker entry and exit time plus a reverse-side M1 spread proxy and one round-trip commission, and compares equal lot sizes. A real equal-lot dual-direction hedge at the same price typically pays double spread/commission while offsetting directional P&L; it is not a guarantee of profit.

## Independent mirrored stop/target sanity check

The initial Monday USDJPY SELL on 16 Nov opened 05:52 UTC, closed 06:02 UTC at -$102.83 net. The opposite virtual BUY held until the original close estimates +$52.71, but the mirrored-stop M1 first-hit proxy reports `VIRTUAL_STOP_FIRST` and estimated -$100.84. The minute-level stop estimate is itself not a guaranteed execution outcome because the first partial minute and tick-level sequencing are unobservable. This highlights why simply reversing the signal is not a complete trading strategy.

## Implementation

- Read-only CLI: `apps/api/scripts/audit-pepperstone-main-counter-virtual.cjs`
- Tests: `apps/api/scripts/audit-pepperstone-main-counter-virtual.test.cjs`
- Private report: `/home/lightworld/webapps/irexpro-research/counter-direction/latest-report.json`
- One-off: `cd apps/api && node scripts/audit-pepperstone-main-counter-virtual.cjs`
- Continuous: same program with `--watch` polls every 120 seconds, only reprints changes, overwrites one bounded JSON report, handles open-position estimated marks and broker-confirmed realized outcomes independently.

Owner scope is the configured VPS user plus an actual `pepperstone-ctrader` connection of `account_type='DEMO'` and `account_currency='USD'`; no live accounts, broker trading API calls, or account credentials are exposed in output. All database reads run in `BEGIN ... READ ONLY` transactions with a statement timeout. The report is created with mode 0600 and directory mode 0700.

## Next development gates

1. Verify cTrader **hedging/netting capability** and account-level allowance for opening an opposite independent position. Never bypass the existing opposite-position, execution authority, allocation and leverage gates.
2. Obtain timestamp-exact entry/exit bid/ask or executable fill telemetry before claiming a virtual result is realistic. Current M1 candle spread is only an approximation.
3. Build a broker-independent **counter-direction strategy**, not a blind reverse order: separate entry/timing qualification, stop, target, cost/fee checks, max loss and kill switch. Train and evaluate over independent out-of-sample periods.
4. Build an authenticated per-user dashboard displaying labels MAIN versus COUNTER, with a prominent broker-executed versus virtual badge and daily scoreboards. Do not expose the private owner report through public assets.
5. A separate explicit feature flag and security review is required before any dedicated DEMO counter order can be considered. Keep real-money trading disabled until sustained positive prospective evidence.
