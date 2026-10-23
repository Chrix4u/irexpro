# Calibrated OOD Micro Scout Design

## Problem
The idle-aware PAPER scout was evaluated before adaptive prediction calibration. In the observed GBPUSD SELL case, raw governance net edge was about -0.636R while exact local calibration (12 samples, 8W/4L, PF ~2.33) produced about +0.071R. Because the scout saw only raw governance, it rejected the opportunity before calibrated evidence existed. Recent runtime evidence also showed all positive-edge opportunities in the preceding three hours were classified OOD, so a blanket OOD veto caused starvation.

## Design
Use a two-pass adaptive decision. First compute adaptive calibration with the diagnostic execution route. Then evaluate the PAPER scout using calibrated effective net R plus calibration provenance. If the scout earns authority, re-run adaptive evaluation as NORMAL_PAPER before ranking/risk. Keep research routes quarantined.

Add a narrowly scoped calibrated OOD micro rescue. It is PAPER-only, TREND_CONTINUATION only, requires >=30 minutes idle, >=4/6 consensus, positive direction-aligned momentum, no `mtfStrength:HARD_LOW`, local authoritative EXACT/PAIR_DIRECTION_ROUTE calibration with >=10 samples, calibrated win probability >=0.60, PF >=1.50, calibrated net R >=0.05, no degradation/block recommendation, direction quality >=0.15, trade/exit quality >=0.30, clear event risk, usable execution costs and portfolio quality >=0.35. Lot cap is 0.01.

## Safety
Hard SL/TP, post-loss guard, mature pair-side reliability, portfolio concentration, allocation/margin/risk, entry-market alignment, event risk, execution-cost evidence and broker authority remain unchanged. Confirmed reversal stays excluded. OOD without strong local calibration remains blocked.

## Cohort
Changed scout semantics use model identity `paper-opportunity-scout-v3` and persist raw/effective net R, calibration source/sample/PF/win probability and drift diagnostics for forward attribution.
