# iRexPro Continuous Pepperstone DEMO Evidence Scorecard

## Purpose and safety

This is an **owner-scoped, READ-ONLY** research audit of real Pepperstone cTrader USD DEMO positions since the original advisory-start time **2026-11-16 23:36 UTC**. It distinguishes the first timeboxed four-entry advisory group from the **continuous** evidence-collection entries enabled at 2026-11-17 02:07:53 UTC. The data comes from broker-position/trade-intent and persisted path observations, not reconstructed scanner predictions.

The user explicitly requested **no cumulative trial-entry limit or scheduled expiry** so the system can gather more samples. This reporting tool has **no execution functionality** and **does not change** broker orders, entry approval, position sizing, existing stop-losses/TPs, risk gates, model-promotion status or LIVE accounts.

## Delivery

- `apps/api/scripts/audit-pepperstone-continuous-evidence.cjs`: bounded owner-scoped PostgreSQL `BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY` query, active broker/owner/same-session validation, independently closed broker trade P&L after signed commission + swap, route/cohort counts, outcome classifications, protected-close counts, win/loss rate, per-route profit factor, max realized-equity drawdown, and *separately displayed* open-position path.
- `apps/api/scripts/audit-pepperstone-continuous-evidence.test.cjs`: five node tests for independent fills versus repeated scans, open vs closed handling, missing commission, fee deductions and profit factor, invalid route/time, stale-market mark handling.
- Atomic, permission-restricted private report: `/home/lightworld/webapps/irexpro-research/continuous-evidence/latest-report.json`; no broker identifiers or account secrets are included in the report.
- Example command:

```bash
cd /home/lightworld/webapps/irexpro-staging/apps/api
node --test scripts/audit-pepperstone-continuous-evidence.test.cjs
node scripts/audit-pepperstone-continuous-evidence.cjs
```

## First factual scorecard, 17 Nov 2026 02:21:38 UTC

Seven actual qualifying trades: **five completed and two open**. All five completed have recorded signed commission and swap; **realized total −$27.12 USD**. The two open positions are excluded from closed net returns.

| Cohort | Plan-B route | Closed | Open | Realized net USD | Close type |
| --- | --- | ---: | ---: | ---: | --- |
| Original advisory | EARLY_TRANSITION | 1 | 0 | −120.81 | Broker close |
| Original advisory | CONFIRMED_REVERSAL | 3 | 0 | +62.91 | 3 profit-protection closes |
| Continuous evidence | EARLY_TRANSITION | 1 | 0 | +30.78 | Profit-protection close |
| Continuous evidence | CONFIRMED_REVERSAL | 0 | 2 | 0.00 realized | Not settled |

The first five closed trades' maximal **realized-equity drawdown** was $120.81. This is distinct from peak floating-profit giveback or live equity drawdown. Do not assume an unobserved profit factor for a route with no losses: `null` means not estimable.

At the report instant, broker database recorded USDCAD SELL **+$19.40 gross observed** and AUDUSD SELL **−$12.46 gross observed**; these are not realized, do not include prospective exit commission, and will fluctuate. The report explicitly identifies whether the stored path mark is less than 90 seconds old, rather than claiming a direct broker quote.

## Interpretation and next actions

The previous profit-lock code is still enabled for DEMO early-transition and confirmed reversal with independent historical after-fee evidence checks. Its 0.50R peak qualification (plus commission/risk buffers) was not met by some small favorable excursions; therefore those do not qualify for profitable lock, and a tiny gross win is not necessarily positive after fees. Do not relax floors merely to force closes without an independently tested positive-net condition.

Accumulate future **independent broker fills**, not per-minute scanner decisions. Monitor realized net, per-route fee drag, original SL/TP comparisons, floating peak-to-giveback vs actual exit economics, and failed market/stale-data validations. Any profitable real-money promotion needs separate explicit evidence and user authorization. **This script is not a scheduled automated monitor**; its report updates when the script runs.
