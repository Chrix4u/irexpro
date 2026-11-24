# Pepperstone cTrader LIVE certification — operator release review

Status: DRAFT, NOT MERGED, NOT DEPLOYED. No automated LIVE trading was enabled.

## Exact certification evidence

- Broker identity: pepperstone-ctrader only, cTrader LIVE account masked as •••6270.
- Real operator certification run: 4ec633e4-a443-47e3-8bca-1f8f214982f5.
- Finished 2026-11-24T01:32:06.437Z.
- Original private artifact: /root/irexpro-live-cert-evidence/live-certification-pepperstone-ctrader-4ec633e4-a443-47e3-8bca-1f8f214982f5-20261124-013206.json
- Canonical content SHA-256: f9d9b0cdb19b5f97629e2608fe93f52f5258237c719d0ca55fdfe0e42ac84643.
- Persisted result: PASS, 15 stages passed, zero failed, one provider-inapplicable account-discovery stage skipped.
- Protected test: BUY AUDUSD 0.01 lots. Native broker order 404148641; opening deal 350035648; position 669276159.
- Independent LIVE broker history audit saved at /root/irexpro-live-cert-evidence/historical-live-canary-order-audit-4ec633e4-a443-47e3-8bca-1f8f214982f5-417bd78d-bdd5-4e5c-baa0-10932a42cb05.json.
- Broker readback: correct native order identity, FILLED 0.01 lots, linked position, closed deal, zero remaining positions and working orders.
- Equity observed $49.97 before and $49.93 after: $0.04 decline. This certifies an execution pathway, not profitability.
- Evidence files are intentionally PRIVATE to the operator. No secrets or raw credentials are committed.

## Proposed scope and required approvals

The draft catalog promotion is limited to the Pepperstone broker identity. Generic cTrader and IC Markets remain UNVERIFIED. Pepperstone remains BETA in overall implementation status. A single protected 0.01-lot AUDUSD test does not certify all order kinds, all instruments, mobile OAuth, or any AI strategy.

Before merge, the accountable operator must independently attest both evidence hashes and confirm Spotware/Pepperstone real-account automated API trading permissions. Actual successful API trading is technical evidence, not contractual proof of provider approval.

The temporary November 22 Pepperstone DEMO release hold remains in effect for unresolved historical order records. Do not dismiss it, delete those records, or restart the live trading service under that hold. Approve a controlled maintenance release only after reconciling the hold, verifying there are no active broker sessions or residual exposure, reviewing rollback, and accepting the runtime risk envelope.

Publishing a certified provider must NOT start automated trades on its own. Separate explicit owner-level LIVE authorization, risk approval, supported broker account, order reconciliation and final dispatch gating remain required.

This PR is proposed certification metadata for independent operator review only. Do not merge or deploy it without the review above.
