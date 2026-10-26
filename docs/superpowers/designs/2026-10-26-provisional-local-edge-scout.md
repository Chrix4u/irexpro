# Provisional Local-Edge PAPER Scout

## Problem
Global M5 relaxation is unsafe: after 11:45 UTC on 2026-10-26, 79 blocked positive-calibrated candidates resolved 19W/60L for -47.708R. However isolated pair/direction pockets were profitable, so blanket abstention can miss local edge.

## Design
Add a PAPER-only provisional exact-local-pocket state that can earn a 0.10-lot scout before the existing 20/30-sample mature thresholds. It is discovery authority only, never full-size authority.

A provisional pocket requires all of: 3-19 exact local resolved outcomes, zero losses, every resolved outcome positive, average net R >= 0.50, recent net R >= 1.50, and latest resolution within 24 hours of the current evaluation. The current candidate must remain TREND_CONTINUATION, event risk CLEAR, cost usable, portfolio quality valid, consensus >=4/6, confidence >=0.60, current net expected R >=0.08, direction/trade/exit quality >=0.30, aligned momentum >=0.10 ATR, and drift must not be OUT_OF_DISTRIBUTION.

The provisional pocket may override a weak broad realised-continuation route only at 0.10 lots when structural route and pair-side reliability are not themselves weak. All post-loss, entry-alignment, portfolio, margin, SL/TP, sizing and broker controls remain downstream authority.
