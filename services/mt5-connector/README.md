# iRexPro Direct MetaTrader 5 Connector

This Windows connector links an already logged-in MetaTrader 5 desktop terminal directly to iRexPro. It does **not** use MetaApi and it never asks iRexPro to store the user's broker/MT5 password.

## End-user flow

1. Install the broker's MetaTrader 5 desktop terminal on a Windows PC or Windows VPS.
2. Log into the MT5 account normally inside MetaTrader 5 and leave the terminal running.
3. In iRexPro choose **MetaTrader 5 · Direct Connector** and select **Generate pairing code**.
4. Launch the iRexPro MT5 Connector on the same Windows machine and enter the pairing code.
5. The connector reads the currently logged-in MT5 account login, broker server and MT5-reported account environment (DEMO or REAL/LIVE) from the local terminal. iRexPro binds the pairing to that exact login/server/environment.
6. The one-time pairing code is exchanged for a revocable connector token. The token is stored in the Windows credential vault; it is not written to the JSON config.
7. Run the connector continuously (later installer: Windows startup/service). It makes outbound HTTPS calls to iRexPro for heartbeat, command lease, and results. No inbound firewall port or router port-forward is needed.

If the user switches the local MT5 terminal to another account/server/environment, the connector fails closed and iRexPro suspends that binding until it is paired again. A connector whose heartbeat is stale is treated as disconnected for new exposure, but it can recover automatically when fresh heartbeats resume. The user can also revoke the connector from iRexPro; revocation invalidates its token, cancels queued commands, and marks already-leased commands uncertain for reconciliation rather than replaying them.

## Windows desktop installer

For end users, use the Windows installer published from tags named `mt5-connector-v*`. The release contains:

- `iRexPro-MT5-Connector-Setup.exe` — normal Windows installer with Start-menu shortcut.
- `iRexPro-MT5-Connector-Portable.exe` — standalone executable.
- `SHA256SUMS.txt` — SHA-256 integrity hashes for both binaries.

The desktop app defaults to `https://irexpro.lightworldtech.com/api/v1`, accepts the pairing code shown by iRexPro, stores the connector token in the Windows credential vault, and provides Start/Stop controls. A protocol-v1 configuration does not get guessed or migrated silently: install the current connector and generate a new pairing code.

Current builds are unsigned until the Lightworld Windows code-signing certificate is provisioned in the release pipeline, so Windows SmartScreen may display a publisher warning. Verify the SHA-256 hash against the release file before installing.

## Development installation

Requires Python 3.10+ on Windows and an installed MetaTrader 5 terminal.

```powershell
py -3.11 -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -e .
```

Pair the terminal:

```powershell
irexpro-mt5-connector pair `
  --server-url https://irexpro.lightworldtech.com/api/v1 `
  --pairing-code ABCDEFGH23
```

Run the connector:

```powershell
irexpro-mt5-connector run
```

## Exactly-once execution guard

Every iRexPro command has a command id plus an idempotency key. Before an MT5 mutation is attempted, the command is written to a local SQLite WAL journal as `EXECUTING`. If the process or Windows machine dies before a result is durably recorded, restart converts that command to `UNCERTAIN`; it is **not** automatically re-executed. iRexPro must reconcile MT5 provider state before deciding what happened.

## Current scope

The native connector now covers pairing, heartbeat, protocol-v2 login/server/environment fencing, account snapshots, symbol metadata, current prices, OHLCV candles, margin calculation, positions, working-order state, historical order lookup, closed-trade reconciliation, market entry, protective SL/TP modification, single-position close and close-all. Mutating commands retain the local exactly-once journal.

DEMO is available after normal pairing. The code path is also LIVE-capable, but production LIVE is deliberately **not self-authorizing**: the broker catalog remains `productionLiveVerification=UNVERIFIED` until an authorized operator runs the real-money Direct MT5 certification canary, persists its sanitized evidence artifact, and explicitly records that attestation. A LIVE heartbeat alone can never activate LIVE trading.
