# iRexPro Hosted MetaTrader 5 Worker

## Purpose

iRexPro Hosted MT5 lets a customer connect a MetaTrader 5 DEMO account once and then use iRexPro from web or phone while the execution terminal runs on iRexPro-owned Windows infrastructure. The initial hosted pilot is DEMO-only. LIVE accounts remain fail-closed until the hosted worker has its own production-LIVE certification evidence.

The hosted worker reuses the existing Direct MT5 command and reconciliation protocol. It does not introduce a second order engine and it does not change the cTrader execution path.

## Initial certified target

The first production target is Windows. `irexpro-mt5-host-worker` refuses to start on non-Windows platforms. Linux/Wine is a future certification target and must not be represented as production-supported until the MetaTrader terminal, MetaQuotes Python bridge, restart behavior and reconciliation suite have been proven there.

Use a dedicated, patched Windows Server/Windows VM account for the worker. For the pilot, run it in a persistent signed-in Windows session (for example via Task Scheduler at logon) because MT5 is a desktop terminal. Disconnecting an RDP session is acceptable; signing the worker account out stops that desktop session. Do not enable insecure automatic logon merely to keep the worker alive.

## Host prerequisites

- 64-bit Windows with current security updates.
- Python version supported by the connector package.
- `irexpro-mt5-connector` installed with its Windows dependencies, including the official MetaQuotes `MetaTrader5` package.
- A clean broker MT5 template directory containing `terminal64.exe` and the broker-specific terminal files.
- A dedicated writable session root on local NTFS storage. Do not place the session root on a shared user profile or cloud-synchronised directory.
- HTTPS access to the iRexPro API. Plain HTTP is accepted only for the true loopback hosts `localhost`, `127.0.0.1`, or `::1` during development.
- Reliable DNS and time synchronisation.

## Clean MT5 template

Prepare one clean terminal template per broker/build where necessary. The template is copied into a connector-specific session directory before a customer assignment starts. The worker launches that copied terminal in MT5 portable mode so one hosted account cannot reuse another account's terminal profile.

The template must contain the configured terminal path, which defaults to `terminal64.exe`. Do not pre-populate the template with a customer's account password, connector token, or iRexPro worker token.

When upgrading a broker terminal, validate a new clean template first. Do not replace a template underneath already-running sessions.

## Configuration

The worker reads these values from environment/configuration:

| Setting | Purpose | Default |
| --- | --- | --- |
| `IREXPRO_API_URL` | iRexPro API base URL, normally `https://<host>/api/v1` | none |
| `HOSTED_MT5_WORKER_ID` | Stable infrastructure worker identity | none |
| `HOSTED_MT5_WORKER_TOKEN` | 32+ character infrastructure bearer secret | none |
| `HOSTED_MT5_TEMPLATE_DIR` | Clean MT5 template directory | none |
| `HOSTED_MT5_SESSION_ROOT` | Per-account session root | none |
| `HOSTED_MT5_MAX_SESSIONS` | Maximum concurrent MT5 children on this worker | `4` |
| `HOSTED_MT5_HEARTBEAT_SECONDS` | Worker assignment lease renewal interval | `20` |
| `HOSTED_MT5_POLL_SECONDS` | Supervisor polling interval | `2` |
| `HOSTED_MT5_TERMINAL_RELATIVE_PATH` | Terminal path inside each template/session | `terminal64.exe` |

`HOSTED_MT5_WORKER_TOKEN` is intentionally not accepted as a command-line flag. Supply it to the process through the protected runtime environment or the Windows service/scheduled-task secret configuration. Do not place it in a shortcut, command history, process arguments, repository file, or log.

## No-secret readiness check

The readiness command checks Windows, the clean MT5 terminal, write access to the session root and iRexPro API liveness. It does not require the worker token, does not lease an account and does not read customer credentials.

```powershell
irexpro-mt5-host-worker --readiness-check `
  --server-url "https://irexpro.lightworldtech.com/api/v1" `
  --mt5-template-dir "D:\iRexPro\mt5-template" `
  --session-root "D:\iRexPro\mt5-sessions"
```

A successful probe returns JSON containing `"status": "READY"`, `apiReachable`, `terminalPresent`, and `sessionRootWritable` set to `true`.

## Starting the worker

After the readiness check passes and the worker token has been supplied securely to the process environment, start:

```powershell
irexpro-mt5-host-worker `
  --server-url "https://irexpro.lightworldtech.com/api/v1" `
  --worker-id "mt5-win-01" `
  --mt5-template-dir "D:\iRexPro\mt5-template" `
  --session-root "D:\iRexPro\mt5-sessions" `
  --max-sessions 4
```

For the pilot, register this command with Task Scheduler under the dedicated Windows worker account and trigger it at that account's logon. Configure restart-on-failure and prevent concurrent duplicate supervisor instances on the same worker identity.

## Credential handling rules

The user submits MT5 login, broker server and trading password through the authenticated iRexPro onboarding flow. The API encrypts the credential bundle with AES-256-GCM at rest. A hosted worker receives the decrypted password only after an authenticated infrastructure lease is granted.

The assignment travels to the per-account child through inherited stdin, not command-line arguments. The child stores only non-secret connector configuration on disk. The connector token is held in an in-memory secret store and the trading password remains in process memory for the MT5 session. The worker removes infrastructure secrets such as `HOSTED_MT5_WORKER_TOKEN`, `BROKER_ENCRYPTION_KEY`, `DIRECT_MT5_CONNECTOR_PEPPER`, and `METAAPI_TOKEN` from the child environment.

Never log assignment bodies, passwords, connector tokens, worker tokens, encrypted credential fields, Authorization headers or decrypted credentials. Error reporting must use bounded codes such as `SESSION_LAUNCH_FAILED` or `SESSION_EXITED:<code>`.

## Session and journal storage

Each connector receives its own directory under `HOSTED_MT5_SESSION_ROOT`. The directory contains the copied MT5 portable terminal, `connector.json` and `journal.sqlite3`. `connector.json` contains no trading password and no connector token. The SQLite WAL journal is the exactly-once boundary for broker mutations and must survive child-process restarts.

Protect the session root with Windows ACLs so only the dedicated worker account and administrators can read it. Do not publish or back it up to user-accessible storage. Retention/cleanup of revoked or permanently decommissioned sessions should be an explicit operator action after reconciliation, not an automatic deletion during worker startup.

## Network policy

The worker requires outbound access to:

- TCP 443 for the iRexPro API.
- The broker/MetaTrader endpoints required by that broker's terminal.
- DNS and time-synchronisation services required by the Windows host.

No inbound Internet listener is required by the hosted worker. Prefer a deny-by-default inbound firewall policy. Restrict outbound traffic to approved destinations where the broker infrastructure permits it.

## Failure and restart behaviour

The supervisor renews the server-side worker lease while a child is running. The child independently sends Direct MT5 connector heartbeats. A stale connector heartbeat fails closed for new exposure.

If a child exits, the worker reports only a bounded exit code and frees capacity. If the worker loses the control plane, the lease expires rather than granting permanent ownership. If the connector loses the API or MT5 temporarily, the existing supervised connector retry/backoff and durable journal are reused. A broker-successful mutation recorded as `SUCCEEDED` is never relabelled `FAILED` merely because result reporting later loses the network.

Re-provisioning an already healthy hosted connection is idempotent: iRexPro returns the current active hosted connector rather than replacing it. If the session is stale, the server may create/reassign hosted ownership using the lease fencing rules.

## Capacity and rollout

Start the pilot with a conservative `HOSTED_MT5_MAX_SESSIONS` and measure per-terminal CPU, working set, disk IO and broker connectivity before increasing density. Scale horizontally with additional Windows workers rather than assuming one VM can safely host an arbitrary number of MT5 terminals.

Before enabling customer LIVE accounts, complete a separate hosted-LIVE certification covering real broker identity, canary exposure, restart/takeover, stale-lease fencing, exactly-once mutation recovery, kill-switch behavior and post-trade reconciliation. The existing hosted code intentionally rejects LIVE provisioning until that evidence exists.
