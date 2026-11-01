# Direct MT5 Always-On Hosting Design

## Intent
Make Direct MT5 suitable for unattended 24/5 operation. A user's personal PC may still host MT5, but the recommended production path is an always-on Windows VPS. iRexPro must continue to avoid broker-password storage and preserve protocol-v2 identity binding, idempotency, fail-closed behavior, and reconciliation.

## Goals
- Connector automatically starts after Windows sign-in when enabled.
- A paired connector starts execution without requiring the user to press Start after each reboot.
- Closing the desktop window hides the app to the system tray instead of stopping trading; explicit Stop and Exit remain available.
- Transient network/API/MT5 interruptions automatically reconnect with bounded exponential backoff.
- Fatal identity/token/pairing errors stop rather than retrying unsafe execution.
- iRexPro records whether the connector is intended for a PERSONAL_PC or WINDOWS_VPS and shows that in owner health.
- Onboarding clearly recommends WINDOWS_VPS for 24/5 operation and explains that a personal PC can be switched off only when MT5 is running on the VPS.
- Windows installer defaults to start-at-login and publishes a single connector binary usable on personal Windows and Windows VPS.

## Non-goals
- Automatically purchasing or provisioning a third-party VPS in this release; no VPS provider account/API has been selected for iRexPro.
- Running MetaTrader 5 itself as a Windows Service/session-0 process.
- Moving broker credentials into the iRexPro backend.

## Architecture
One connector binary supports both personal-PC and VPS deployments. The desktop process owns a supervised execution loop. Windows startup launches it in background mode after sign-in. The connector remains in the logged-in Windows user session so MetaTrader 5 can operate normally. The API persists the host mode selected during pairing and returns it in health. The browser remains the control plane; the Windows host is only the execution bridge.

## Safety
- Protocol v2 account login/server/environment matching remains mandatory.
- Connector token stays in Windows credential storage.
- Retry only transient transport/server/terminal availability failures; authentication, revoked connector, identity mismatch, protocol errors, and other explicit connector API errors remain fatal.
- Existing local command journal remains the exactly-once/reconciliation boundary across reconnects and restarts.
- Server stale-heartbeat gate remains authoritative for new exposure.

## Approaches considered
1. **Windows Service** — rejected because MetaTrader 5 commonly requires an interactive logged-in user session and service session isolation makes terminal attachment unreliable.
2. **Separate VPS connector product** — rejected because it duplicates protocol, security, packaging, and maintenance.
3. **Hybrid single connector in logged-in Windows session** — selected. Personal PCs and Windows VPSes use the same release; startup/tray/supervision make it unattended while preserving current protocol boundaries.

## Hosted VPS meaning in this release
`WINDOWS_VPS` is an execution-host profile, not a specific vendor. A customer can use any Windows VPS they control. Future managed provisioning can sit above this contract without changing the connector protocol.
