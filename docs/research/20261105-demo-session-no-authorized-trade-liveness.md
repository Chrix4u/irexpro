# DEMO session liveness vs execution readiness — 2026-11-05

## User issue

The user reports that the iRexPro cTrader DEMO AI has not opened a trade since the afternoon deployment. We checked the real VPS at approximately **19:41 UTC on November 5, 2026**.

- Staging SHA `35d72204` deployed and healthy; HTTP 200; API, web, admin and AI PM2 processes online.
- Exact broker-bound `ACTIVE` `FULL_AUTO` cTrader DEMO session began **13:05:33 UTC**.
- **0 trades opened** in `trading.trades` after session start; **0 broker-native M1 approvals**. No evidence that the broker connection, minimum lot or market feed is stopping an already-qualified entry.
- Fresh cTrader one-minute candles at 19:41 UTC for **AUDUSD, EURUSD, GBPUSD**, with 10 bars per pair in the latest 10-minute interval.
- The 30-minute scan window contained **180 evaluated decisions, 49 non-ABSTAIN candidate decisions, zero broker-authorized and zero successful executions**.
- The 60-minute route sample: ensemble/Plan B failed admission **94** times among the non-ABSTAIN candidates; market outside validated envelope **90**; continuation entry timing not ready **46**; estimated net payoff inadequate **36**; early-transition pair-side degraded **25**. Counts overlap. Only **one** Plan B candidate was admitted, and **zero** reached an executable primary path in the latest one-hour window.
- The focused session (exact connection) had been active **over 6h 35m**, still without any actual broker position.

## Root cause and economic risk

The main obstacle is **no newly qualified executable signal**. This is not a stopped model, lost data feed or evidence of a cTrader order-adapter fault. Structural policy restrictions amplify the problem: fallback entry routes remain in DEMO probation following after-commission losses, while the remaining early-transition primary route is often vetoed for weak observed route/pair-side results. Those are deliberate protections, not provider errors.

The 2026-11-05 closed-trade seven-day cTrader DEMO sample documented in `docs/research/demo-zero-new-trade-root-cause-20261105.md` returned **112 trades, gross −€36.37, commissions −€172.72, net −€209.09**. PR #633 independently measured blocked Plan-B candidate 5-minute/15-minute quotes across only three market days; returns were negative on average. We must not simply lift vetoes to reach a desired trade frequency, or pretend that 0.20 lots can make losing trades profitable. No route can currently be declared profitable based on that evidence.

## Fix implemented in this PR

The **existing 30-second, read-only, account-bound `/ai/external/vps-forex/m1-tactical/entry-diagnostics`** query now includes a small **execution funnel** in addition to the original last-60-minute counts:

- Exact active session age in minutes (derived from `started_at`).
- Non-ABSTAIN decisions admitted by the Plan B paper gate.
- Decisions with an otherwise executable primary Plan B authority path.
- Those primary candidates vetoed by weak early-transition reliability.
- Otherwise-eligible fallback candidates blocked by genuine probation, **excluding historical false probation** when the saved path is `BLOCKED`/`UNKNOWN`.

The backend derives a tightly bounded **observation-only** operating state: no session, no recorded scan, no setup, scanning with zero broker-authorized entries, or recent broker-authorized entry. This deliberately **does not expose writable authority**.

The AI Trading card now explicitly distinguishes **scanning** from **execution readiness**, displays session duration and funnel counts, and highlights when scans are active but no candidate earned broker authorization. The frontend validates all new counts/enum values before accepting them and discards stale/invalid evidence. It leaves Start/Stop, reset, four-second core feed, active session, account, position, lot policy and all actual trade permissions unchanged.

## Validation

- Existing active-account scoped SQL extracted from the new backend source executed **read-only** against staging, proving the current-session data and returning e.g. `active=1|age=401m|evaluations=357|candidates=87|broker-authorized=0|planB=1|primary=0|reliability=0|fallback-probation=0`.
- Backend unit tests include empty inactive session, live scans with/without candidates, real authorization, strict numeric evidence, exact account/broker/session SQL scope.
- Frontend regression covers valid/invalid enum/counts, responsive trading control without altering Start/Stop, and user-visible liveness wording.
- Existing paid service, market-data provider, model weights, broker execution, risk gate and stop/TP logic untouched.

## What this does NOT accomplish

This status and model-evidence improvement **does not make trades executable**. The research evidence collected to date is insufficient to safely loosen the 0.20–4.00 lot/risk, event-risk, recent-loss, fee or shadow-probation gates. Next substantive work should improve and independently validate net expected payoff (particularly trend continuation), reduce expensive adverse exits and then graduate a qualified strategy to carefully capped DEMO execution. Until then, any guaranteed trade-frequency promise would be misleading.
