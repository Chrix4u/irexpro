# iRexPro critical broker suspension after first 0.01-lot fill
**12 November 2026 | Pepperstone cTrader DEMO | Incident and recovery**

## Verified timeline (all Ghana/UTC)

- **21:15:19** — AUDUSD SELL filled at 0.68053, exactly 0.01 lot,
  broker-recorded SL 0.68101, TP 0.67971. Intent EXECUTED,
  M1 QUALIFIED_CONTINUATION canary, no execution blockers. This was
  the FIRST actual broker position after 10:09 UTC, and it opened
  BEFORE the later M1/Plan B EMA feature-normalization deployment.
- **21:16–21:18** — BrokerService and StateReconciliationService logs:
  `numeric field overflow`, repeated account snapshot/projection failures.
  After three genuine write failures the built-in connection health
  handler marked the account SUSPENDED, correctly blocking NEW exposure
  but also deferring risk/PROFIT_PROTECTION reconciliation.
- **21:22** — Post-deployment health inspection found account SUSPENDED,
  though cTrader application OAuth connection was healthy and open order
  remained in broker ledger. Do NOT blame the model normalization
  change for this: suspension happened at 21:18, before 21:21 reload.
- **21:24–21:25** — Root cause verified against BOTH tables:
  provider margin amount ~1.36 and account equity ~48,741,
  margin level **3,583,905.88%**, perfectly valid for tiny collateral.
  Authoritative `broker.broker_account_snapshots.margin_level` is
  `NUMERIC(20,8)` and recorded 3.58M% correctly.
  The COMPAT projection `broker.broker_accounts.margin_level`
  was `NUMERIC(10,4)`, maximum 999,999.9999%; the account snapshot
  projection and state-reconciliation `UPDATE` both overflowed.
  This was NOT a provider authentication failure, missing credentials,
  real-money environment mismatch, broker disconnect or bad position.
- **Immediate guarded schema repair:** in transaction with lock timeout,
  `ALTER TABLE broker.broker_accounts ALTER COLUMN margin_level TYPE NUMERIC(20,8)`.
  No financial number, account limit, leverage, stop/TP, order or broker
  authorization record was edited.
- **21:26:05** — The EXISTING five-minute broker-health suspended
  recovery safely completed a fresh provider handshake, preserving
  verified DEMO identity and returning `status=CONNECTED`,
  `authorization_status=ACTIVE`, `credential_status=VERIFIED`,
  failure count 0 and null last error. No manual DB permission/status
  tampering was performed.
- **21:28** — Latest `broker.broker_accounts` safely stored
  `margin_level=3,583,902.21000000`, used margin ~1.36, and
  `open_positions_count=1`. BrokerHealthCheckJob reported healthy
  run; StateReconciliationJob completed without a repeat overflow
  for the active Pepperstone account. AUDUSD trade remained OPEN
  with original broker stop and target.

## Permanent source repair

- Migration `1794529000000-WidenBrokerAccountMarginLevel.ts`
  widens ONLY the legacy broker account margin percentage to
  `NUMERIC(20,8)`; no trade position, risk budget, authority or
  portfolio fields affected. Idempotent against the urgent hotfix.
  Defensive down migration fails explicitly if real provider values
  exceed old precision instead of silently truncating them.
- `BrokerAccount` TypeORM entity's marginLevel decorator is updated
  to match the authoritative snapshot field precisely.
- New migration contract tests require the widened type and safe
  downgrade guard.
- No additional API restart required for the already-repaired physical
  database representation. Avoid unnecessary API restart while an
  open broker position is being monitored.

## Next acceptance checks

- Broker remains CONNECTED/AUTHORIZATION ACTIVE on subsequent cycles.
- Legacy snapshot safely accepts repeated 3.58M% margin levels.
- Reconciliation and DEMO profit-protection cycles run without
  `numeric field overflow`, suspension, or skipped connection.
- Open position remains synchronized with actual broker fill, stop
  and take-profit; after eventual close verify the actual net result,
  including paid commission, not just paper expected R.
- Never use this incident to relax margin, drawdown, stop-loss,
  account identity or real-money safeguards.
