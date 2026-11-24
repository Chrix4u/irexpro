# cTrader operator certification with an existing encrypted OAuth connection

This is an **operator-only, REAL-MONEY** certification procedure. It is not a
user-facing trading flow, and it does not authorize LIVE AI trading. The
certification harness can place and close a real minimum-volume canary trade;
losses, slippage, spreads and commissions are possible. A risk cap is not a
guarantee of maximum realized loss.

## What changed

The original operator harness supported only
`CTRADER_LIVE_CERT_ACCESS_TOKEN` supplied in the SSH environment, which
became stale when the owner reauthorized their cTrader account through iRexPro.
A new explicit `CTRADER_LIVE_CERT_CREDENTIAL_SOURCE=stored` option lets an
authorized operator resolve the exact **server-side encrypted** broker
connection instead. It never prints, exports or persists a plaintext token.
The original environment-token option remains supported for operators who
already have a securely provisioned, valid token.

**Security boundary:** It is disabled unless the real-money certification
master gate is explicitly `true`. The operator must specify the exact
broker alias, cTID API account ID, owner UUID and broker connection UUID.
The reader performs a one-row, parameterized, read-only database lookup and
rejects a different provider identity, owner, account, environment, inactive
connection, revoked/invalid credentials, malformed ciphertext or access
token expiring in less than five minutes. It never refreshes an OAuth token
or executes broker orders. The caller clears its in-memory reference after
the certification. The certification harness retains its independent
risk, quote freshness, spread, stop, margin, baseline exposure and
post-close reconciliation checks.

### Read-only identity lookup

Run from an SSH terminal controlled by the owner or broker-execution
operator. **Do not post owner/connection IDs or any secrets in public logs.**

```bash
cd /home/lightworld/webapps/irexpro-staging/apps/api
export CTRADER_LIVE_CERT_BROKER_ID="pepperstone-ctrader"
export CTRADER_LIVE_CERT_CTRID_ACCOUNT_ID="49506270"
node scripts/validation/ctrader-live-cert-identity-ro.cjs
```

The lookup prints `owner_user_id` and `connection_id` in addition to
non-secret status fields. If there is not exactly one matching account,
stop and reconcile the broker connection first. The lookup **never reads
or displays** encrypted credentials.

### Operator-only certification

The operator must independently verify the broker's required external
approvals, market conditions, account risk budget and willingness to
accept a real-money canary. In their secure SSH terminal, after reviewing
the output above:

```bash
cd /home/lightworld/webapps/irexpro-staging
unset CTRADER_LIVE_CERT_ACCESS_TOKEN
export IREXPRO_ALLOW_LIVE_CERTIFICATION=true
export IREXPRO_LIVE_CERT_OPERATOR_ID="<authorized-operator-id>"
export CTRADER_LIVE_CERT_CREDENTIAL_SOURCE="stored"
export CTRADER_LIVE_CERT_OWNER_USER_ID="<owner_user_id from lookup>"
export CTRADER_LIVE_CERT_CONNECTION_ID="<connection_id from lookup>"
export CTRADER_LIVE_CERT_BROKER_ID="pepperstone-ctrader"
export CTRADER_LIVE_CERT_CTRID_ACCOUNT_ID="49506270"
export CTRADER_LIVE_CERT_INSTRUMENT="AUDUSD"
export CTRADER_LIVE_CERT_MAX_CANARY_EXPOSURE="1250"
export CTRADER_LIVE_CERT_MAX_CANARY_RISK_USD="1"
export CTRADER_LIVE_CERT_RELATIVE_STOP_LOSS="50"
export IREXPRO_LIVE_CERT_EVIDENCE_DIR="/root/irexpro-live-cert-evidence"
umask 077
mkdir -p "$IREXPRO_LIVE_CERT_EVIDENCE_DIR"
chmod 700 "$IREXPRO_LIVE_CERT_EVIDENCE_DIR"
pnpm --filter @irexpro/api exec jest \
  src/modules/broker/verification/ctrader.live-certification.spec.ts \
  --runInBand --no-coverage
```

The exact value of each limit is an operator's risk decision, **not** a
recommended position size. A tight five-pip stop may be rejected because
the live spread consumes too much of its distance. The run must refuse a
trade whenever a quote, spread, fee, margin or risk precondition fails;
do not bypass any such refusal. Never blindly rerun a failed test: inspect
the saved evidence and independently confirm that no residual LIVE
position or pending order remains with Pepperstone.

The API .env is read **only** when the master gate is already enabled and
the operator chooses `stored`. The master gate is resolved before reading
that file, so neither production .env nor CI can silently authorize the
real-money spec. The account token and encryption key never appear in
stdout, evidence JSON or a command-line argument.

### Release process

The harness writes a hashed JSON artifact. Only a PASS with fully
persisted, verified evidence and zero unexpected exposure can support
the separate human review and provider-catalog certification decision.
Do not mark Pepperstone VERIFIED or enable automated LIVE trading based
on an OAuth login, balance, mock test, nontrading reconciliation or a
console PASS without durable certification evidence.
