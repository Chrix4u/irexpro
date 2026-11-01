# iRexPro Hosted MT5 Execution Design

**Date:** 2026-11-01
**Status:** Approved by product direction (“no MetaAPI; MT5 should behave like cTrader from the user's point of view”)

## Goal

Give MetaTrader 5 users the same operational experience iRexPro provides through Spotware Open API: connect once, start AI trading, then close the phone/browser/PC while iRexPro continues running. The implementation must not depend on MetaAPI and must not require the customer's Windows machine to stay online.

MT5 still requires a terminal process. iRexPro therefore owns and supervises that terminal process on dedicated execution-worker infrastructure rather than on the customer's computer.

## Non-goals

- Do not change the cTrader/Spotware execution path.
- Do not remove the existing Direct MT5 personal-PC/Windows-VPS connector; it remains the privacy-first fallback.
- Do not enable iRexPro-hosted LIVE trading in the first release.
- Do not install Wine/MT5 into the API/web staging VPS. Execution workers are an isolated infrastructure role.
- Do not claim a universal broker login has been proved until a real DEMO account completes end-to-end UAT.

## Architecture decision

Reuse the existing `direct-mt5` adapter, command queue, heartbeat identity fence, idempotent command protocol, and reconciliation behavior. Add a third execution-host mode:

- `PERSONAL_PC` — customer-owned Windows PC.
- `WINDOWS_VPS` — customer-owned Windows VPS.
- `IREXPRO_HOSTED` — iRexPro-owned execution worker; customer device can be off.

The API remains the durable control plane. A separate iRexPro worker is the MT5 data plane.

```text
AI / risk / execution engine
           |
     Direct MT5 command queue
           |
     iRexPro API (control plane)
           |
       HTTPS + worker auth
           |
 iRexPro MT5 execution worker
           |
 isolated portable MT5 terminal
           |
        MT5 broker
```

The first worker implementation targets Windows, because the current connector and MetaQuotes Python integration are already verified there. The worker contract is OS-neutral so a Linux/Wine worker can be added later. MetaQuotes officially supports running the MT5 terminal on Linux through Wine, but the production worker must be proved separately before replacing the Windows worker.

## Credential boundary

Hosted mode necessarily differs from the passwordless Direct Connector: iRexPro must be able to log its own terminal into the user's MT5 account.

1. The onboarding API accepts the MT5 trading password only as a write-only input.
2. It is stored only inside the existing AES-256-GCM broker credential bundle; no plaintext password column is introduced.
3. It is never returned to the customer UI after submission and never written to logs, connector settings, journal files, or command payloads.
4. A trusted execution worker receives the decrypted password only when it holds a short worker lease, over HTTPS, authenticated by an infrastructure worker token.
5. The worker keeps the password in process memory while its terminal session is alive. Connector token and trading password are not written into the session JSON file.
6. Hosted LIVE stays blocked until worker authentication is upgraded/certified for LIVE (for example per-worker credentials/mTLS or equivalent) and full live certification passes.

## Provisioning flow

### Customer/API

The web onboarding makes **iRexPro Hosted — Recommended** the default MT5 connection method. The customer provides:

- MT5 account/login number;
- exact broker server name;
- MT5 trading password;
- DEMO/LIVE selection (LIVE shown as unavailable for hosted pilot).

The frontend first creates a normal `direct-mt5` BrokerConnection so the existing credential encryption and logical-account uniqueness machinery is reused. It then calls the hosted-provision endpoint for that exact connection.

Hosted provisioning validates:

- the connection belongs to the caller;
- `broker_id = direct-mt5`;
- environment is `DEMO` for the pilot;
- encrypted credentials exist and contain a non-empty trading password and broker server;
- account login is numeric.

It then creates/resets the Direct MT5 connector row as `host_mode=IREXPRO_HOSTED`, expected login/server bound, `state=PAIRING`, no connector token, no heartbeat, no trading authority, and broker connection status `CONNECTING`.

Provisioning is idempotent for the same connection while no valid hosted session is active.

### Worker lease

A worker calls an infrastructure-only assignment endpoint with:

- bearer `HOSTED_MT5_WORKER_TOKEN`;
- a non-secret stable `workerId`.

The API atomically claims one eligible hosted connector using a lease. A claim is allowed for a new `PAIRING` row or for an `ACTIVE` hosted connector whose connector heartbeat is stale **and** whose worker lease has expired. A healthy worker lease prevents duplicate terminal ownership.

On claim the API:

- cancels not-yet-dispatched commands;
- marks leased mutation commands `UNCERTAIN` rather than replaying them;
- rotates the connector token;
- binds the lease owner/expiry;
- decrypts the stored broker credentials only after the claim succeeds;
- returns the assignment, including MT5 password and connector token, only to the authenticated worker.

The raw connector token is never persisted server-side; only its HMAC digest is stored, as today.

### Worker/session

For every assignment, the worker creates an isolated portable terminal directory from an operator-provided clean MT5 template. It launches a dedicated child process for that account. The child:

1. initializes MT5 using explicit `path + login + password + server + portable=true`;
2. verifies observed login, server, account type and trade permission;
3. runs the existing Direct MT5 heartbeat/lease/result loop using an in-memory connector-token store;
4. keeps the existing SQLite WAL command journal per hosted session;
5. exits fail-closed on identity/authentication changes.

The worker supervisor periodically renews the infrastructure lease. If the worker disappears, the lease expires; after connector heartbeat is also stale, another worker may reclaim the session with a rotated connector token.

## State and failover

Additional columns on `broker.direct_mt5_connectors` are sufficient; a second session table is intentionally avoided:

- `host_worker_id varchar(128) NULL`
- `host_lease_expires_at timestamptz NULL`
- `host_last_seen_at timestamptz NULL`
- `host_last_error text NULL` (sanitized, no secrets)

`host_mode` remains the discriminator.

Hosted lifecycle:

`PAIRING -> ACTIVE/no heartbeat -> ACTIVE/READY`

Failures:

- wrong login/server/environment => connector `SUSPENDED`, no trading;
- stale connector heartbeat => no new command lease;
- worker lease alive but terminal stale => do not double-host; worker is expected to recover child;
- worker lease expired + connector stale => safe reclaim with token rotation and uncertain-command protection;
- revoke => connector `REVOKED`, token cleared, pending commands cancelled, leased mutations uncertain.

## API surface

Customer-authenticated:

- `POST /broker/direct-mt5/hosted/:brokerConnectionId/provision`
- existing `GET /broker/direct-mt5/pairings/:brokerConnectionId/health`
- existing revoke endpoint

Infrastructure-only:

- `POST /broker/direct-mt5/hosted-worker/assignments/lease`
- `POST /broker/direct-mt5/hosted-worker/assignments/:connectorId/heartbeat`

The worker endpoints are `@Public` only with respect to end-user JWT; they require their own constant-time checked infrastructure bearer token and fail closed if `HOSTED_MT5_WORKER_TOKEN` is absent or shorter than 32 characters.

## UX

MetaTrader onboarding should no longer promote MetaAPI. Existing legacy MetaAPI connections remain operable in the backend, but new users see one MetaTrader 5 choice with methods:

1. **iRexPro Hosted — Recommended** — “Your computer can be off.”
2. **Direct Connector — My Windows PC** — passwordless; PC must stay on.
3. **Direct Connector — My Windows VPS** — passwordless; VPS must stay on.

Hosted status explicitly shows `Provisioning`, `Starting MT5`, `Ready`, or fail-closed health reason. Password inputs are cleared after submission.

## Pilot gates before hosted LIVE

Hosted LIVE remains disabled until all of these have durable evidence:

1. Real DEMO login on an iRexPro-owned worker.
2. Account identity and environment match.
3. Fresh quotes/OHLCV.
4. Place, observe, modify and close a small DEMO order.
5. Worker restart restores the session without duplicate mutation.
6. API/reporting outage preserves a broker-successful command as succeeded/uncertain, never false-failed.
7. Stale heartbeat blocks exposure.
8. Worker failover does not create two active terminal owners.
9. Credential/log scan confirms no plaintext password/token persistence.
10. Resource/capacity test establishes a safe per-worker terminal limit.
11. Production worker authentication and secret delivery are approved for LIVE.
12. Existing Direct MT5 live-certification gates are rerun for hosted mode.
