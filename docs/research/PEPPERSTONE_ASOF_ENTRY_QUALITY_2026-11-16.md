# iRexPro — As-of entry-quality and loss-streak audit (16 November 2026)

## Authority
**Research only.** This code does not open/close trades, veto signals, alter lot sizes or stop losses, promote models, or change user trading sessions.

## Purpose
Separate what was observable *before* a trade from later realized outcomes. Avoid false claims that the model could recognize losers using post-entry peak/R data.

## Method
- User-scoped Pepperstone cTrader USD DEMO settled trades, last 30 days (73 trades as of approximately 13:49 UTC 16 November).
- For each entry, use only broker trade records for the **same instrument and direction** closed **strictly before** that entry, within a trailing 14-day window. Overlapping open trades cannot leak future returns.
- Convert actual booked gross plus commissions and swaps to after-cost net; normalize by the original recorded risk at stop where evidence exists.
- A supportive-history label requires at least eight priced prior trades over three distinct closing days, historical win rate at least 55%, profit factor at least 1.25 and mean net outcome above 0.1R. These heuristic thresholds have NOT been optimized or prospectively validated.
- Separately show a **non-blocking caution** for three or more consecutive completed losses in the same pair and direction. A completed win clears the streak.

## Preliminary retrospective as-of results

| As-of historical label | Subsequent trades | Winners | Losers | Actual after-cost net USD |
| --- | ---: | ---: | ---: | ---: |
| Supportive historical evidence | 14 | 8 | 6 | +142.66 |
| Historical edge not established | 4 | 2 | 2 | -160.56 |
| Unknown / insufficient history | 55 | 22 | 33 | -1,286.78 |

Independent streak warning:

| Signal known before entry | Trades | Winners | Losers | Net USD |
| --- | ---: | ---: | ---: | ---: |
| Three-plus consecutive earlier pair-side losses | 6 | 2 | 4 | -153.10 |
| No such warning | 67 | 30 | 37 | -1,151.58 |

For 16 November USDJPY SELL, the number of prior consecutive settled same-direction losses before selected trades reached 3, 4 and 5. That evidence existed before those entries, but **the retrospective sample is too small to promote a gate**. Some caution-flagged trades later won, and the supportive-history group also had losers.

## Lot-size attribution
16 November broker-executed USDCAD 0.01-lot and USDJPY 0.01-lot trades had `trade_intents.requested_lot_size=0.01`, with `m1_scout_requested_volume_cap=0.01` and `m1_scout_reliability_tier=NONE`. Currency exposure checks returned `CURRENCY_CAPACITY_CLEAR`. Therefore the very small size originates upstream in the M1 strategy's volume-cap logic rather than an unexplained reduction by cTrader. Other 1.6–3.18 lot executions are constrained by account-risk allocation. Forcing minimum 3–4 lots regardless of balance would exceed risk on smaller funded accounts.

## Reproducibility
- Run: `cd apps/api && node --test scripts/audit-pepperstone-asof-entry-quality.test.cjs`.
- Read-only audit: `cd apps/api && node scripts/audit-pepperstone-asof-entry-quality.cjs`.
- Private VPS report: `/home/lightworld/webapps/irexpro-research/pair-side-asof-entry-quality/latest-report.json`.
- Model's actual trade execution path and risk configuration remain unchanged.

## Next engineering gates
1. Persist a decision-time, prospective evaluation in the existing non-executable research sidecar with bounded refresh rate and no heavy database polling.
2. Track future distinct days, sampling gaps, winning trades forgone, expected P&L after broker commissions and drawdown; use independent holdout validation.
3. Investigate initial strategy quality by instrument, direction, session window, regime, and predicted net expectancy. Avoid suppressing profitable windows merely because a historical streak was bad.
4. Study a demo-only, explicitly approved position risk reduction after sufficiently reliable negative evidence rather than a universal hard trade blocker.
5. Do not promote to a real-funded account based on today's results.

## Prospectively attached diagnostic (follow-up implementation)

The application source now contains `pepperstone-pair-side-asof-shadow.ts` (pure evaluation), a bounded owner-scoped prior-close reader in `m1-tactical-evidence.service.ts`, and a research-governance field `pepperstonePairSideAsOfShadow` on already-authorized M1 primary Plan B candidates. It is NOT an input to `canExecute`, `receiveSignal`, risk capital allocation, broker lot sizing, trade dispatch, or broker close.

The query is restricted to the exact user, broker connection, `pepperstone-ctrader` demo identity, USD currency, same instrument/direction, at most 40 settled trades in the preceding 14 days, with `closed_at < decisionTime`. An incomplete prior settlement cost or risk is marked UNKNOWN and may not be silently ignored. A candidate with a three-loss history receives a caution field but **not** a veto.

A separate production-database, historical as-of parity check on 16 November found:

| USDJPY SELL decision UTC | Existing narrower route brake prior losses | Broader pair-side prior losses |
| --- | ---: | ---: |
| 05:52 | 0 | 3 |
| 06:17 | 1 | 4 |
| 09:03 | 2 | 5 |

This gap is explained by the older brake's strategy-route-specific history. The prospective research metric is deliberately broader and non-authoritative. It does not establish that blocking these trades would improve future profits.

The implementation passes new focused unit and evidence-query tests, plus TypeScript type checking. Running the source does not deploy a changed executable service; running API service remains unchanged until a deliberate, tested restart. Because any additional database call can introduce decision-time latency, measure scanner performance in controlled staging before promoting even research-only integrations.

**Entry-critical latency protection:** The prospective research query is bounded by a 350 ms wall-clock timeout. If the lookup throws or exceeds its budget, the persisted label is `UNKNOWN/HISTORY_LOOKUP_FAILED`; the already-computed broker permission, order, lots and stop remain untouched. Late returned research data is ignored. This is a client wait budget, not cancellation of the underlying PostgreSQL request. Three scheduler integration cases cover successful observation, failed lookup and slow lookup.
