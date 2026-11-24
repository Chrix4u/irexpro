# Pepperstone LIVE: isolate post-release entry decisions

## Why

The certified LIVE route-parity fix shipped at 2026-11-24 08:48:22Z
(commit 9c887407). The original 30-minute entry audit mixed
a PRE-release 08:23 USDJPY BROKER_NATIVE/SIGNAL_INVALID record
with newer model decisions, making it look like the fixed downstream
orchestrator was still rejecting LIVE signals.

## Read-only verification

From the VPS:

    cd /home/lightworld/webapps/irexpro-staging/apps/api
    node scripts/validation/pepperstone-live-entry-gates-ro.cjs --since=2026-11-24T08:48:22Z

The source-only enhancement requires full, explicit UTC ISO timestamps,
refuses future or more than 2-hour-old time windows, rejects unrecognized
arguments, and refuses to report truncated decision windows.
SQL is parameterized and scoped to the configured owner's unique
Pepperstone LIVE connection inside a READ ONLY transaction.

Use primaryModelAuthorityGranted to count only the exact upstream
multimodelAuthority.authorityPath=PRIMARY_PLAN_B decisions, not
merely two route labels present in the same decision. Separately show
the explicitly approved reversal timing handoffs and persisted
BROKER_NATIVE authority; use outcomes to distinguish SIGNAL_INVALID,
risk rejection and execution success.

Caution: primaryReversalTimingBridges is descriptive, based on the
upstream persisted PRIMARY_PLAN_B verdict plus reversal and M1
route, not a substitute for server-side current expert proof.
The final broker gate still independently verifies source,
identity, account mode, certification and LIVE eligibility.

The preserved last30Minutes output key remains for existing users,
but decisionWindowSince identifies the actual lower bound whenever
the optional --since argument is provided.

## Initial live observation

As of 2026-11-24 08:56:44Z, 64 M1 decisions occurred after the release,
8 Plan-B admitted and 6 contained an M1 tactical route. Zero
received persisted primary model or broker dispatch authority, and
zero LIVE orders were recorded. No post-release SIGNAL_INVALID outcomes.

This is not evidence that the LIVE dispatch was exercised after the
fix. It shows the previously observed categorical rejection has not
recurred in the observation window, but only because no subsequent
qualified order was sent. The 08:23 pre-release signal must not be
used to label current activity as failing.

This script makes no writes, broker requests, restarts or configuration
changes. All change impact is operator diagnostics only.
