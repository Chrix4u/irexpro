# v11 Forward-Deterioration Quarantine Design

## Intent
Stop `PAPER_RESEARCH_THROUGHPUT` v11 from spending PAPER capital after its strong Oct 19 cohort failed to persist out of sample.

## Evidence
Oct 19 v11: 8 trades, 7 wins / 1 loss, +$22.12. From Oct 20 onward: 12 trades, 4 wins / 8 losses, -$41.13, profit factor 0.177. The deterioration spans multiple instruments and includes a later Oct 22 loss, so this is not one isolated pair.

## Decision
Keep v11 scoring, calibration, route eligibility, episode evidence, pair-side evidence and shadow persistence active. Remove only final PAPER execution authority. `NORMAL_PAPER` remains the sole executable route. Existing NORMAL_PAPER strategy-family reliability, post-loss, drift, cost, event, sizing, portfolio and profit-protection controls remain authoritative.

## Non-goals
Do not delete v11, weaken any threshold, change DEMO/LIVE authority, or retroactively alter closed trades. v11 can earn execution back later only through a separately evidenced promotion decision.
