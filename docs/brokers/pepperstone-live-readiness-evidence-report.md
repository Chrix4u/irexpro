# Pepperstone LIVE readiness: certified evidence versus deployed authorization

The owner completed a genuine operator-authorized 0.01-lot AUDUSD Pepperstone
LIVE certification run 4ec633e4-a443-47e3-8bca-1f8f214982f5 on 2026-11-24.
The saved run is PASS / PERSISTED (15 passed, 0 failed, 1 skipped). A separate
read-only provider-history audit verified the distinct native order ID and
position ID with zero remaining positions or orders.

These facts do NOT mean automated LIVE trading has been enabled.

## Read-only diagnostic

From the authorized VPS:

    cd /home/lightworld/webapps/irexpro-staging/apps/api
    node scripts/validation/pepperstone-live-activation-readiness-ro.cjs

The exact run ID, canonical evidence hash, expected lifecycle, original file
hash linkage and broker historical readback are checked from the protected
operator evidence directory. The diagnostic does not contact the broker,
write database fields or submit any orders. It reports
ATTESTED_PASS_PENDING_RELEASE and the pending release blocker when both
the immutable PASS and its linked independent order proof validate.

Provider verification in the deployed broker catalog is a SEPARATE authority.
Even with valid evidence the diagnostic does not mark production-LIVE
CERTIFIED or enable any account's live-trading flag. It is a status
dashboard, not a certification grant.

The operator release hold DEPLOY-HOLD-ACTIVE-BROKER-20261122.txt still
applies to service restarts. The 249 historical DEMO order records marked
RECONCILIATION_PENDING remain evidence requiring authenticated resolution.
Do not delete or rewrite those records to make the hold appear clear.

After operator review, verify broker approval, maintenance permission,
release gates, account authorization and order-safety requirements before
considering any production LIVE activation.
