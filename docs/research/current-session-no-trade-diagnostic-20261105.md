# Current-session DEMO new-entry diagnostic — 2026-11-05

## Why

The previous focused three-pair release (#629, main SHA `7e263feb`) is successfully deployed to staging with all four PM2 services online, website HTTP 200, release/UAT workflows successful.

Post-deploy sanitized 24h diagnostics showed one ACTIVE FULL_AUTO session, while older M1 submissions were marked SESSION_INACTIVE. A user/account-matched read-only PostgreSQL check established that those inactive submissions were evaluated **before** the current session started at 2026-11-05 13:05:33 UTC. The current session is ACTIVE, bound to the same user and broker as current decisions. **Do not interpret earlier failures as proof of a current session problem.**

A fresh one-hour cohort after the current session began contained 360 M1 decisions for AUDUSD, GBPUSD and EURUSD, including 69 non-ABSTAIN decisions, **0 broker-authorized and 0 successfully executed** decisions, and **0 SESSION_INACTIVE** outcomes. The most frequent overlapping blockers were `ENSEMBLE_NOT_PROMOTABLE_ADMISSION` (324), `MULTIMODEL_PLAN_B_NOT_ADMITTED` (324) and `MULTIMODEL_CONTINUATION_TIMING_NOT_READY` (307). This is evidence of **model admission/timing**, not data-feed disconnection, execution broker failure, or a request to dilute the risk gate. Counts are persisted decisions, not independent trade opportunities.

## Change

New authenticated, read-only endpoint `GET /ai/external/vps-forex/m1-tactical/entry-diagnostics`:

- Scopes by the authenticated user and their **currently ACTIVE** `FULL_AUTO` session, joined to the **exact current cTrader DEMO broker connection**; returns no session/connection/user IDs.
- Includes only three frozen eligible DEMO new-entry pairs `AUDUSD`, `GBPUSD`, `EURUSD`; research-only USDJPY, USDCAD, USDCHF cannot distort this view.
- Time range: last 60 minutes **and not before the current session began**. Excludes old-session and historical SESSION_INACTIVE outcomes from the present-day explanation.
- Reports decisions evaluated, non-ABSTAIN decisions, broker-authorized decisions, execution successes and SESSION_INACTIVE. Top three model causes are curated, predeclared human-readable labels and counts; causes **overlap**.
- If no matching active cTrader DEMO session exists, emits `NO_ACTIVE_CTRADER_DEMO_SESSION` with zero scoped counts; never displays previous account's data as current.
- The AI Trading card polls separately every **30 seconds** only while AI Trading is on in DEMO FULL_AUTO mode. No response is allowed to block the main 4-second Start/Stop and market refresh. Invalid/unavailable responses clear only the diagnosis, not the session controls.
- **No change** to trading authority, commission, risk, kill switch, minimum/preferred lot sizes, partial exit, position close, or user-required risk reset.

## Interpretation

This is a diagnostic, **not a model promotion**. A counted broker-authorized decision is not itself proof of a filled broker order, and one decision can contribute to multiple leading blockers. Improvements to expected net profit require forward, independently fee-verified outcomes and prospective comparison, not forcing order volume. Keeping research-only pair telemetry remains important.
