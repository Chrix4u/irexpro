# High-Conviction Local-Edge Consensus Scout

## Problem
The global M5 ensemble can remain pessimistic while the same instrument/direction/session/state pocket has a large, causal resolved shadow-payoff history. Current local-edge authority already lets a supported pocket override global drift/net-R/calibration at 0.10 PAPER size, but still requires 4/6 consensus. Live scans commonly land at 3/6, so proven local pockets can remain idle.

## Decision
Allow a 3/6 PAPER scout only when the local shadow pocket is exceptionally strong: at least 30 resolved samples, PF >= 1.5, average net R >= 0.20, at least 6 wins in the latest 8, and recent net R >= +0.50. Ordinary supported pockets keep the existing 4/6 floor; 2/6 never qualifies.

## Safety Boundary
This is PAPER-only at the existing 0.10 RESEARCH cap. It does not relax route/regime support, event risk, execution-cost usability, portfolio quality, entry-market alignment, post-loss governance, sizing/risk, broker controls, or rollover-risk exclusion. The empirical pocket R remains the ranking edge only when explicit local-edge scout authority is active.
