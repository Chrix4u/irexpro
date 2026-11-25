# iRexPro — Confirmed Reversal entry and profit-protection review
**19 November 2026 · Pepperstone USD DEMO · read-only evidence**

## Immediate result

The three settled losses at 01:13–01:14 UTC were all broker-confirmed **CONFIRMED_REVERSAL** orders using the owner DEMO continuous advisory alternative path. Their ordinary M1 decisions were **ABSTAIN**, and the independent expert's final state was **ABSTAIN**.

| Broker-verified position | Opening (UTC) | Net after commission | Observed favorable broker P&L | Peak/initial stop-risk | Close reason |
|---|---|---:|---:|---:|---|
| AUDUSD BUY · 1.72 lots | 01:08:52 | -$39.56 | +$25.80 | 0.30R | AI_CLOSE_SIGNAL |
| USDCAD SELL · 1.40 lots | 01:08:16 | -$31.84 | +$7.52 | 0.154R | AI_CLOSE_SIGNAL |
| USDJPY SELL · 1.40 lots | 01:09:17 | -$48.79 | $0 | 0.00R | BROKER_CLOSE |
| **Total** | | **-$120.19** | | | |

**Do not classify BROKER_CLOSE as proven stop loss, discretionary manual closure, or a specific protection trigger without provider reason evidence.** Likewise, AI_CLOSE_SIGNAL is not necessarily a single specific exit algorithm without durable trigger evidence.

## Actual forward cohort versus prior training

Frozen prospective shadow activation: **2026-11-18 21:39:43.892 UTC**.

**Confirmed Reversal, post activation**: 7 settled, 3 wins, 4 losses, **-$99.26 after costs**, only **one independent UTC trading day**. Ordinary M1 reversal confirmation was missing in all seven; final independent expert state was ABSTAIN in all seven. Neither label alone distinguishes winners from losers.

**M5 directional body-pressure hypothesis, Confirmed Reversal only** (pre-registered by the existing independent forward monitor, not automatically promoted):

| Cohort | Opposing M5 candle-body pressure | Other/unknown pressure |
|---|---|---|
| Prospective 19 Nov | 2 trades, 0 wins / 2 losses, **-$80.63** | 5 trades, 3 wins / 2 losses, **-$18.63** |
| Earlier historical cohort | 25 trades, 13 wins / 12 losses, **-$389.68** | 28 trades, 16 wins / 12 losses, **-$255.07** |

The historical cohort spans two independent days. Therefore the prospective two-loss subgroup is **not sufficient evidence for a hard M5 filter**. Such a filter would have rejected 13 historical winners too. Do not change Start/Stop, route direction or authorization on this basis.

## AUDUSD profit protection: factual threshold gap

- Audited original capital allocation stop-risk: **$86.00**.
- Broker-recorded best favorable P&L: **+$25.80 = 0.30R**.
- Current Confirmed Reversal broker-net profit lock requires a **0.50R+ peak**, with additional observed fee, fill, monotonic price and protective-floor requirements.
- The original allocation already contained a frozen historical commission estimate of **$6.00 per lot**, or **$10.32** at 1.72 lots. This is a conservative *extra exit reserve*; the broker unrealized peak is already broker-net.
- A separate **0.25R peak research hypothesis** would clear its *peak threshold* using the observed maximum and original historical commission estimate; it does **not** establish when the lower floor would have been touched, whether a valid live quote existed, or what a broker close could have realized.
- USDCAD reached only **0.154R**, below that research threshold. Its causal historical fee-per-lot record is also unavailable in this audit. USDJPY never went favorable.

A threshold-only retrospective is **not a simulated fill**, and must not be reported as cash saved.

## What is implemented now

New independent audit: `apps/api/scripts/audit-owner-demo-reversal-entry-exits.cjs`

- Uses an exact configured-owner, non-deleted Pepperstone cTrader **USD DEMO** broker connection.
- Joins settled broker positions to original intent, decision, and **pre-entry** capital allocation.
- Uses a **read-only repeatable-read** PostgreSQL transaction with a bounded cohort.
- Separates before-frozen-activation historical cases from genuine forward cases.
- Reports net realized P&L, as-of entry signals, M1 timing mismatch, independent expert state, M5 pressure, recorded initial risk and historical peak threshold comparisons.
- Writes a private machine-readable report to `/home/lightworld/webapps/irexpro-research/reversal-entry-profit-review/latest-report.json`.
- Performs **no trade placement, broker close, stop move, position sizing, Start/Stop update, strategy veto, model retraining or LIVE promotion**.

Run from `apps/api`:

```sh
node --test scripts/audit-owner-demo-reversal-entry-exits.test.cjs
node scripts/audit-owner-demo-reversal-entry-exits.cjs
```

## Decision and next threshold for change

**Keep the currently operating DEMO strategies unchanged** while the existing frozen, prospective loss-pattern observer continues gathering evidence. The next legitimate investigation is a *decision-time* 0.25R profit-floor shadow that captures quote freshness, documented fees and descending broker marks, compared with the current 0.50R protector. Never change the live threshold based solely on a final historical peak. Separately assess entry timing across at least several independent days rather than treating correlated one-minute trades as independent trials.

## Prospective 0.25R shadow monitor — no execution authority

The separate research observer is `apps/api/scripts/watch-owner-demo-low-peak-profit-shadow.cjs`
and its PM2 configuration is `irexpro-owner-low-peak-forward-shadow.pm2.config.cjs`.
It freezes a new activation timestamp and enrolls only positions that OPEN
after activation. It cannot retrospectively invent a hypothetical 0.25R
broker exit on the recently closed losing positions.

Every eight seconds it reads a bounded, READ ONLY broker telemetry snapshot
for the active FULL_AUTO, connected/authorized Pepperstone USD DEMO owner.
It requires pre-entry stop-risk and historical commission-per-lot evidence.
Missing or stale evidence cannot create a lower-peak crossing event.

The monitor compares a broker-net peak crossing of the **hypothetical 0.25R**
cost-aware peak gate with the untouched **production 0.50R** rule. It requires
two fresh, descending broker-net P&L observations, a positive cost reserve
and strictly verified original scope. A P&L crossing is **not** a valid
execution quote, broker stop amendment, proof of fill, or saved cash.

It writes an append-only owner-only journal, restart-resilient state and
a summary beneath:
`/home/lightworld/webapps/irexpro-research/reversal-low-peak-forward/`.

It does not submit, cancel or close an order; change Start/Stop; amend stops;
change lots; change a model; alter LIVE trading; or promote a strategy.
Testing command:
`node --test apps/api/scripts/watch-owner-demo-low-peak-profit-shadow.test.cjs`.
PM2 research worker (only after committing/pushing):
`pm2 start scripts/irexpro-owner-low-peak-forward-shadow.pm2.config.cjs`.
Several independent prospective trading days and fresh quote/fill checks
are necessary before considering an actual DEMO exit-policy change.
