# Pepperstone LIVE: server-signal admission boundary

## Verified 24 November 2026

The Pepperstone LIVE account was CONNECTED, provider-certified,
live_trading_enabled=true, with an ACTIVE FULL_AUTO trading session.
LIVE broker-native M1-M5 data were available and LIVE reconciliation
had no unresolved discrepancies. Zero LIVE orders were recorded.

For comparison, in the last 24 hours 148 DEMO M1 decisions carried
BROKER_NATIVE authority, including 126 with model authority BLOCKED
and 105 with tactical route ABSTAIN. There were 59 FILLED DEMO orders.
This results from separately scoped DEMO-only alternative and pilot
pathways, not from more complete LIVE provider integration.

The independent Strategy Orchestrator Gate 3.5 had another blocker:
the local M1 scheduler emitted external_provider_paper_only=true for
both DEMO and LIVE. Until this patch Gate 3.5 allowed an exact PAPER
internal broker or validated DEMO session, and categorically refused
such a signal on any LIVE broker account, even if the original M1
scheduler later produced a fully admitted primary candidate.

## Narrow fix

Only a candidate created inside M1TacticalSchedulerService gets a
nonserializable in-process Symbol. External JSON calls cannot forge
this origin. The orchestrator independently verifies:
- exact primary multi-model/M1 strategy version and timeframe;
- Plan-B originally admitted and PRIMARY_PLAN_B selected;
- exact matching Plan-B/M1 route (not a similar research route);
- DEMO trial, alternate, fallback, M5 handoff and scout flags false;
- exact owner-selected FULL_AUTO session and connection binding;
- Pepperstone broker identity, LIVE environment, CONNECTED account,
  ACTIVE authorization and enabled LIVE trading;
- server catalog currently certifies Pepperstone for LIVE.

All other gates still run: 0.60 baseline confidence threshold,
durable identity/idempotency, trade intent recording, LIVE-fresh
broker snapshot, exact stop-risk position sizing, capital allocation,
portfolio concentration, RiskService and independent final-dispatch
provider verification/quote/reconciliation controls.

No demo-only risk overrides are ported. In particular, no DEMO
alternative pilot can gain new LIVE authority from this fix.

## Important qualification

This patch fixes the *downstream LIVE categorical rejection* only.
It does not invent strategy admission. The current LIVE M1 decisions
had zero exact matching model/M1 primary-route authority. A small
retrospective of seven mismatches yielded 2 positive and 5 negative
hypothetical after-estimated-cost outcomes; it cannot justify promoting
DEM0 pilot exceptions to real money. No trade is promised.

## Safe release checklist

Pass all affected Jest tests, build and typecheck. Before restarting
the API verify no real open positions, in-flight/uncertain orders, and
zero outstanding reconciliation discrepancies for this exact LIVE
account. Back up compiled API, do API-only replacement and restart,
verify health/account session state, and preserve the historical DEMO
maintenance hold. Do not submit an order to test the code patch.
