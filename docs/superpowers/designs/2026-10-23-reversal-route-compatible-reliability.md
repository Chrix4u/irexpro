# Confirmed-Reversal Compatible Reliability Design

## Intent
Stop mature losing `CONFIRMED_REVERSAL` behavior from continuing to open NORMAL_PAPER trades when the exact pair-side sleeve is still too immature to prove an exception.

## Evidence
The reversal-compatible decision lineage is limited to `planb-v4-bi2-et2-nm2-hp3-dmw2-ts1-trr1-psrr1` and `planb-v4-bi2-et2-nm2-hp3-dmw2-ts1-trr1-psrr1-cal1`. On staging, the execution-eligible resolved cohort contains 8 independent confirmed-reversal episodes: 2 wins, 6 losses, about -4.37R total. Older reliability policy versions are excluded because their reversal/transition momentum semantics differ.

## Decision
Keep TREND_CONTINUATION reliability behavior unchanged. Add a separate confirmed-reversal route reliability artifact with an 8-episode maturity floor and the existing PF >= 1.0 / max-DD <= 12% health boundaries. If the reversal route is mature and weak, an immature pair-side is demoted to research-only. A mature healthy pair-side may override the weak aggregate route; a mature weak pair-side remains demoted.

## Non-goals
No confidence, expected-R, drift, event-risk, sizing, broker, DEMO or LIVE gate is relaxed. No existing open trade is changed retroactively. Research routes remain quarantined as already deployed.
