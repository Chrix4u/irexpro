# cTrader DEMO drift research: preserve one leader per fixed 16-minute UTC bucket

6 November 2026 — read-only evidence sampling only.

After deploying the multi-blocked OOD/STRESSED counterfactual collector
in PR #650, the cTrader DEMO account began writing research outcomes.
A read-only audit confirmed some same-pair fixed 16-minute UTC buckets
had more than one counterfactual, despite the initial first-episode
selection.

## Root cause

The previous SQL filtered out decisions older than a sliding
48-minute lookback BEFORE applying ROW_NUMBER within a fixed
16-minute UTC bucket. As the clock advanced, the original leader
aged out and a later M1 decision in its same bucket was promoted
to an artificial second leader. Filtering out settled rows only
in the outer query did not prevent this.

## Narrow repair

The inner selection now includes the complete oldest fixed bucket
containing the sliding 48-minute boundary, anchored to epoch UTC
16-minute bins (TO_TIMESTAMP with FLOOR(epoch/960)*960).
After the whole bucket is ranked, the outer query applies the
original maturity/expiry test (evaluated_at > asOf minus 48 min)
and filters already-settled leaders. An aged-out leader can never
be replaced by another candidate inside its bin. The 16-minute
maturity delay, max eight per instrument, policy scope, broker
connection and nonexecution filters remain unchanged.

## Live read-only verification

Simulated 26 consecutive scan minutes from 09:05–09:30 UTC against
the actual cTrader DEMO scoped decisions:
- AUDUSD two unique bucket leaders and zero duplicates.
- EURUSD three unique bucket leaders and zero duplicates.
- GBPUSD three unique bucket leaders and zero duplicates.

36 targeted API evidence-service tests passed. The SQL regression
asserts that the fixed bucket lower bound precedes ranking, and
the rolling 48-minute expiry cutoff is applied afterwards.

Historical duplicates are NOT deleted or relabeled. Research
training must deduplicate older counterfactuals by instrument
and immutable UTC 16-minute bin, and label future-path observations
as nonexecuting, uncertain historical evidence.

Zero changes to order approval, quote freshness, stop-loss,
take-profit, lot sizes, risk vetoes, session Start/Stop or broker
commission.
