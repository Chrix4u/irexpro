# iRexPro professional sizing + DEMO promotion implementation plan

## Goal
Replace micro-lot-by-default behavior with risk-budgeted professional sizing, allow up to 4.0 lots when broker/risk/margin geometry permits, eliminate 0.05 as an executable product tier for promoted trading, and promote the frozen candidate from PAPER-primary to validated DEMO execution without granting LIVE authority.

## Safety and product invariants
- Never guarantee profit or size from confidence alone.
- Every executable order must have a provable stop-loss distance, contract size, account equity/free margin, broker min/max/step, and required margin.
- Preferred executable floor is 0.20 lots for promoted PAPER/DEMO. If 0.20 cannot fit the durable risk ceiling or broker/margin rules, abstain instead of silently sending 0.05/0.10.
- Professional ceiling is 4.00 lots. 0.50/1/2/3/4 are reachable only when stop-distance risk + capital + broker margin permit them.
- DEMO and LIVE remain isolated. DEMO promotion cannot set liveTradingEnabled or route to a LIVE account.
- Preserve paper/research machinery for diagnostics and reproducibility, but DEMO becomes the primary operational target after validation.

## Phase 1 — position sizing tests first
1. Extend allocation-aware sizing tests so a DEMO allocation follows the promoted sizing policy.
2. Add a failing test: soft risk result below 0.20 must either be safely lifted inside durable risk or fail with POSITION_SIZE_BELOW_POLICY_MINIMUM; never return 0.05/0.10.
3. Add failing tests proving 0.50, 1.00, 2.00, 3.00 and 4.00 can pass when risk/margin/broker caps support them.
4. Add a failing test proving >4.00 clamps to 4.00.
5. Add a failing test proving 0.20 is rejected when durable stop risk or required margin cannot support it.
6. Add a failing test proving DEMO sizing never bypasses broker maxLot/lotStep/profile risk percent.

## Phase 2 — sizing implementation
1. Replace PAPER-only allocation policy with promoted non-LIVE simulation policy supporting PAPER_ONLY + DEMO.
2. Set product preferred minimum executable lot to 0.20 for promoted routes; remove the 0.05 provisional executable exception from the dispatch path.
3. Raise product maximum from 2.00 to 4.00.
4. Keep dynamic confidence tier as a soft upper bound only; add ELITE 4.00 authority, while stop-risk and margin remain hard bounds.
5. Raise new risk-profile default maxPositionSizeLot to 4.0000 and migrate legacy default-valued profiles conservatively if evidence shows they are still at the old system default.
6. Ensure RiskService does not re-clamp validated promoted sizing back to 0.10.

## Phase 3 — broker DEMO promotion tests
1. Verify broker catalog exposes cTrader family and MetaTrader 5 DEMO capability.
2. Verify Direct-MT5 onboarding/pairing and cTrader OAuth routes compile and pass their focused suites.
3. Add/adjust a test proving active DEMO authority routes execution to the DEMO connection and never LIVE.
4. Verify validate-demo -> enable-demo-trading lifecycle leaves liveTradingEnabled=false.
5. Ensure execution mode selection/default can choose DEMO as operational target once a validated active DEMO broker exists.

## Phase 4 — current model evidence
1. Query the deployed PAPER ledger by frozen strategy/model cohort, not mixed historical total.
2. Compute closed trades, W/L, win rate, net P&L, profit factor, expectancy, max drawdown and losing streak for the comparable cohort.
3. Record a provisional qualification verdict against the project gates; do not treat mixed historical generations as a single sample.

## Phase 5 — deployment and verification
1. Run focused sizing, risk, broker/cTrader/Direct-MT5 and execution suites.
2. Run API type/build checks and database migration dry/actual path as appropriate.
3. Commit the isolated branch and integrate into current staging release only after green verification.
4. Apply migration and restart API/worker processes.
5. Health-check broker registry, DEMO lifecycle endpoints, AI status, trade activity, and sizing telemetry.
6. Leave LIVE disabled. The remaining external user action, if any, is only provider authorization/pairing of the user's own DEMO account.
