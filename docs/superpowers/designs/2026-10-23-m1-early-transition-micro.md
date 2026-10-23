# M1 Early-Transition Micro PAPER Design

## Goal
Use iRexPro's existing M1 tactical engine for frequent short-horizon PAPER participation without enabling the losing M1 trend route or weakening central risk controls.

## Evidence
Current causal 15-minute M1 shadow outcomes show M1_EARLY_TRANSITION is mixed route-wide but contains positive exact pair/sides. Promotion therefore happens by exact route+instrument+direction rather than route-wide.

A pair/side qualifies for micro execution only when its causal shadow episode leaders over the prior 7 days have: at least 3 observable outcomes, profit factor >= 1.50, average net R >= +0.10R, positive-episode fraction >= 40%, and no latest-three non-positive streak. The route must be M1_EARLY_TRANSITION.

## Authority
Add a PAPER_EARLY_TRANSITION_MICRO rollout phase. It can submit only M1_EARLY_TRANSITION at a 0.01-lot cap. Generic governance may be rescued only when the sole remaining blocker is DRIFT_OUT_OF_DISTRIBUTION; event risk, execution cost, HTF conflict, route/payoff, actual-trade reliability, session, broker and central risk controls remain authoritative.

M1_TREND_CONTINUATION and M1_CONFIRMED_REVERSAL remain shadow-only.
