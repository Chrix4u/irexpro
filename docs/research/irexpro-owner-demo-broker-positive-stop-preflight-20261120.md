# iRexPro — broker-side positive stop preflight (owner USD DEMO)

**20 November 2026 — read-only provider evidence and safely bounded preflight.**

## Why owner profit giveback was large

The existing `IREXPRO_PEPPERSTONE_DEMO_PROGRESSIVE_TP_RETENTION=enabled`
rollout began 09:28:43 UTC. This tightens when the server requests a
profit-protection market close, but does NOT place a broker-acknowledged
trailing stop. A five-second poll cannot guarantee the exit level during a
sharp move, and a stop can also slip under a market gap.

At 10:05 UTC, five settled post-rollout positions (3 W / 2 L) produced
**+$10.48** after costs, and three protected exits captured **69.0%**
of summed sampled broker-net peaks, compared with **48.1%** over 17
protected exits before rollout. Small sequential samples are **not**
proof of incremental expectancy.

## Native positive-stop qualification blocker

An exact-owner Pepperstone cTrader USD DEMO read-only audit of historical
`DEMO_POSITION_EXIT_INTELLIGENCE_SHADOW` observations found:

- **1,461** observations covering **104+** distinct positions since Nov 19
  (rollout report records the exact count).
- **24** candidate observations across **14** distinct positions passed
  indicative runner position/fee/quote validation.
- **0** passed the subsequent broker-native minimum-distance proof.
- All 24 candidate observations reported
  `MIN_STOP_DISTANCE_UNAVAILABLE` (native `slDistance` metadata absent
  from the normalized symbol specification).
- No broker profit-stop amendment ledger entries were found at this stage.

The official cTrader `ProtoOASymbol.slDistance` is **optional** and
`distanceSetIn` defaults to POINTS; there is a genuine distinction
between a **PRESENT zero** (published zero minimum) and an **ABSENT**
optional field (unknown). Never assume missing means zero.
Source: Spotware's official
`OpenApiModelMessages.proto`, `ProtoOASymbol.slDistance` and
`ProtoOASymbolDistanceType`.

## Targeted repairs

1. **cTrader adapter normalization:** Preserve a provider-explicit
   `slDistance: 0` as `minStopLossDistance:'0'`, with unit `POINTS`.
   A truly absent slDistance remains unknown and is not supplied as 0.
   Unsupported PERCENTAGE units continue to fail closed.
2. **Native stop-distance proof:** Accept explicit zero only with
   mandatory quote freshness, positive price geometry and a separate
   spread/tick headroom. The broker must still validate and acknowledge
   an eventual amendment.
3. **Tick precision:** The existing P&L-to-price indicative protected
   stop had precision such as USDJPY SELL `158.96508261` even when the
   broker instrument has three digits. A new pure helper rounds BUY stops
   **down** and SELL stops **up** to actual provider digits, conservatively
   never promising more price protection than the raw indicative estimate.
   The preflight is re-evaluated with the rounded level; the unrounded
   shadow suggestion remains in the audit.
4. **Observability:** Every qualified preflight audit now includes
   provider-published minimum-stop distance and unit (or null if
   absent), broker-rounded candidate price, source reason, and explicit
   `noTradeAuthority:true`.
5. **Scoreboard:** Existing read-only owner monitor refreshes:
   `/home/lightworld/webapps/irexpro-research/profit-protection-rollout/latest-broker-stop-readiness.json`.
   Counts sampled candidates vs unique trades, native reason breakdown,
   provider-published zeros vs missing, tick-rounding occurrences,
   and native preflight passes. ZERO broker orders or modifications.

## Strict rollout boundary

**This change does NOT dispatch or activate any positive broker stop**.
The stored `demo_profit_stop_amendment_intents` table and
`DemoProfitStopAuthoritySyncService` are an incomplete dispatch bridge:
the sync service only commits an already acknowledged broker stop and
does not send an amendment itself. It must never be mistaken for an
installed broker stop.

Before any executable broker-side pilot, require: actual native symbol
stop-distance metadata and quote, an account-scoped audited amendment
method, idempotent durable ledger/attempt state, broker-accepted response,
fresh position readback of the exact stop and TP, atomic authoritative
database synchronization, no broader authority or LIVE changes, and
a safe path for unresolved provider results. No server-side protected
HOLD bypass before that confirmation.

Tests cover provider zero vs missing SL distance, JPY/major precision,
BUY/SELL conservative rounding, invalid geometry, stale quotes,
unrelated brokers, and read-only scoreboard.

The existing demo progressive protection is unaffected by this preflight
work and the owner-authorized higher-lot trial still ends at **12:00 UTC**.
