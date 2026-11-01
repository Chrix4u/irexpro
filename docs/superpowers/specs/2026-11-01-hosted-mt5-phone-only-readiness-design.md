# Hosted MT5 Phone-Only Readiness Design

**Date:** 2026-11-01
**Status:** Product direction approved by user: normal MT5 customers, including phone-only customers, must not depend on their own Windows PC.

## Intent

iRexPro Hosted MT5 must behave like a cloud broker connection from the customer's point of view. A customer may connect an MT5 DEMO account from web/mobile, close the app, and leave their personal devices offline while iRexPro-owned execution infrastructure keeps the MT5 terminal session alive.

## Goals

- No customer-owned PC, RDP session, local MT5 installation, or connector is required for Hosted MT5.
- A dedicated iRexPro Windows execution node runs isolated MT5 terminal sessions.
- The API must advertise Hosted MT5 only when at least one authenticated worker is freshly online, runtime-ready, and has spare capacity.
- The worker must run even when it currently has zero customer assignments.
- Worker infrastructure credentials and customer MT5 passwords must never appear in argv, normal logs, browser/mobile payloads, or persisted connector config.
- Keep the existing Direct Connector as an advanced/passwordless fallback.
- Keep hosted LIVE disabled; this milestone remains DEMO-only until separate live certification.

## Non-goals

- Do not use MetaAPI or any paid third-party MT5 cloud bridge.
- Do not certify Linux/Wine for customer-money execution in this milestone.
- Do not change the cTrader/Spotware path, AI strategy, risk engine, sizing, or order policy.
- Do not auto-enable hosted execution merely because an environment variable exists.

## Approaches considered

### 1. Run hosted MT5 under Wine on the existing Linux VPS

Rejected for the production pilot. MetaQuotes supports the desktop terminal on Linux through Wine, but the Python bridge is still terminal IPC and production behavior under Wine would need a separate certification target. It also mixes desktop trading workloads into the current API/staging host.

### 2. Require every customer to run MT5/connector on Windows

Retained only as the Direct Connector fallback. It fails the phone-only requirement.

### 3. Dedicated iRexPro Windows execution worker — selected

Build a separate frozen Host Worker executable and bootstrap flow. The worker owns MT5 terminal sessions; customer devices are only control surfaces. This matches the current hosted control plane and isolates terminal failures from API/web services.

## Architecture

`Phone/Web -> iRexPro API/AI -> Hosted MT5 Worker Pool -> isolated MT5 terminal -> broker`

A worker sends a presence heartbeat independent of account assignments. Presence includes worker ID, worker version, runtime-ready state, configured capacity, and active session count. The API stores the latest presence in PostgreSQL and maintains a short-lived readiness cache. Hosted onboarding is ready only when the feature flag/worker secret are configured AND a fresh ready worker reports spare capacity.

Worker assignment leasing remains separate from presence. Presence must never contain customer credentials.

## Worker bootstrap

Ship a dedicated `iRexPro-MT5-Host-Worker.exe` in the Windows verification/release artifact. Provide a PowerShell bootstrap that:

1. validates 64-bit Windows and HTTPS API URL;
2. creates protected worker/session/template directories;
3. stores the infrastructure worker token in Windows Credential Manager via Python `keyring`, never a CLI argument;
4. writes only non-secret worker configuration to disk;
5. installs a Task Scheduler entry for the dedicated execution account;
6. runs a no-secret readiness probe;
7. starts the worker.

The bootstrap does not silently enable API rollout. Operator enablement remains explicit until real Windows DEMO UAT proves terminal lifecycle cleanup.

## Readiness truth

Hosted MT5 is customer-ready only when all are true:

- Direct MT5 adapter is registered.
- `HOSTED_MT5_ENABLED=true`.
- API worker token is configured (32+ characters).
- At least one worker presence heartbeat is fresh (<= 45 seconds).
- Worker reports `runtimeReady=true`.
- Worker reports `activeSessions < maxSessions`.

If all workers are full, onboarding must fail closed with a capacity-specific message rather than accepting another password and leaving the connection indefinitely queued.

## Failure behavior

- Worker heartbeat loss makes Hosted MT5 unavailable for new connections but does not kill already healthy child sessions.
- API restart reloads worker presence from PostgreSQL; stale rows remain informational and do not count as ready.
- A malformed worker heartbeat is rejected before DB write.
- Worker token comparison remains timing-safe.
- Presence endpoint must not lease customer work.
- Worker secrets are loaded from environment or Windows Credential Manager; CLI flags never accept the token.
- A failed assignment launch is isolated from other customer sessions.

## Verification

- API unit/schema tests for worker presence, freshness, capacity, auth and fail-closed registry behavior.
- Python tests for worker presence payload, credential-manager token loading, bootstrap/packaging contracts and no-secret argv.
- Windows GitHub runner builds and smoke-tests both Direct Connector and Host Worker executables.
- Exact-head API/web/connector regressions before PR.
- Real Windows DEMO UAT is still required before staging `HOSTED_MT5_ENABLED=true`.
