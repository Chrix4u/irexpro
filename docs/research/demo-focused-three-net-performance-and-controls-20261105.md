# Focused three-pair cTrader DEMO trial, with research on all six — 2026-11-05

## Purpose

User requested two cards in the AI Trading workspace (broker account + allocation together; AI Start/Stop and protection in a wider card) and a data-driven reduction of new trading to three pairs, retaining research monitoring for the others.

**No model has demonstrated positive realised net expectancy in the assessed EUR broker cohort. This is exposure containment, not a claim of an edge or a model promotion.** The earlier proposed mandatory USDJPY trade route is rejected by the measured data.

## Observed read-only broker-native EUR FULL_AUTO DEMO closed trades

Read-only aggregate from PostgreSQL `trading.trades`, joined on the matching `trading.trading_sessions` (FULL_AUTO) and `broker.broker_connections` (DEMO), without exposing account identifiers. The three historical windows (7/30/90 days) refer to closure time, UTC. Each net trade is `realised_pnl - abs(commission) + swap`; a trade with any missing fee component is excluded from complete-fee net sums, but counted in `trades`. These are historical account-level observations, not model-attributed causal comparisons; the date range reflects the available short history (30-day and 90-day identical).

| Pair | 30d closed / complete fees | 30d gross (EUR) | Commission (EUR) | 30d net (EUR) | 7d net (EUR) | 7d trades |
|---|---:|---:|---:|---:|---:|---:|
| AUDUSD | 60 / 60 | +24.09 | 79.74 | **-55.65** | -36.59 | 44 |
| GBPUSD | 13 / 13 | +0.09 | 24.80 | **-24.71** | -17.68 | 9 |
| EURUSD | 32 / 31 | -28.89 | 56.06 | **-84.95** | -14.36 | 19 |
| USDCHF | 5 / 5 | +0.17 | 5.20 | **-5.03** | -5.03 | 5 |
| USDCAD | 39 / 39 | -18.74 | 68.41 | **-87.15** | -83.52 | 30 |
| USDJPY | 27 / 27 | -73.92 | 50.26 | **-124.18** | -73.11 | 19 |

Every instrument has negative post-cost evidence. GBPUSD's 13 trades and EURUSD's 31 complete-fee trades do not prove a profitable edge; USDCHF's five trades are particularly insufficient. AUDUSD has the strongest sample size and the best 7d mean net among the 6, but still loses money. The controlled top-three shortlist prioritizes AUDUSD (largest sample), GBPUSD (lower historical total losses and available evidence), EURUSD (large sample and modestly better recent losses), *not* USDJPY by reputation. The excluded pairs are observational only, not labeled losers indefinitely.

## Implemented configuration

- **Executed entry route** remains the original, broker-native, commission-aware, **Primary Plan-B** only on cTrader DEMO, with all existing model, stop-risk, broker margin, lot size, loss-streak, portfolio and drawdown gates intact; current lot ceiling remains 4.00 and 0.20 preferred when account supports it. No experimental fallback is promoted.
- **Three eligible pairs for NEW DEMO positions:** `AUDUSD`, `GBPUSD`, `EURUSD`. This allowlist does *not* force any trade: all three have negative history and must still pass the entry financial and safety gates.
- **Research-only pairs:** `USDJPY`, `USDCAD`, `USDCHF`. Their M1 and Plan-B decisions can continue recording read-only outcomes but `M1_DEMO_INSTRUMENT_RESEARCH_ONLY` blocks scheduler order dispatch and new-entry-triggered direction-flip closures. A separate central Strategy Orchestrator gate also rejects exact *promoted DEMO* external signals for excluded symbols before the risk/dispatch stage, so replay or alternate intake cannot bypass the focused list. Existing broker positions are neither force-closed nor invalidated by this policy.
- **Scanning:** the three entry-eligible symbols are evaluated FIRST, then the three research symbols, each minute; all six remain monitored. This is prioritization and scope reduction, **not a validated reduction in model inference latency**.
- **Non-DEMO operation:** no extension of LIVE trading authority and no change to existing PAPER policies. This is a *DEMO-specific* configuration in the active module binding, independent of immutable v7/v8 historical rollout policies. A missing allowlist preserves older policy behaviour; explicit empty allowlist rejects all new DEMO candidates.
- **UI:** one broker+allocation card and one wider AI Trading card. The second card obtains server-verified entry/research pairs from M1 status. Reset Protection is *not* invoked. UI still enforces immutable suspension until user chooses a server-authorized, explicit reset. No automatic risk reset, no allocation rebind.

## Next qualification criteria

Track each pair with **verified net-of-fee profit factor, average net per trade, drawdown, consecutive loss count, stop-vs-later-TP outcomes and sufficient independent closed examples**. Reintroduce excluded pairs only when prospective evidence justifies the risk, not because of a single large missed profit. A 30+ fully costed sample per pair with positive risk-adjusted expectancy across market periods is a useful minimum *screen*, not proof of LIVE safety. Re-evaluate the three-pair focus before any LIVE promotion; keep risk-stop and commission floor closed when economics are negative.

## Validation

Target backend scheduler, policy and existing risk/execution suites; frontend trade card UI, scanner schema and browser responsive regressions; full API/web typecheck and GitHub CI/security/release gates. VPS staging deploy only through exact-main SHA. Confirm web 200, PM2 status and backend status reporting three + three. **Do not auto-restart the suspended AI trading session.**
