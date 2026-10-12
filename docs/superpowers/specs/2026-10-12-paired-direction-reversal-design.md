# Paired Direction Reversal Design

## Goal
Turn the existing independent BUY/SELL counterfactuals into a true paired directional decision without weakening normal PAPER, DEMO, or LIVE governance. A failed BUY thesis may become positive evidence for SELL (and vice versa), but only when the opposite side has directional dominance, reversal evidence, tradable economics, trusted spread evidence, and clear event risk.

## Observed Problem
The current scanner already builds BUY and SELL candidates for each closed M5 snapshot, but scores their win probabilities independently. Both sides can therefore be negative at the same time, and the current `CONFIRMED_REVERSAL` route reuses the continuation-era meta expected-R score and requires it to be positive before reversal is recognized. This does not implement a true paired UP-vs-DOWN decision.

## Architecture
1. Keep the existing independent model scores unchanged as absolute tradability evidence.
2. Derive a complementary pairwise direction probability from the two independent logits using a two-class softmax/logit-difference transform. The resulting probabilities must sum to 1.
3. Build explicit reversal evidence from the market snapshot: opposite-side directional momentum, weak/extended prior structure, and a meaningful pairwise probability edge.
4. Compute a research-only paired expected-R estimate from the pairwise probability, existing target/stop R multiple, and the same authoritative execution-cost evidence used by PAPER.
5. Introduce a separate `PAIRED_REVERSAL_RESEARCH` PAPER route capped at 0.01 lots. It may observe STRESSED drift but never OUT_OF_DISTRIBUTION, never bypasses stale/missing spread evidence, event-risk blocks, post-loss guard, or broker/risk/margin checks.
6. Trades from this route are explicitly `qualificationEvidence=false` and cannot promote a model to DEMO/LIVE. Normal execution and promotion policies remain unchanged.

## Decision Semantics
- `P(UP) + P(DOWN) = 1` by construction.
- A preferred side is actionable only when the pairwise directional edge exceeds a minimum threshold and reversal evidence supports the side.
- If both absolute models are weak, pairwise direction can still be observed, but execution requires a positive research expected R after real broker costs.
- High spread, unclear event risk, invalid market evidence, or OUT_OF_DISTRIBUTION state means ABSTAIN, not automatic reversal.

## Success Criteria
- Tests prove complementary probabilities and symmetry when BUY/SELL inputs are swapped.
- A failed primary side can create an opposite-side reversal candidate when the opposite pairwise probability and momentum evidence are strong.
- Both sides can still yield ABSTAIN when expected move does not clear costs.
- Existing normal PAPER/DEMO/LIVE governance behavior is unchanged.
- PAPER research lot size remains 0.01 and route trades never count as qualification evidence.
