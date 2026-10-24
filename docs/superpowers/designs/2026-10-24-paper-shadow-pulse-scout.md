# PAPER Shadow Pulse Scout Design

## Goal
Turn a strongly supported causal BUY/SELL shadow pulse into a 0.10-lot PAPER scout when a trend candidate has positive post-cost edge but is being held back by soft confidence/quality thresholds.

## Authority boundary
The pulse is supporting evidence, not a new execution route. A rescued candidate remains `NORMAL_PAPER` with `RESEARCH` sizing and `paper_opportunity_scout_eligible=true`.

A pulse rescue requires all of the following:
- strategy route `TREND_CONTINUATION` in a trend regime;
- drift is not `OUT_OF_DISTRIBUTION`;
- event risk `CLEAR` and execution-cost evidence usable;
- portfolio quality >= 0.35;
- consensus >= 4 and consensusRequired > 0;
- effective post-cost net expected R >= 0.04;
- direction/trade/exit quality each >= 0.20;
- aligned momentum >= 0.10 ATR;
- shadow pulse available and `SUPPORTED`;
- candidate/opposite shadow samples >= 4/4;
- candidate weighted R >= 0.25;
- pulse advantage R >= 0.75;
- pulse quality >= 0.68;
- candidate confidence >= 0.52.

The pulse may rescue only soft confidence/quality admission. Existing mature pair-side reliability, post-loss reconfirmation, portfolio/concentration, entry alignment, SL/TP geometry, allocation, margin, drawdown, max-risk and broker checks remain downstream vetoes.

## Sizing
Pulse scouts use the existing 0.10 lot `RESEARCH` scout tier. Normal PAPER remains >=0.20 lots.

## Auditability
Persist the scout reason `SHADOW_PULSE_SCOUT` plus pulse status, sample counts, weighted R, advantage R and pulse quality in signal metadata.
