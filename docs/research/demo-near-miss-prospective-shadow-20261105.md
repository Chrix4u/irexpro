# Current-session zero-trade analysis: independent near-miss shadow audit
Date: 2026-11-05 | Broker: cTrader DEMO | Currency focus: AUDUSD, EURUSD, GBPUSD

## Why this was built

iRexPro continuously scans but opened zero new cTrader DEMO trades after the active FULL_AUTO session began **13:05:33 UTC on Nov 5**. Recent M1 snapshots and broker binding were fresh, and the previously misleading fallback-probation attribution was fixed and deployed in PR #632 (`b613afc4`).

Causally inspecting the *trades that almost qualified* is better than unconditionally widening gates or demanding a fixed number of trades. We require subsequent independently timestamped quote observations, subtract costs provisionally, and suppress clustered non-independent signals. The primary goal is to learn which safety restrictions are justified; this is not a new order-execution algorithm.

### Immediate current-session signal evidence

From staging database, filtered to the three DEMO pairs after 13:05:33 UTC:
- 1,392 evaluated decisions (including ABSTAIN), 282 non-ABSTAIN decisions.
- 27 Plan-B paper-admitted decisions, but just **five** chose a genuinely permitted `PRIMARY_PLAN_B` path.
- Each of those five was refused because of **`M1_DEMO_EARLY_TRANSITION_PAIR_SIDE_DEGRADED`**. No new broker-native entry authorization and zero newly opened trades.
- The five same-direction or opposite-direction GBPUSD signals at 13:40, 14:19, 14:21, 14:30 and 15:10 UTC had 15-minute provider bid/ask quote-proxy outcomes after an additional *estimated 1 pip* of friction: **−5.6, +4.3, −0.3, −4.9, −19.4 pips**, respectively. **Four of five negative**, sum **−25.9 pips**. Signals were partly overlapping and cannot be added as independently executable trades. This is not a real broker fill simulation (protective stop/take profit not modeled).

The seven-day DEMO broker history, independently checked in PR #632, was 112 closed EUR-account trades: gross **−€36.37**, signed commissions **−€172.72**, after-cost **−€209.09**. Profit-protection exits contributed +€189.33 after costs, but STOP_LOSS_HIT −€230.74 and AI_CLOSE_SIGNAL −€146.98. These historical results make forced additional turnover unjustifiable without a demonstrably better edge.

## Added private research

**Read-only SQL:** `services/ai-engine/app/domain/training/demo_entry_near_miss_readonly.sql`

- Only the exact configured scanner user with an existing cTrader DEMO broker connection; only AUDUSD/EURUSD/GBPUSD and non-ABSTAIN M1 routes.
- Only persisted **Plan-B paper-admitted** decisions with **no broker entry authorization**; excludes executed orders, unrelated clients, and research-only pairs.
- A 35-day bound; one original observation per signal bar, route, pair and direction.
- Joins separate cTrader broker-native M1 bid/ask quotes observed **before the candidate** and then **5–8** and **15–18 minutes after decision**. Python validates timestamps, positive prices, correct spread, market allowlist and fully separate feature/label timing again.
- No user/session/account/broker/order IDs or credentials exported, no SQL writes or broker APIs.

**Pure Python:** `services/ai-engine/app/domain/training/demo_entry_near_miss_shadow.py`

- Hypothetical BUY receives future bid, pays entry ask; SELL receives entry bid and pays future ask, then deducts an **extra estimated 1 pip** per hypothetical position (not a verified lot-size commission, financing, slippage fill or broker P&L).
- Counts independent opportunities by keeping only the earliest candidate **per pair per 15 minutes, across both sides**; computes the `PRIMARY_PLAN_B` subset with separate de-overlap so earlier ineligible proposals do not hide the primary near-misses.
- Reports aggregate after-spread+placeholder outcomes for 5m and 15m by Plan B route, M1 route, instrument and drift state; counts overlapping veto reasons from a curated, static blocker code allowlist.
- Retrospectively suppresses historical `M1_DEMO_PRIMARY_ONLY_ROUTE_PROBATION` labels when the saved chosen path was `BLOCKED` or `UNKNOWN`, matching the corrected production explanation.
- **Never trains a model, grants entry authority, places orders, or promotes itself**. Even if at least 12 separate observed UTC days and 100 independent opportunities accumulate, the state is only `RESEARCH_COHORT_MATURE_NOT_AUTOPROMOTABLE`; independent after-commission broker validation remains mandatory.

**Workflow:** integrated into the existing weekday 16:20 UTC `VPS OOD Shadow Research` workflow, using the same private staging SSH and DB connection. No paid provider. Keeps one bounded, 0600-permission CSV+JSON pair in `/home/lightworld/webapps/irexpro-research/ood-shadow/`, alongside the original OOD report. Old files are atomically replaced to avoid filling the VPS.

### First verified sample, Nov 3–5

- SQL extract: **199** causally matched raw near-miss examples, **196** valid after additional Python checks, **99** distinct per-pair 15m opportunities, spanning **3 days**.
- All 99: 5m proxy average **−0.677 pips** and 33/99 positive; 15m proxy average **−0.806 pips** and 44/99 positive.
- Independent *fully-primary-admitted but vetoed* subset: **9** observations (separately de-overlapped; **do not add its count to the 99**), 15m mean **−3.489 pips**, only 1/9 positive. A closely related current-session sample contained the five events described earlier.
- Route slices: Plan B `TREND_CONTINUATION` 21 non-overlapping examples, 15m mean **+0.576 pips** (11/21 positive); `CONFIRMED_REVERSAL` 71 examples, 15m mean **−0.935 pips**; `EARLY_TRANSITION` seven examples, mean **−3.643 pips**.
- These route cohorts are **tiny, only three market days, and not execution-eligible**. The nominal +0.576 pip continuation price proxy is far too small to justify enabling entries without verifying true round-trip commission, fill quality, stop/TP outcomes, independent months of results and risk exposure.

The same-date initial OOD research had 2,131 independently timestamped OOD examples and a negative mean proxy, reinforcing caution when considering envelope expansion.

## Tests and change limits

The new tests cover:
- Correct BUY versus SELL bid/ask pricing and friction accounting.
- Rejection of future data visible before decision, early future labels, invalid bid-ask pairs, wrong pair/direction.
- Removal of repeated same-bar decisions and 15m overlapping opportunities across both sides.
- Separate primary-path de-overlap, historical false probation annotations, empty data, and strict failure to auto-promote even on synthetic mature history.
- SQL user/broker/DEMO scope, causal timestamps, report fields and integration with the scheduled existing research runner.

The source contains **no order dispatch, no model change, no lot-size or allocation change, no stops/kill-switch reset and no relaxation of existing trade protections**.

## Next substantive trading decision

Accumulate sufficient separate market days; first examine **in-distribution, high-quality trend continuation** with audited broker net economics and negative exit-cohort replay. Only if a new policy beats current rules after costs, with bounded drawdown and holdout validation, should execution eligibility be proposed separately. No claim of improved live or DEMO profitability is made by this research.
