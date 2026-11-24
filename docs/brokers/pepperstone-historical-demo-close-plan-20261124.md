# Historical Pepperstone DEMO close reconciliation: reviewed proof plan

**Status:** Source-only preparation. No historical order has been mutated by this change. No LIVE account permissions, broker orders, or trading services are modified.

## Evidence verified (read-only, 2026-11-24)

Authenticated Pepperstone DEMO deal history was retrieved in complete bounded windows (splitting November 20 to avoid the provider's 200-row limit; November 14–15 returned explicitly empty pages). This found **249 unique close-position/time matches for 249 pending records** and **249 exact price and gross P&L matches**, with the exact instrument, closing direction and lot size. There were zero open DEMO positions and working orders.

One recorded USDJPY close timestamp predates its corresponding internal close-order submission by **5,209 milliseconds**. The remaining **248** records have provider close timestamps at or after order submission. The anomalous record must remain withheld until the source of the clock/order-state discrepancy is explained independently. Do not synthesize an order acknowledgment to fix its chronology.

## Pure historical proof module

`apps/api/src/modules/execution/reconciliation/historical-demo-close-proof-plan.ts` prepares a **non-executing** per-order candidate by verifying all of:

- Pepperstone DEMO, exact owner and connection, flat broker account, complete provider history page and unique order/close-deal identities
- Internal order still `RECONCILIATION_PENDING`, no existing fill or native provider order ID, unique linked `CLOSED` trade, matching instrument and opposite closing direction
- Exact raw broker `positionId`, opening-independent closing `dealId` and `orderId`; timestamp agrees with the stored close and is not earlier than the order's recorded submission
- Exact decimal equality of broker fill lot size, closing price and gross realized P&L with the internal closed trade; no inferred economics
- Historical age no more than 30 days, dispatch/close bounds at most 120 seconds, and unique identifiers across the batch

This is deliberately separate from the regular 6-hour runtime reconciliation rule. **It cannot execute reconciliation.** An authorized maintenance handler would still need to re-read and lock each order, verify the broker and database are flat/inactive, preserve a pre-change backup, compare an operator-approved exact proof digest, and call the existing `OrderService.applyFill()` domain CAS for one proven order at a time. It must reverify state after every change and stop on the first discrepancy; the USDJPY exception remains untouched.

## LIVE release separation

The real Pepperstone LIVE operator certification run `4ec633e4-a443-47e3-8bca-1f8f214982f5` is a persisted PASS. That does not waive the DEMO historical hold or mean automated LIVE is enabled. The Pepperstone-specific catalog promotion remains in GitHub draft PR #791 pending independent authorization and controlled deployment. Keep `DEPLOY-HOLD-ACTIVE-BROKER-20261122.txt` in place until maintenance release checks and operator approval are complete.
