# Owner DEMO: independent governance disagreement and model-level pause investigation

Investigation performed 18 November 2026, after the owner asked to learn from all Early Transition and Confirmed Reversal losses on 17–18 November. This is a research-only investigation of actual Pepperstone USD DEMO broker fills and contemporaneous scanner decisions.

## What was verified

A total of **98 closed trades** from the inspected November 17–18 cohort: 54 winners, 44 losses, −$1,336.99 after commission and swap. Data from the private owner's trading account must **not** be committed to GitHub.

For some entry signals, the separate qualified Plan-B route forecast positive net R while generic governance predicted negative R or rejected paper eligibility. Those are distinct models: generic governance is **not** the definitive executable authority for the alternate DEMO bridge.

The separate read-only governance audit found:

| As-of-entry rule | Flagged trades | Wins | Losses | Flagged actual net |
|---|---:|---:|---:|---:|
| Plan-B expected R positive, generic expected R negative | 9 | 5 | 4 | −$146.71 |
| Generic paper-ineligible | 93 | 50 | 43 | −$1,421.62 |
| Generic expected R failed | 45 | 25 | 20 | −$646.00 |
| Independent expert ABSTAIN | 98 | 54 | 44 | −$1,336.99 |

**None of these flags cleanly separate winners from losers.** They may support prospective combinations, but should not be deployed as single-signal trading vetoes or automatic opposite-side decisions.

## Why trade entries can appear silent

The existing read-only entry-blockade watcher reported 1,412 scanner decisions over three hours, but no new trade intent. Four candidate opportunities were preliminary alternate-route eligible, and all four received the strategy-level `M1_MULTIMODEL_LOSS_STREAK_BRAKE`, which is **different** from the account-level two-hour portfolio brake.

A read-only pair-side inspection of contemporaneous strategy brake decisions at about 21:59 UTC found:

- Confirmed Reversal **USDJPY SELL**: three blocked candidates, `PERSISTENT_NEGATIVE_PAYOFF`, recent 2 wins/0 losses but last-eight-payoff profit factor around 0.49. The historical brake can remain active despite a positive recent pair of trades.
- Confirmed Reversal **EURUSD BUY**: one blocked candidate, `PERSISTENT_NEGATIVE_PAYOFF`, four relevant payoff trades with profit factor around 0.34. Ordinary 12h cooldown was already zero, but persistent loss evidence remained active.

The strategy brake uses a **12-hour cooldown** for recent streak/negative-payoff evidence and a **96-hour recent-evidence lookback** for persistent negative payoff, where applicable. Do not treat expiry of the former as proof that the persistent-performance rule has cleared. Both gates are independent of the owner portfolio 120-minute three-loss pause.

## Repeatable research audits

```bash
cd /home/lightworld/webapps/irexpro-staging/apps/api
node --test scripts/audit-owner-demo-governance-disagreement.test.cjs scripts/audit-owner-demo-route-brake-diagnostics.test.cjs
node scripts/audit-owner-demo-governance-disagreement.cjs
node scripts/audit-owner-demo-route-brake-diagnostics.cjs
```

Research-only outputs (private; not published):

- `/home/lightworld/webapps/irexpro-research/governance-disagreement/latest.json`
- `/home/lightworld/webapps/irexpro-research/governance-disagreement/latest.md`
- `/home/lightworld/webapps/irexpro-research/route-brake-diagnostics/latest.json`

The scripts open **PostgreSQL REPEATABLE READ READ ONLY** transactions, use the owner-scoped Pepperstone USD DEMO connection, and have no broker adapter imports or execution authority.

## Decision

Do not bypass the persistent loss brake or claim a profitable BUY-to-SELL flip based on two days of inspected outcomes. Continue the separately frozen, prospective loss-pattern validation through independent future sessions, comparing winners *and* losers after full broker costs. For usability, a separate informational (not approval-to-bypass) dashboard notice would help distinguish the current strategy-level brake from the existing owner portfolio-pause modal, but no such UI change is made in these scripts.
