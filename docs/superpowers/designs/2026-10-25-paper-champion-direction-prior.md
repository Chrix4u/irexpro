# PAPER Champion Direction Prior Design

## Goal
Increase PAPER participation before the 30-minute idle tier by letting empirically strong pair+direction sleeves use the existing reduced-risk scout thresholds immediately, without lowering hard safety gates globally.

## Evidence
The last 100 closed `paper-only-v1` trades produce four qualifying pair+direction sleeves when requiring >=8 trades, positive net P/L and PF >=1.15: AUDUSD SELL, GBPUSD SELL, USDCHF SELL and USDJPY BUY. The rule is computed dynamically from DB evidence; no symbol list is hard-coded.

## Authority boundary
- PAPER only; no DEMO/LIVE authority.
- Prior never creates a trade by itself. It only selects the existing 0.10-lot scout policy before the idle window.
- Candidate must remain TREND_CONTINUATION for this v1 acceleration.
- Minimum 4/6 consensus remains.
- Positive effective net R, aligned momentum, event risk CLEAR, usable execution-cost evidence, portfolio quality, entry alignment, post-loss protection and central risk remain authoritative.
- OOD candidates still require the current calibrated-OOD rescue evidence.
- Current mature weak pair-side reliability remains a downstream veto.
- If the prior evidence is missing, sparse, negative or PF <1.15, behavior is unchanged.

## Prior evidence
Use the most recent 100 CLOSED trades whose intent model is `external-provider/irexpro-multimodel-ensemble-v1/paper-only-v1`. Group by instrument+direction. A prior is supported only when:
- trades >= 8
- net P/L > 0
- gross loss = 0 OR profit factor >= 1.15

Cache the 12-sleeve snapshot briefly to avoid per-candidate queries.

## Scout semantics
A supported prior changes the soft policy to the existing RECOVERY floors immediately:
- confidence >= 0.56
- effective net expected R >= 0.04
- quality floors >= 0.20
- aligned momentum required
- lot cap remains 0.10

It does not relax OOD calibration requirements or consensus below 4/6.
