# V8 DEMO Start Gate Design

## Intent
Allow the scanner-owned iRexPro user to transition from the historical PAPER research session into the already-promoted V8 real-provider DEMO path without weakening LIVE controls.

## Goals
- Preserve the exact configured PAPER connection + PAPER_ONLY research authority.
- Permit FULL_AUTO only on an owned, CONNECTED, healthy, non-paper DEMO connection that is `demoValidated=true`, `authorizationStatus=ACTIVE`, and `liveTradingEnabled=false`.
- Keep LIVE blocked for the scanner-owned user during the V8 DEMO promotion.
- Keep generic users unchanged.
- Keep the strategy/model allowlist and all downstream risk/execution gates unchanged.

## Non-goals
- No LIVE promotion.
- No model qualification changes.
- No position-sizing changes.
- No automatic broker selection or database status mutation.

## Approach
Move the scanner-specific start authority decision out of the controller-only PAPER lock and into `TradingService.startTradingSession`, after the exact broker connection is resolved and health-checked. The service has the authoritative broker environment and validation/authorization state, so it can distinguish a promoted DEMO connection from LIVE or an unvalidated connection. The controller continues to resolve the requested execution mode and delegates to the service.

Alternative approaches rejected:
- Remove the controller lock entirely: too broad; could allow unintended LIVE starts for the scanner-owned user.
- Hard-code the cTrader connection ID: not durable and would break broker portability.

## Safety invariants
- `FULL_AUTO` is execution automation, not LIVE authorization.
- Scanner-owned LIVE connections remain rejected even if separately live-enabled.
- V8 strategy routing remains restricted to the frozen M1 model tuple in `StrategyOrchestrator`.
- The broker DEMO must already be validated and activated through `enableDemoTrading`; no DB shortcuts.
