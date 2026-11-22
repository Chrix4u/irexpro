# iRexPro — phone-only MT5 onboarding with server-side execution

## Current implementation (native iOS and Android)

The iRexPro mobile app Broker screen supports a dedicated **iRexPro Hosted
MT5** DEMO onboarding route. This is not an Expert Advisor running inside
MetaTrader 5 for Android/iOS. It is a native remote-control experience for the
existing iRexPro-owned Windows Hosted MT5 Worker.

A user needs **only a phone** to:
1. Sign into iRexPro and view the API-authoritative broker catalog.
2. Select Direct MT5 **only if** `hostedMt5Readiness.ready === true`.
3. Enter their DEMO MT5 numeric login, exact broker server, and *trading*
   password. Investor/read-only credentials do not enable trading.
4. Send the credentials once via the authenticated HTTPS API using existing
   AES-GCM encrypted server-side broker credential storage. No password is
   stored by iRexPro mobile or placed in a URL.
5. Request the existing `POST /broker/direct-mt5/hosted/:id/provision`.
6. See “provisioning requested”, **not** a false success or first trade.
7. View broker-terminal heartbeat/authorization/health (refresh manually, or
   poll every 15 seconds while the app remains in the foreground). Terminal
   status is not inferred from the saved broker-connection status.
8. Lock the phone, close iRexPro or turn their laptop off. A healthy
   independent execution worker can continue **subject to market hours,
   broker conditions, risk policy, worker host uptime and connectivity**.

There is no MetaAPI subscription. The mobile app has no broker-facing
execution code and cannot bypass the existing server-side broker-identity,
margin, order-lifecycle, risk, reconciler or LIVE qualification gates.

## Current deployment truth (2026-11-22)

- Existing Hosted MT5 API, session lease protocol, Windows worker packaging,
  credential encryption, direct terminal integration, heartbeats and journal
  are already in the codebase; do not build a parallel order engine.
- The public iRexPro API currently has `HOSTED_MT5_ENABLED=false`.
- No certified Windows hosted-execution host has been verified through
  this task. The current Linux VPS is **not** evidence that Windows
  MetaTrader5 Python package/terminal is running.
- Consequently, the API registry reports hosted readiness as unavailable
  and the mobile action remains disabled. **Not deployed as a live feature.**
- Hosted LIVE remains blocked until real broker-live certification has
  been independently verified and the explicit LIVE rollout review passes.

## Operator steps to make phone-only 24/7 operation real

1. Select a dedicated, supported Windows Server/Windows VM or broker-provided
   Windows MT5 VPS; account for Windows licensing, monitoring and service
   costs. The platform may be cheaper than MetaAPI, but is not necessarily
   free. Do not use the customer's own desktop/laptop.
2. Verify the existing `iRexPro-MT5-Host-Worker.exe` and
   `install-host-worker.ps1` in the Windows connector release artifact.
   Use a dedicated OS identity, restricted filesystem ACLs and the
   Windows Credential Manager; no broker passwords in scripts/logs.
3. Install a clean broker-provided MT5 terminal template. Configure API
   TLS, worker ID, secure token and session root. Use outbound-only worker
   connections. Do not permit blanket inbound public listeners.
4. Run `--readiness-check` and a DEMO account identity check.
5. Test lifecycle: connect/disconnect, Windows VM restart, worker crash,
   orphaned terminal cleanup, heartbeat loss, host lease expiry, durable
   SQLite mutation journal and duplicate-order avoidance.
6. Test broker execution only on **DEMO**, with explicit lot/margin bounds.
   Reconcile every ACK/UNCERTAIN order against broker transactions.
7. Only then enable `HOSTED_MT5_ENABLED=true` and register worker
   presence. UI becomes available through registry readiness, no static
   mobile feature flag or false “ready” setting.
8. Separately test LIVE canary, exact-account fencing, server Stop/Close,
   order reconciliation and documented rollback before any LIVE promotion.

## Mobile acceptance criteria

- 320px–430px Android/iOS, large text, safe-area and external keyboard.
- DEMO only; no option to switch to LIVE.
- Missing or stale hosted worker -> no credential submission/provisioning.
- Numeric account and exact broker server validation without any secret echo.
- A failed provision after a successful credential save can retry the exact
  existing owner-bound connection ID; never create a duplicate automatically.
- A 200 response to provisioning says `PAIRING`, never `ACTIVE`.
- Only server health `executionReady && connected && tradeAllowed &&
  reason === READY` with a verified heartbeat labels the terminal ready.
- A stale, missing, revoked, externally hosted or otherwise uncertain
  connector is never represented as a working hosted terminal.
- The mobile app ceases polling in the background; worker execution
  **must not** depend on the mobile app remaining open.
- Existing cTrader OAuth / other broker login flows stay unchanged.
- The server does not receive any new broker password storage location.

## References

- `docs/brokers/hosted-mt5-worker.md`
- `docs/operations/direct-mt5-live-certification.md`
- `services/mt5-connector/tests/test_host_worker.py`
- `apps/mobile/src/screens/hosted-mt5-mobile.logic.ts`
