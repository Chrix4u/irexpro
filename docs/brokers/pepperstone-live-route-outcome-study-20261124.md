# LIVE Plan-B/M1 route disagreement: no automatic promotion

Pepperstone LIVE account ending 6270 is connected, certified, and the
owner's FULL_AUTO session is running. Its absence of new LIVE trades must
be diagnosed from *persisted final execution authority* and broker order
history, not from the readiness meter, chart candles, or Plan-B admission
alone.

## Historical research (as-of 24 November 2026)

The single-session period is too short for statistical qualification.
The read-only study evaluates older Plan-B-admitted LIVE decisions, groups
repeated minute decisions within five minutes by pair/side/model/M1 route,
and compares exact-route alignment versus M1 abstentions and model/M1
route disagreements. It uses the existing frozen 15-bar M1 causal-outcome
function. This estimates hypothetical 15-minute stop/target outcomes from
the *next* completed M1 minute, with a mandatory contiguous set of 15
same-minute-positive-quote broker-native M1 bars. Same-bar stop/target
touches count as ambiguous, never wins. Missing costs, bad geometry and
incomplete windows are unobservable.

At **07:42 UTC** with the mature window ending about **07:24 UTC**,
the research yielded:
- 320 recorded decisions in the mature window and 29 deduplicated,
  Plan-B-admitted research episodes;
- M1 abstained: 22 observed; 10 positive, 12 negative; aggregate
  estimated net -3.2625R, mean -0.1483R;
- Plan-B/M1 route disagreement: 7 observed; 2 positive, 5 negative;
  aggregate estimated net -2.52R, mean -0.36R;
- **No matching-route comparator** from this period. These groups are
  selected, overlapping counterfactuals, not actual trades.

The route-disagreement cohort includes Confirmed Reversal hypotheses
when M1 detected only Early Transition and one Trend Continuation
hypothesis when M1 detected Early Transition. The observed decision
vetoes were independent confirmation/timing blockers. Reinterpreting
Early Transition as Confirmed Reversal would have admitted entries
that this small observed proxy cohort *did not support*.

## Limitations and controls

**Do not deploy a LIVE entry-policy change or open a trade based on this
report.** Midpoint OHLC cannot reconstruct executable intrabar
bid/ask fill ordering or slippage, and the decision's estimated execution
cost does not establish full observed Pepperstone commission, financing,
or spread in a hypothetical fill. Repeated and overlapping opposite-side
setups are not independent portfolio trades; historical selectivity
introduces lookback bias. The event count is far below any independent
qualification requirement.

This study is an exploratory, retrospective screen only. Future
development may preregister an isolated SHADOW comparator of the
status-quo route classifier and a narrowly specified candidate
timing-handoff variant. Both must be scored with *new, prospectively
timestamped* samples, real observed spreads, after-fee net R and
independent risk gates before considering a separate authorization.
No shadow verdict can dispatch a LIVE order.

## Run

From a checkout containing this script and a built API, with the
original app's environment available:

    cd /home/lightworld/webapps/irexpro-staging/apps/api
    node scripts/validation/pepperstone-live-route-outcomes-ro.cjs

The script uses BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY,
returns no user IDs, connection IDs, secrets or broker tokens in output,
and rolls back. It never queries Spotware for orders, changes session
state, updates strategy tables, or sends market orders. The test command:

    node --test scripts/validation/pepperstone-live-route-outcomes-ro.test.cjs

Provenance: first durable snapshot on the authorized VPS stored as
/root/irexpro-live-cert-evidence/pepperstone-live-planb-m1-outcome-study-20261124.json
with SHA256:
3c6b464a8d784a32602e60c731b55408e9a5f62f3726a8de27eac27edaa8ee81
The initial snapshot predates the additional independent-blocker
classification, but uses the same 15-bar causal outcome method.
