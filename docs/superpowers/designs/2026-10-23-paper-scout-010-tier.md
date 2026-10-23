# PAPER 0.10 Scout Tier Design

## Goal
Increase qualified PAPER participation without reducing normal/high-conviction sizing or bypassing hard risk controls.

## Sizing ladder
- Scout / idle ACTIVE / idle RECOVERY: 0.10 lot maximum/floor, RESEARCH risk tier.
- NORMAL BASE: 0.20 lots.
- STRONG: 0.50 lots.
- VERY_STRONG: 1.00 lot.
- EXCEPTIONAL: 2.00 lots.

## Calibrated OOD scout
Re-enable calibrated OOD participation at 0.10 lots only when the existing causal local evidence remains strong: authoritative EXACT or PAIR_DIRECTION_ROUTE calibration, >=10 samples, calibrated win probability >=0.60, PF >=1.50, calibrated net R >=0.05, no degradation/block recommendation, >=4 model votes, direction quality >=0.08, trade/exit quality >=0.30, confirming momentum >=0.05 ATR, no hard MTF disagreement, event risk CLEAR, usable costs and downstream safety gates.

## Safety
Normal PAPER keeps a 0.20 minimum. Confirmed reversal remains excluded from scout authority. Mature weak pair-side reliability, post-loss reconfirmation, portfolio concentration, stop/target geometry, entry alignment, allocation, margin, drawdown, hard stop and broker/risk authority remain vetoes. No DEMO/LIVE change.
