# iRexPro — owner Pepperstone USD DEMO profit peak giveback review and progressive protection rollout

**2026-11-20 09:28:43 UTC/Ghana — deployed after original code/test and active broker audit.**

## What was wrong

Owner observed extremely large **sampled peak-to-final-net giveback** with positions closed by `PROFIT_PROTECTION`. The broker's five-second tracked max favorable mark was **not guaranteed executable profit**, but the magnitude and frequency matter:

| Open Ghana | Pair / route | Sampled broker-reported peak USD | Actual booked final net USD | Captured |
|---|---|---:|---:|---:|
| 09:02:55 | USDJPY SELL / CONFIRMED_REVERSAL | 170.74 | 5.51 | 3.2% |
| 08:12:24 | USDJPY SELL / CONFIRMED_REVERSAL | 170.55 | 35.64 | 20.9% |
| 09:11:47 | AUDUSD SELL / EARLY_TRANSITION | 99.76 | 37.84 | 37.9% |
| 08:50:21 | AUDUSD SELL / EARLY_TRANSITION | 92.82 | 35.70 | 38.5% |

The 09:02 USDJPY close was **requested at 09:05:33.772**, 28 seconds after the sampled peak at 09:05:05.805. The server logged broker-net unrealized **65.03** at request time with a preexisting tiered floor of **128.055**, so the existing 75% trailing requirement was already overshot by a rapid price move. The provider reported actual closure at **09:05:35.132**, booked net **5.51** after **36.00** commission. Not correct to ascribe all giveback to the close-order latency alone: most occurred **before** the request. The close-time provider reason was UNKNOWN; the app-originated PROFIT_PROTECTION close intent is corroborated by the audit log.

The 08:12 USDJPY close was requested at **08:17:47.458**, provider closed **08:17:48.538**, peak **170.55**, logged broker-net **64.95** on request, booked net **35.64**. The 09:11 AUDUSD position had a logged broker-net mark **44.72** when closed with actual after-cost net **37.84**.

## Executable intervention (existing tested code, owner DEMO-only)

Activated the previously coded and tested **progressive TP-relative broker-net peak retention** via:

`IREXPRO_PEPPERSTONE_DEMO_PROGRESSIVE_TP_RETENTION=enabled`

Retained all companion opt-in flags:
`IREXPRO_PEPPERSTONE_DEMO_NET_PROFIT_LOCK=enabled`,
`IREXPRO_PEPPERSTONE_DEMO_ALTERNATE_NET_PROFIT_LOCK=enabled`,
`IREXPRO_PEPPERSTONE_DEMO_TIERED_RETENTION=enabled`.

Exact owner Pepperstone cTrader USD DEMO, active M1 Early Transition or Confirmed Reversal only. Existing position, price, broker lot matching, broker stop/TP agreement, initial risk, sufficient causal fee samples, declining broker mark, account validation and fee protection are **still mandatory**. LIVE and other brokers excluded. No new entries, no lot increases, no change in market orders, no stop amendment.

The progressive policy derives projected gross full-TP potential from the broker-confirmed entry/stop/TP geometry and lot-calibrated initial risk. Its fraction of observed peak relative to potential TP increases the existing tiered retention in bounded steps, up to **91%**, subject to a minimum 3× causal fee buffer. This remains a **mark-to-request** trigger, NOT a guaranteed broker fill or locked stop.

**Frozen unit tests using actual Nov20 high-peak geometry:** for a hypothetical later mark of $140 following the **$170.74 USDJPY** peak, the original tiered policy holds (floor $128.06) while progressive closes (floor **$152.62**). For the AUDUSD peak $99.76 and later mark $68, original holds (floor $64.84), progressive closes (floor **$71.97**). The tests do not assert any historical trade would have settled at these floors.

Test suites:
- `pepperstone-demo-progressive-peak-nov20.spec.ts`
- `pepperstone-demo-net-profit-lock.spec.ts`
- `live-demo-profit-protection.service.spec.ts`

**123 tests passed** before actual flag activation.

**Deployment verified**: PM2 `irexpro-api-staging` restarted at 09:28:35 UTC, startup log at 09:28:43 `ENABLED_DEMO_ONLY originalBrokerTP_SL=UNCHANGED LIVE=false`; API `/api/v1/health` returned HTTP **200**; AI/web/read-only shadow monitor remained online.

## Measurement — avoid judging the change by hypothetical savings

Added read-only `apps/api/scripts/audit-owner-demo-progressive-profit-retention.cjs` with frozen rollout activation **2026-11-20T09:28:43.000Z**. It divides broker-confirmed closed positions into:
- **BEFORE**: closed before actual activation.
- **AFTER**: opened AFTER activation.
- **STRADDLED**, excluded from either comparison.

It groups net USD, wins/losses, route, positive gross sampled peak, booked net, mean/aggregate peak capture, loss after positive peak, severe protected-close giveback, and time from recorded peak to broker closure.

Private artifact:
`/home/lightworld/webapps/irexpro-research/profit-protection-rollout/latest-report.json`

The existing owner read-only monitor refreshes it on its half-hourly cycle; **no new timer or order capability**.

Baseline at **09:30:45 UTC** for trades opened since 04:30 UTC: **30 settled**, 17 winners / 13 losers, after-cost net **-$563.93**, with **17 profit-protection exits**; summed sampled broker-net favorable peaks **$2,106.79** versus booked net **$1,014.14**, aggregate captured share **48.14%**. Eight protected closes retained under half their sampled broker-net peaks, and nine losing trades had previously observed positive peaks. This baseline is descriptive, not a broker-stop performance guarantee or causal comparator. At first snapshot, **0 settled AFTER-rollout trades**, so no performance claim is possible.

Before/after cohorts will differ in time-of-day, market, lot sizes and correlated pairs; neither small samples nor the observed retained-peak ratio prove an increase in expected returns.

## What remains unsolved

1. **Broker-side stop authority:** An app-side close triggered every five seconds cannot guarantee retaining 80–91% when the provider mark gaps downward rapidly. A genuine broker-acknowledged in-profit SL modification, with cTrader tick/minimum distance, verified quote side, immutable original TP, recheck and durable idempotent authority sync, is the appropriate next technical improvement. There is an existing read-only `verified-profit-runner-stop-shadow` and `demo-profit-stop-authority-sync` preflight; the latter explicitly **does not itself send broker amendments**. Do not assert that a protective profit stop has been installed.
2. **Profit over-harvesting:** Lower giveback triggers may harvest more immediately but can sacrifice later full-target winners. Study actual settled results against post-exit quote paths rather than assuming tighter exits improve expectancy.
3. **Account/strategy economics:** Losing exits have historically outweighed winning gains even when the profit-protection subsystem is functioning. Do not promote these demo models to LIVE based only on profit capture.

## Rollback

Set `IREXPRO_PEPPERSTONE_DEMO_PROGRESSIVE_TP_RETENTION=disabled` in the private `apps/api/.env`, restart only `irexpro-api-staging`, verify the startup banner reads `DISABLED`. This does **not** stop underlying 65%/75%/80% tiered owner-demo protection, broker TP or broker SL.

No additional owner DEMO sizing permission was created, and the separately authorized higher-lot trial still expires at **2026-11-20 12:00 UTC**.
