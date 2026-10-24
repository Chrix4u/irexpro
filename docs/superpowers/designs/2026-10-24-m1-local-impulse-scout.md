# M1 Local Impulse Scout Design

## Goal
Allow a fast M1 EARLY_TRANSITION scout to participate when local 1m/3m/5m impulse is strong but H1/H4 moderately disagree, instead of treating every higher-timeframe disagreement as an absolute veto.

## Safety boundary
- PAPER only through the existing V6 M1 early-transition 0.10-lot scout.
- No new DEMO/LIVE authority.
- Keep the existing route net-R floor, six-sample positive pair/side reliability, event-risk, spread/cost, broker, margin and central risk checks.
- Override only the M1 higher-timeframe conflict blocker for a specifically tagged local-impulse scout.
- Severe HTF conflict or weak/one-bar momentum must still abstain.

## Local-impulse qualification
A candidate may be classified as `M1_EARLY_TRANSITION` with reason `LOCAL_IMPULSE_AGAINST_HTF` only when:
- score edge >= 0.35;
- direction quality >= 0.68;
- momentum1 >= 0.20 ATR;
- momentum3 >= 0.50 ATR;
- momentum5 >= 0.50 ATR;
- EMA slope > 0 and EMA separation > 0;
- HTF agreement is conflicting but bounded: >= -0.50 and < -0.12;
- no failed breakout in the candidate direction.
