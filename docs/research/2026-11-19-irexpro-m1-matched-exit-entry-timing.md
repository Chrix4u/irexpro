# iRexPro: same-exit M1 timing comparison (19 November 2026)

## Purpose

Prevent a profitable *after-the-fact* delayed-entry hypothetical from being
mistaken for evidence that the model's actual entry was worse. The existing
`m1-confirmed-delay-stop-parity-shadow-v1` research watches a fixed 60- or
240-minute quote horizon and deliberately permits later market outcomes. That
is a different strategy from the actual trade, so it must not be compared
directly to the closed trade's broker P&L.

New `m1-confirmed-delay-stop-parity-shadow-v2-same-exit` preserves both
prior hypothetical stop scenarios and adds `sameExitComparison`, a *paired*
research comparison at the originally observed broker close. It uses only
verified broker-native M1 full candles after hypothetical confirmation and
strictly **before** the actual close minute; any data gap, early hypothetical
stop, early hypothetical target, or same-bar barrier ambiguity prevents a
same-exit P&L comparison. The actual close's partial M1 candle is omitted.

The original close price, original filled entry, actual gross P&L, commission
and swap are used only to normalize *estimated*, same-volume, same-exit
net-risk results. The original close decision is hypothetical for the
counterfactual and actual costs, slippage and broker fills may differ.
Neither USD conversions nor FX spreads are guaranteed. Every stored result
declares `noTradeAuthority:true`, `modifiesExecution:false`, and
`modelTrainingStatus:RESEARCH_ONLY_NOT_TRAINED`. The previous v1 data are
preserved; v2 uses an independent artifact identifier and is progressively
backfilled into the existing observations ledger without schema changes.

## Owner USDCAD SELL case

Owner Pepperstone USD DEMO trade
`0c2be108-00b6-4877-8bd4-3455c74b81e0`:
- Original broker filled SELL 2.00 lots at 1.43089000,
  2026-11-19 16:16:38 UTC;
- Actual broker close 1.43070000 at 16:39:05 UTC,
  gross +$26.56, commission -$12.00, net +$14.56;
- Maximum recorded adverse P&L -$64.69; early M1 evidence was ADVERSE_FIRST;
- Existing two-completed-M1 confirmation study found indicative quote-entry
  1.43110000 at 16:21:00 UTC (+2.1 pips better SELL entry, quote only);
- Existing 60-minute delayed hypothetical marked a target touch at
  **16:46 UTC, seven minutes after the real close**. This outcome is
  deliberately NOT allowed to prove higher matched-close profit.

A matched-close price comparison would benefit from an indicative entry
2.1 pips higher, but only if the model had entered then, its stop/target
weren't reached before 16:39, and the same exit decision could be retained.
Even when recorded as `INDICATIVE_SAME_EXIT`, that is **not a fill, proof,
or permission to change entry timing**.

## Cohort and qualification

On November 19 (read-only owner USD DEMO account), the completed strategies
at the 17:xx UTC research check were:
- Confirmed Reversal 64 closes, 27 winners, **-$1,401.46** net after fees;
- Early Transition 16 closes, 14 winners, **+$245.70** net;
- Trend Continuation 11 closes, 8 winners, **+$305.88** net.

These are not causal estimates, and later account results can differ. Future
analysis must segment direction, instrument, route, decision-time expert
agreement, timestamp, net-after-commission, adverse-first quality,
hypothetical target/stop preemption, and matched trade-close. Prefer
prospective cohort / time-split evaluation to a single recovered winner.
Neither production nor LIVE direction/lot/stop policy is changed here.
