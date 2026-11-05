# z.ai P1 cTrader DEMO independently read broker evidence — 2026-11-05

## What this change actually delivers

A **read-only**, concrete cTrader adapter method `readDemoPartialCloseProviderEvidence` fetches an exact deal ID from cTrader's `ProtoOADealListReq`, and then independently snapshots the same position through `ProtoOAReconcileReq`. It also resolves the actual broker account deposit currency. This API is NOT exported on the general `IBrokerAdapter` contract, not used by a scheduled job, not exposed via a REST controller, and **never** sends close/place/modify orders.

The reader rejects LIVE, wrong account IDs, wrong provider position/deal IDs, invalid time windows, inconsistent deal status/volume, duplicate provider IDs and missing symbol conversion data. Because cTrader historical pagination with equal-millisecond timestamps is not proven lossless, any truncated/ambiguous page is a **hard read failure**; it is never treated as a complete search.

Returns provider deal ID, position ID, broker account ID/currency, execution timestamp, filled lots and independent currently open residual lots, plus RAW gross P&L/commission/swap if explicitly reported with valid precision. The reply is labelled `source: DEAL_LIST_AND_RECONCILE` and carries hard-coded `canConfirm: false` / `canDispatchOrder: false`.

## What it explicitly refuses to claim

- **Broker lots BEFORE close**: the current snapshot after a deal cannot prove the historical pre-close position volume. The reader always emits `brokerLotsBefore: null`, even if filled + current appears equal to 0.02 lot. The initial 0.02-lot position size needs an independent durable pre-dispatch broker snapshot bound to the same order/position, plus drift detection.
- **Signed commission and swap**: cTrader reports raw numbers. Sign normalization must be reconciled with broker account cash/deal semantics before displaying net P&L. This reader returns `commissionRaw`, `swapRaw`, `feesSignVerified: false`; missing fields stay NULL rather than fabricated zero.
- **Remaining protection**: a residual position or absent position observation does not establish unchanged stop-loss/take-profit or a safe full-close amount. Future execution code must re-check provider truth.
- **Historical timestamp sorting**: no pagination guesswork that could silently miss a deal.

## Tests and release gates

The adapter test suite includes broker fake-transport tests for exact deal read, independent position read, account isolation, DEMO-only enforcement, seven-day window, truncated history, duplicates and unknown remaining volume. Pure mapper tests verify no false pre-close volume or fee proof, missing economics and mismatched identities. Existing cTrader regression tests are rerun.

## Mandatory before any DEMO partial-close dispatch

Persist exact broker **pre-close** volume at the durable commitment boundary; bind order/deal/position identity and initial protection, compare post-close provider snapshot to pre-close snapshot and exact fill with no intervening manipulation; verify fee signs/currency. Then reconcile the partial leg and update account-currency P&L, total costs, daily risk, Stop AI Trading and 0.01-lot residual full-close paths **atomically and idempotently**. Only after this do we run an isolated cTrader DEMO 0.02-lot pilot. LIVE and large lots remain out of scope.
