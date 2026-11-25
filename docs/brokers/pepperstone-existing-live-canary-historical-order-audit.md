# Existing Pepperstone LIVE canary: historical ORDER ID audit

## Scope and authority

This operation is **read-only**. It audits an **already executed and closed**
Pepperstone LIVE canary, run `236a6506-5368-4b68-b6b4-394c3af3ecb3`,
position `669256554`, account cTrader API ID `49506270`.

The original immutable certification JSON is **FAIL** because the two
native order identity stages did not pass. The real 0.01 lot AUDUSD BUY was
opened, protected, closed and history-reconciled, with zero residual exposure
observed after the run. This retrospective audit MUST NOT rewrite that
evidence, forge a PASS, enable LIVE automated trading or place another trade.

The script `apps/api/scripts/validation/pepperstone-existing-live-canary-history-ro.cjs`
does not call order placement, modification or close APIs. Its broker-facing
requests are restricted to historical deal list, native order-details lookup,
open positions and working orders; credentials are decrypted in memory from
the exact persisted LIVE connection and never printed or written to the audit
artifact. A read-only DB transaction fetches the exact connection. No
`IREXPRO_ALLOW_LIVE_CERTIFICATION` gate is enabled or needed.

## Operator command

After confirming the repository has commit containing this script, run:

```bash
cd /home/lightworld/webapps/irexpro-staging/apps/api
node --test scripts/validation/pepperstone-existing-live-canary-history-ro.test.cjs
node scripts/validation/pepperstone-existing-live-canary-history-ro.cjs
```

The second command contacts the LIVE broker for **read-only history** and
produces a new, separately hashed JSON addendum under
`/root/irexpro-live-cert-evidence`. If it reports `INCOMPLETE` do not rerun
a real-money certification trade. Inspect the public, sanitized refusal code
and arrange a separate manual order-identity proof. A passing addendum is
evidence for **human review**, not a new execution certification.

## Fail-closed conditions

- Original FAIL artifact is absent, duplicated, altered in stage meaning, or
  does not target the exact LIVE account, AUDUSD 0.01 lot, and position.
- Exact account binding, encryption or authentication is missing.
- Deal-history page is truncated, incomplete or omits its completeness marker.
- The historical position has zero, multiple, or malformed opening deals;
  missing closing deal, unknown broker order ID, or invalid timestamps.
- Native order-details readback does not report a FILLED AUDUSD 0.01 lot
  order with that native order ID and the same position when reported.
- Open positions or working orders remain in the account.

If all historical evidence checks pass, review the addendum and original
FAIL artifact jointly with the certified-execution authority; do not
promote a provider's LIVE execution status by changing a catalog flag
without the required independent evidence review and safeguards.

The existing VPS DEMO order release hold remains independently in force.
