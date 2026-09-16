# Deterministic Staging Deployment and Rollback

## Purpose

This runbook defines the repository-controlled staging release process for iRexPro. It is designed to make the deployed revision explicit, auditable, reproducible, and fail-closed.

The scripts in `scripts/deployment/` do not connect to a server by themselves. An authorized operator runs them from the existing staging checkout after separately establishing the approved administrative session.

## Release prerequisites

Before deployment, verify all of the following:

1. The candidate is a full 40-character lowercase Git commit SHA from `origin/main`.
2. The candidate PR was reviewed and all required exact-head CI/security checks passed.
3. The staging checkout has the approved `Chrix4u/irexpro` origin and a clean working tree.
4. The staging host is running the verified release baseline, currently Node.js 22.x; broad application compatibility (`node >=20`) does not replace this release preflight.
5. Required staging environment configuration already exists outside Git. Do not paste secrets into shell history, tickets, PRs, or evidence notes.
6. PM2 process names and local/public health URLs are supplied through the operator environment.
7. A previously verified rollback SHA is recorded before runtime mutation.
8. Database backup/restore and secret-rotation prerequisites from the operational security runbook are satisfied when the release requires them.

## Required configuration

The deployment script requires these environment variable names to be populated by the authorized staging environment:

- `STAGING_ROOT`
- `API_PM2_NAME`
- `WEB_PM2_NAME`
- `ADMIN_PM2_NAME`
- `LOCAL_API_LIVE_URL`
- `LOCAL_API_READY_URL`
- `LOCAL_API_HEALTH_URL`
- `LOCAL_WEB_URL`
- `LOCAL_ADMIN_URL`
- `PUBLIC_API_LIVE_URL`
- `PUBLIC_API_READY_URL`
- `PUBLIC_WEB_URL`
- `PUBLIC_ADMIN_URL`

`AI_HEALTH_URL` is optional. The deployment scripts never restart the AI service. When `AI_HEALTH_URL` is supplied, the observed health payload must explicitly identify paper mode or the deployment fails.

`ADMIN_EXPECTED_STATUSES` is optional and defaults to the auth-safe set `200,302,303,307,308,401,403`. Narrow it in the staging environment if the deployed Admin contract is stricter.

Never commit the values of these variables to the repository.

## Deploy an exact SHA

From the clean staging repository root, an authorized operator runs:

```bash
bash scripts/deployment/deploy-staging.sh <40-character-candidate-sha>
```

The script performs the following sequence:

1. validates required configuration, repository root, clean worktree, and approved origin;
2. records the current SHA as rollback evidence;
3. fetches `origin/main` and proves the immutable candidate SHA is contained in it;
4. switches to the exact detached candidate SHA and verifies it;
5. verifies the host Node.js major matches the explicit release baseline (currently 22) and the candidate `packageManager` matches the approved pnpm version;
6. installs dependencies through the repository-declared pnpm version using a frozen lockfile;
7. builds API, Web, and Admin before any runtime mutation;
8. restarts API first;
9. requires local API liveness, readiness, database/Redis readiness, and aggregate health;
10. restarts Web and Admin only after API readiness passes;
11. requires local and public smoke checks;
12. optionally observes AI health and fails unless it explicitly reports paper mode;
13. re-verifies the final Git SHA and emits a timestamped, secret-safe summary.

The script does not restart or modify the AI service.

## Failure behavior

The deployment stops immediately on install, build, restart, health, or final-SHA failure. Its error evidence includes only safe control-plane metadata:

- UTC timestamp;
- candidate SHA;
- previously checked-out SHA;
- failed stage;
- exit code.

The script deliberately does **not** perform a silent automatic rollback. A failed deployment must remain visible and the rollback action must explicitly identify both the failed and rollback SHAs.

Do not paste environment values, credentials, tokens, cookies, URLs containing secrets, or process environment dumps into release evidence.

## Explicit rollback

A rollback requires the staging checkout still to match the declared failed candidate SHA and the rollback target to be an ancestor of that candidate and contained in `origin/main`.

Before `origin/main` is fetched or trusted, the rollback script independently validates `remote.origin.url` against the approved repository provenance allowlist used by the deployment script:

- `https://github.com/Chrix4u/irexpro.git`
- `git@github.com:Chrix4u/irexpro.git`
- `ssh://git@github.com/Chrix4u/irexpro.git`

A stale-owner, lookalike, or otherwise unapproved origin fails closed during rollback preflight. No fetch, rollback-target selection, deployment-script invocation, or runtime mutation is allowed to proceed from an untrusted origin.

Run:

```bash
bash scripts/deployment/rollback-staging.sh <failed-candidate-sha> <previously-verified-rollback-sha>
```

The rollback script extracts the deployment procedure from the failed candidate, redeploys the exact rollback SHA using the same build/restart/health gates, verifies the final checkout, and emits both SHAs in its secret-safe evidence.

If rollback verification fails, keep the incident open and follow the incident-response runbook. Do not relabel the failed release as successful.

## CI safety boundary

`.github/workflows/deployment-script-safety.yml` performs only repository-local validation:

- Bash syntax validation;
- ShellCheck;
- adversarial regression tests using disposable local Git repositories and command shims.

The workflow contains no SSH step, VPS hostname, deployment credential, environment secret, or staging mutation command. It cannot deploy to the staging server.

The regression suite covers malformed/bad SHA input, dirty-worktree rejection, unexpected or stale-owner origin rejection for deployment, rollback-origin provenance rejection before rollback fetch/target trust, Node release-major mismatch before install/build/runtime mutation, package-manager contract integrity, build failure before runtime mutation, API readiness failure before Web/Admin restart, successful exact-SHA deployment, and exact-SHA rollback verification.

## Evidence to retain

For each authorized staging release, retain the following in the approved operational evidence location:

- candidate SHA;
- previous/rollback SHA;
- exact-head CI/security result reference;
- deployment UTC timestamp;
- success/failure marker and failed stage when applicable;
- rollback result if a rollback was executed;
- operator identity according to internal access-control policy.

Do not retain secrets or full environment dumps in release evidence.
