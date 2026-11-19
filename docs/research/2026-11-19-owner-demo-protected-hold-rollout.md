# iRexPro Pepperstone DEMO protected-hold rollout — 19 Nov 2026

## Objective

Allow a *verified existing* Early Transition or Confirmed Reversal winner to
continue towards its original TP **only when** independent as-of M1 price action
supports the move and broker-side profit protection is actually installed.
Do not infer exit authority from whether a *new* trade can be admitted.

## Verified outcome and adverse selection

Three recently settled Trend Continuation positions hit their broker TP:
USDJPY 3.19 lots (+$154.52 after commission), EURUSD 1.78 lots (+$124.60),
USDJPY 0.20 lots (+$9.19), combined +$288.31. One short successful sequence
does not generalize to the reversal routes.

Read-only as-of profit-lock hold validation through 19 November 09:51 UTC:
71 valid settled protected closes, no qualified old-expert HOLD recommendation;
their actual aggregate booked profit was +$2,121.15 after signed commission.
Among 43 after-exit quote-verified and barrier-free 15-minute observations,
22 had a better mark after withholding the actual exit, 20 had a worse one,
one was tied, aggregate indicative difference **-$417.37**.
28 of 71 were censored at 15 minutes for possible original TP/SL touches or
quote gaps. This cannot be interpreted as full strategy expectancy or
hypothetical broker fills. Longer unconditional holding is not authorized.

## Active behavior after 19 November deployment

- Existing five-second cTrader DEMO profit protection stays LIVE on DEMO only;
  existing 65/75/80 tiered alternate-route exit and original SL/TP remain.
- The minute-scoped owner Pepperstone USD DEMO monitor now audits **every**
  eligible OPEN M1 position, even if the earlier maximum favorable
  broker-net P&L is less than 0.25R. It records fresh independently quoted
  M1 evidence and same-side continuation without requiring new-entry permission.
- For qualifying healthy reversal/transition positions, a READ-ONLY second
  check estimates after-cost runner stop feasibility from causal fee history,
  independently sampled recent bid/ask and original price-risk geometry.
- When an existing profit protector actually closes a position, its
  after-dispatch trend audit stores the independent exit-intelligence
  recommendation frozen at the decision timestamp, permitting prospective
  comparison against later quote paths.
- This work is shadow-only: no increase in lot sizes, no new-order bypass,
  no broker SL amendments, no suppressing the actual profit close, no
  LIVE-account authority.

## 19 November: guard against accidental loss of a tighter broker stop

A separate reconciliation invariant is implemented for the authenticated
owner's Pepperstone USD **DEMO** account, gated by
`IREXPRO_PEPPERSTONE_DEMO_PRESERVE_TIGHTER_BROKER_STOP=enabled`. When the
provider reports a strictly more-protective already-profitable stop than the
original authorized risk stop, reconciliation will **not amend it back to the
weaker level**, provided broker identity, account and currency, side, symbol,
lot size, entry and current price, stop geometry and matching original TP all
agree. It returns `PROFIT_STOP_PRESERVED_REQUIRES_SYNC` in the aggregate
protective reconciliation audit and reports the number of such positions.
This is a no-amendment safety guard, not approval to hold a trade longer or
to assume authoritative stop updates have been persisted. If any proof is
missing, the prior documented repair path remains. The service can still
close a position under its current five-second protection decision; it
does not rely on this guard to suppress that close.

For a durable protected-hold rollout, successful broker amendment with
provider readback and **atomic stop-authority persistence** is still
required. The guard does not write an amendment or create a broker order.
Do not enable for LIVE accounts.

## Why a broker-side positive stop is NOT yet executable

The cTrader adapter supports `modifyOrder` on positions, but its acceptance
response is NOT sufficient evidence of final broker stop installation.
`ProtectiveOrderReconciliationService.verifyAndRepairOne()` currently restores
provider stop/TP back to the internally authoritative `trades.stop_loss` and
`trades.take_profit` when mismatched. Thus blindly amending the broker's
stop without coordinating the internal authority could be promptly reverted.

A safe future rollout needs all of the following in the same owner DEMO
scope, with idempotent per-position safeguards:

1. Independent, fresh native bid/ask, symbol tick-size and minimum
   stop-distance from cTrader. Recheck exact provider position ID,
   side, lot, broker state, commission/financing reserve and sufficient
   positive after-cost floor immediately before amendment.
2. A durable protection-amendment intent with idempotency and serialized
   per-position ownership; not an unsigned untracked adapter invocation.
3. Provider-acknowledged stop amendment **and fresh position read-back**,
   reconciled into internal authoritative SL state with crash recovery.
   Update reconciliation to understand an authorized pending amendment and
   its strictly tighter candidate, never accept a looser stop.
4. A bounded grace expiry, after-fee floor, opponent/reversal exit criteria,
   and fallback to the original profit close if broker verification fails
   before the close is due. Never postpone a due close on a shadow forecast.
5. DEMO broker-integration tests for BUY/SELL, market/STOP coexistence,
   provider reject/timeout, restarts, duplicate requests, partial fills,
   stale quotes, manual stop changes, stop and TP races, and active repair loops.
6. Independent walk-forward post-decision analysis of candidate vs actual
   settlement P&L; only a positive after-cost directional edge can justify
   broader staged promotion. LIVE remains off.

### Deployment boundary

This ADR documents a rollout gate, not permission to immediately alter
positions. Existing profit retention, original stop/TP and manual STOP
remain authoritative.
