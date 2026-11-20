# Pepperstone cTrader DEMO profit-protection decision record — 16 Nov 2026

## Status
**Research only; NOT authorized for broker-close promotion.** This is a forensic analysis of the USD Pepperstone DEMO owner scope. No new entries, exits, broker-side stops, position sizing, trading session settings, or model parameters were changed.

## Findings
- The enabled early-net-profit protection explicitly covers observed peaks from **0.20R up to (but not including) 0.50R**, subject to broker identity, fresh quotes, prior fee samples and after-cost profitability. A USDCAD BUY on 16 Nov opened with 2.85 lots and closed via `PROFIT_PROTECTION` for $16.81 booked net, after $17.10 commission.
- The losing AUDUSD SELL peaked at $14.49 on approximately $80.50 initial risk (0.180R), below the early-rule activation. It ended at **-$85.33 booked net**.
- The losing USDJPY SELL peaked at $108.18 on approximately $99.73 initial risk (1.085R), above the early-rule range. Its first legacy `WOULD_CLOSE` research signal was recorded while the broker mark was about $78.24, but the action was `HOLD_BROKER_TP_SL`; it eventually booked **-$102.83 net**. The simulated protected net floor ($67.46) is not a broker fill guarantee.
- Across 72 closed demo trades in the 10-day first-signal audit ending around 13:25 UTC 16 Nov: legacy research first-close recommendations were recorded *before actual close* on 16 trades; 11 later won, five lost. Of 11 with an extra-cost estimate, 11 had a positive observed mark after the conservative reserve. This is not an executable outcome study.
- The separately confirmed high-peak giveback shadow qualified just **one** trade; that trade later reached TP and booked **+$127.28 net**. Promoting that rule unmodified would risk sacrificing such winners.
- The peak-to-loss rescue shadow qualified six trades: **three later won and three lost** (actual combined net +$99.20). Rescue fires after a loss, and whether a broker close would improve after-cost performance still needs broker-native first-touch and execution-cost testing.

## Reproducible evidence
- `node apps/api/scripts/audit-pepperstone-profit-lock-coverage.cjs` — risk-band coverage by historical peak.
- `node apps/api/scripts/audit-pepperstone-first-shadow-economics.cjs` — earliest valid pre-close simulated signals and later actual outcomes.
- First-signal report: `/home/lightworld/webapps/irexpro-research/profit-lock-first-signal/latest-report.json`.
- Coverage report: `/home/lightworld/webapps/irexpro-research/profit-lock-coverage/latest-report.json`.

## Next development gates before changing demo execution
1. Collect independent broker-native, timestamped quote and spread snapshots for each prospective high-peak reversal candidate. Do **not** assume a recorded unrealized mark would be an executable close.
2. Replay both an early-profit candidate and a reversal-confirmation candidate on **the same fixed cohort**, including full commission, spread, slippage stress, delayed dispatch, possible TP recovery and partial data gaps.
3. Report by session/day/instrument and run purged forward holdouts; use actual after-cost net P&L, profit factor, drawdown, TP foregone and invalid-evidence rates. A one-day apparent benefit is insufficient.
4. Preserve current LIVE-account no-authority; refuse activation if broker identity, sizing, stop, quote freshness or cost evidence is missing.
5. Keep a human-reviewed demo-only feature flag OFF until independent validation; do not turn a research observer into an exit authority in the same commit.
6. Separately investigate entry quality. Historical peak/R bands use hindsight, so the 24 sub-0.20R eventual losers cannot serve as an entry gate without a causal pre-entry predictor.

## Interpretation
A trade can be green and fail to qualify for automated protection. That is currently deliberate, not an intermittent failure of the timer. Yet the excluded high-peak case exposes a material opportunity for improved loss prevention. Broadening protection blindly is likely to truncate legitimate take-profit runners. The safe next step is a causal, cost-aware, prospectively monitored challenger with an independently evaluated release gate.
