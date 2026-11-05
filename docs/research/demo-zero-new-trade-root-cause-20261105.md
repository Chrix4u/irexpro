# iRexPro current-session zero new trades — evidence and attribution fix (2026-11-05)

## Context

The staging VPS is on deployed `e6cb8e00`; four iRexPro PM2 services online, HTTP 200 and fresh M1 candles for AUDUSD/EURUSD/GBPUSD. The cTrader DEMO FULL_AUTO session is ACTIVE, began at **2026-11-05 13:05:33 UTC** and has its broker binding present. Source-of-truth `trading.trades` showed **zero newly opened trades since that session start**; one-hour decision queries recorded **zero** `BROKER_NATIVE` authorizations. A previously recorded `SESSION_INACTIVE` outcome was timestamped **before** this session began, not proof of a current broker connectivity or order-size failure.

At approximately 15:58 UTC, the recent two-hour candidate cohort showed numerous repeated model-gate denials: Plan B rejected due to extended/weak trends, insufficient direction/trade/exit quality or expected value; market-feature drift outside the frozen continuation/early-transition envelopes; mismatched M1 continuation/Plan-B reversal timing; and DEMO fallback probation. Restricting entry scope to only three pairs reduced opportunities; it did not break market data.

## Real seven-day broker economics

Read-only SQL against `trading.trades` joined to broker connections, `broker_id='ctrader'`, `account_type='DEMO'`, `status='CLOSED'`, account currency EUR, trailing seven days:

| Category | Count | Gross realized EUR | Recorded commissions EUR | Net EUR |
| --- | ---: | ---: | ---: | ---: |
| Profit protection | 53 | +270.63 | −81.30 | **+189.33** |
| AI close signal | 29 | −105.00 | −41.98 | **−146.98** |
| Stop loss hit | 22 | −193.32 | −37.42 | **−230.74** |
| Broker close | 8 | −8.68 | −12.02 | **−20.70** |
| **All** | **112** | **−36.37** | **−172.72** | **−209.09** |

Net = realized gross + signed commission + swap (swaps zero in sampled records). This is a *historical* EUR DEMO account sample, not guaranteed future expectancy, and not necessarily the official 24-hour dashboard period. All six pair cohorts were negative after commission. Most of the damage arose from stop-loss and adverse AI-close exits, rather than profit-protection exits. Do not bypass broker fee, OOD, recent-loss or protective-stop checks merely to increase turnover. The preferred 0.20 and allowed 4.00 lot policy remains in place; lot sizing cannot create trade eligibility when execution authority is `NONE`.

## Bug found in “Why no new trades?”

The `demo-primary-only-route-probation-v1` diagnostic previously set `blocked=true` whenever the chosen path was not `PRIMARY_PLAN_B`, even when the primary Plan B was itself `BLOCKED` and *no* M5 handoff, professional fallback or scout was independently eligible. Consequently historical non-executable decisions were wrongly reported as “fallback vetoes,” exaggerating probation as a cause of zero trades.

The new `NO_EXECUTABLE_PATH` reason attributes these to the **underlying failed model admission** and reports `blocked=false` for that *already* non-executable state. A genuinely eligible M5 handoff, professional fallback, extension scout, or high-conviction rescue is still vetoed by probation. `preliminaryCanExecute` remains false when no executable path exists, so this does **not** grant authority or submit an order. Full scheduler regressions test that protection.

The existing endpoint's top-reason SQL also pooled `ABSTAIN` scans with actual proposed entries, and omitted risk/reliability/fallback blockers. This change:
1. Ranks top three *overlapping* reasons only for `route <> 'ABSTAIN'`, while preserving overall evaluated and non-abstain decision counts.
2. Adds plain-language classifications for actual fallback probation, early-transition degraded pair-side reliability, loss streak, recent stop pattern, M1 reversal confirmation, major event-risk veto and fee gate.
3. Retrospectively drops stale probation codes from historical rows whose saved `chosenAuthorityPath` was `BLOCKED` or `UNKNOWN`, so the corrected card works immediately following deployment rather than waiting for the one-hour window to expire.
4. Updates card wording to “Frequent reasons among proposed entries.”

## Validation

- Read-only, user/active cTrader DEMO broker/session scoped parameterized SQL extracted from the changed source and executed on staging: **360 evaluated / 85 non-abstain / 0 broker-authorized / 0 executed / 0 session-inactive**, top true gate counts (overlapping): Plan B admission 78, primary ensemble admission 78, drift OOD 60. Historical probation false positives omitted.
- Focused backend scheduler + unit suites **120/120 passed**, web tests **50/50 passed**, API TypeScript and changed-file API/web ESLint passed.
- No broker order writes, model promotion, lot sizing changes, risk reset, STOP/kill or user account changes in this patch.

## Next model improvement

Prioritize reducing *after-commission* stop-loss and adverse AI-close losses; compare their entry/exit predictions with completed five/15-minute counterfactuals and hold-out period qualification. More DEMO trades are only justified after showing an improved net expectancy and drawdown, not simply higher gross wins or a larger confidence meter.
