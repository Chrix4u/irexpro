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

Before merge, the accountable operator must independently attest both
evidence hashes, confirm the platform application is approved in Spotware's
Open API portal and ensure the owner's exact LIVE account remains authorized
with the trading OAuth permission. The independently verified broker fill
proves technical trading permission on that account at test time, but does
not establish a general contractual authorization for every account or user.

The official cTrader Open API guide says approved apps can trade on DEMO and
LIVE accounts and that the Open API is supported by default across affiliated
brokers. It does **not** establish a blanket requirement for a *second*,
separate Pepperstone API partner approval for each supported account.
Specific broker or account restrictions, if any, should be verified rather
than invented as generic blockers.

- Official API overview: https://help.ctrader.com/open-api/
- Approved application registration: https://help.ctrader.com/open-api/api-application/
- OAuth permission scopes: https://help.ctrader.com/open-api/account-authentication/
- Explicit prior trader approval is required by Spotware terms:
  https://help.ctrader.com/open-api/terms-of-use/

The temporary November 22 Pepperstone DEMO release hold remains in effect
for 249 historical RECONCILIATION_PENDING close-order records linked to 249
closed trades. Read-only audit on 2026-11-24 found no active AI sessions,
no open positions, and no working orders; the old records are beyond the
six-hour guarded auto-recovery window. One record has close-before-submission
timestamp ordering, so bulk status rewriting is particularly unsafe. Do
not dismiss the hold, delete those records, or restart the trading service
under that hold. Approve a controlled maintenance release only after
independent authenticated close-deal reconciliation, resolving the
exception, exact-candidate preflight verification, zero-exposure checks,
reviewing rollback, and accepting the runtime risk envelope.

Publishing a certified provider must NOT start automated trades on its own. Separate explicit owner-level LIVE authorization, risk approval, supported broker account, order reconciliation and final dispatch gating remain required.

This PR is proposed certification metadata for independent operator review only. Do not merge or deploy it without the review above.
