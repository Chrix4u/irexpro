# iRexPro — 4 November primary Plan B restoration decision
**13 November 2026 UTC/Ghana | Actual broker ledger + frozen 04-Nov authority replay**

## Restoration conclusion

**Do not roll back primary Plan B.** The original primary authorization
rule from Git `0ccae758` (04-Nov 08:26:04 UTC, before the first broker
fill that day) is already preserved in today's implementation for all
historically qualified inputs. The updated code permitted one ADDITIONAL
primary reversal timing-bridge decision on 11 November; it did NOT
remove a legacy-approved primary decision.

The core Plan B scorer, M1 candidate builder, M1 route selector, and
expert registry were byte-identical from original source to current
source at comparison time. Their presence does not prove the same
forex market conditions, order execution, fees, model service process
or provider fill quality.

## Authored and executed reproducible, READ-ONLY comparison

Script:
`apps/api/scripts/audit-nov04-primary-authority-replay.cjs`

It replays ONLY the original `PRIMARY_PLAN_B` admission and matching M1
route/experts contract against saved *as-of* model decisions. It uses
one exact owner-bound old cTrader DEMO EUR account and a different
current authenticated Pepperstone DEMO USD account. Its read-only
transaction has explicit Ghana/UTC time boundaries and outputs a
private report outside the repository:

`/home/lightworld/webapps/irexpro-research/nov04-legacy-primary-authority/latest.json`

| Date | Plan B admitted decision rows | Legacy primary qualifies | Current primary qualifies | Legacy-only lost | New-only gained | Current broker-authorized decision rows |
|---|---:|---:|---:|---:|---:|---:|
| 04 Nov | 891 | 28 | 28 | **0** | 0 | 10 |
| 10 Nov | 1,134 | 43 | 43 | **0** | 0 | 17 |
| 11 Nov | 935 | 40 | 41 | **0** | 1 | 19 |
| 12 Nov | 954 | 23 | 23 | **0** | 0 | 7 |
| 13 Nov partial (initial scan) | 13 | 0 | 0 | **0** | 0 | 0 |

Broker-authorized decision rows are NOT the same as distinct broker
trades or net profitable fills. These counts cover candidate decisions
that were Plan B paper admitted OR current primary approved; they
are not all scanner evaluations and may include correlated consecutive
one-minute decisions. The same historical 04-Nov decisions were
replayed with the 04-Nov rules, and the later saved decisions were
re-evaluated with those rules; no claim of counterfactual price
movement or intraminute order fills is made.

**Most visible downstream brake attribution:**

- 04 Nov: 18 current-primary signals vetoed before final broker
  authorization (18 carried early-transition pair-side degradation;
  6 also carried early loss-streak flags).
- 10 Nov: 26 primary signals vetoed downstream; portfolio net-loss
  brake present in 17; early loss streak in 6; active opposing
  positions in 4 (overlapping reasons).
- 11 Nov: 22 downstream; early loss streak 9, early-transition
  degradation 6, portfolio net-loss 5, route loss-streak 3.
- 12 Nov: 16 downstream; portfolio net-loss 8, early loss-streak 6,
  route loss-streak 2.

These counts identify decision factors. They do NOT demonstrate that
removing any safety check would have produced profitable fills.
The 04-Nov early-transition degradation gate ALREADY existed and was
blocking decisions on the historically profitable day. Many other
new brakes were added in response to negative after-cost broker
performance, so restoring unlimited permissions is not justified.

## Verify exact frozen expert bundle

The active AI engine's Plan B V4 challenger manifest was pinned
to a SHA-256 digest, and the file exists. Manifest mtime
**03 October 2026**; the manifest hash matches its configured pin.
All **26 referenced model/feature components** are present,
and SHA-256 verification matches for all 26.
The newest component file mtime is also 03 October 2026.

That strongly establishes the trained-expert bundle available now
predates 04 November and has not been silently overwritten on disk.
It does NOT alone prove its exact loaded in-memory process version
on every historical trade or that trained-expert confirmation was
used for all primary entries: primary Plan B typically regards
trained-expert output as observational.

## Actual broker profitability context

04 Nov cTrader EUR DEMO: 14 closed, 9 winners, **+€14.53** net.
Of those, 7 `PRIMARY_PLAN_B` continuation fills yielded
**+€23.29**, with other execution paths reducing the total.

Across 04–09 Nov: old account 35 closed, **−€22.42** net,
with primary Plan B alone **−€0.95**.
Across 10–12 Nov: different Pepperstone USD account 44 closed,
**−$1,259.71** net, with much greater traded lot volume.
These totals cannot be treated as controlled same-currency,
same-size, same-volatility model comparisons.
Old mean 0.175 lots vs newer mean 3.064 lots per fill.

## Selective recovery made durable

- Added a standalone account-isolated, read-only replay tool and
  seven unit/owner-scope tests.
- Added a regression test to
  `multimodel-demo-authority.spec.ts` that compares the current
  primary route against the frozen 04-Nov contract for **144**
  combinations of strategy, M1 timing, admission, governance and
  broker-native expert state. All 25 authority suite tests pass.
- Preserved the current winning reference core code and
  exact four-pair DEMO eligibility (EURUSD, AUDUSD, USDCAD, USDJPY).
  No order was placed; no risk brake was disabled and no lot change,
  SL/TP change, API build or PM2 restart was required for a
  tests-and-research-only change.
- A future model update that accidentally rejects a historically
  eligible **primary** route will break the compatibility tests.
- Before relaxing the new *downstream* loss brakes, conduct a
  prospective, decision-time quote first-touch comparison against
  blocked same pair/side/strategy opportunities **net of actual
  broker commission**, sufficiently separated in time to avoid
  double-counting nearly identical one-minute signals. Require
  multi-day positive evidence. Until then, leave loss brakes active.

## Limits

This replay is an authority comparison, **not a profitability
backtest** and cannot claim the old trades could fill today.
The entire 04-Nov trading pipeline included smaller equity
allocation, different broker, different market regime and
different execution and SL/TP lifecycle. Restoring only the original
primary model is not a missing step; it is already present.

The benchmark's output is research-only, never consumed by
`canExecute`, order dispatch, execution caps or risk gates.
