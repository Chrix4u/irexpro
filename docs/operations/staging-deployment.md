# Deterministic Staging Deployment and Rollback

## Purpose

This runbook defines the repository-controlled staging release process for iRexPro. It is designed to make the deployed revision explicit, auditable, reproducible, and fail-closed.

The preferred path is automatic CD from GitHub after an exact merged `main` SHA passes the post-merge staging release gate. The underlying `scripts/deployment/deploy-staging.sh` remains usable manually by an authorized operator for controlled recovery or diagnosis.

## Verified staging topology

- VPS host: `vps.lightworldtech.com`
- Staging checkout: `/home/lightworld/webapps/irexpro-staging`
- API PM2 process: `irexpro-api-staging`
- Web PM2 process: `irexpro-web-staging`
- Admin PM2 process: `irexpro-admin-staging`
- API upstream: `127.0.0.1:3010`
- Web upstream: `127.0.0.1:3005`
- Admin upstream: `127.0.0.1:3006`
- Public web: `https://irexpro.lightworldtech.com/login`
- Public admin: `https://irexproadmin.lightworldtech.com/`
- Public API base: `https://irexpro.lightworldtech.com/api/v1`

Health endpoints used by deployment verification:

- local live: `http://127.0.0.1:3010/api/v1/health/live`
- local ready: `http://127.0.0.1:3010/api/v1/health/ready`
- local aggregate: `http://127.0.0.1:3010/api/v1/health`
- public live: `https://irexpro.lightworldtech.com/api/v1/health/live`
- public ready: `https://irexpro.lightworldtech.com/api/v1/health/ready`
- private AI health: `http://127.0.0.1:8011/api/v1/health`

The public readiness controller deliberately exposes only `{status}`. Internally, `HealthService.readiness()` returns `ready` only when both PostgreSQL and Redis probes succeed. Deployment therefore validates `status=ready` instead of requiring internal dependency fields to be publicly exposed.

## Automatic CD flow

The automatic staging release chain is:

1. Pull request exact-head CI/security gates pass.
2. The PR is merged into `main`.
3. `.github/workflows/main-staging-release-gate.yml` runs on the exact merged SHA.
4. `scripts/deployment/main-staging-release-gate.mjs` compares the previous `main` SHA with the new SHA, derives the applicable required push workflows, waits for those exact-SHA runs, and fails if the candidate is no longer current `main`.
5. A successful `Main Staging Release Gate` triggers `.github/workflows/staging-deploy.yml`.
6. The deploy workflow checks out the authorized SHA, proves it is still exact `origin/main`, opens a pinned-host SSH session to the staging VPS, and invokes `deploy-staging.sh` with that immutable SHA.
7. The server builds API, Web, and Admin before runtime mutation, restarts API first, verifies liveness/readiness/aggregate health, then restarts Web/Admin and performs local/public smoke checks.
8. Automatic staging CD queries the private AI health endpoint and fails closed unless the payload explicitly proves paper mode (`paper`, `paper-only`, or boolean paper-mode true). The AI service remains private and is not restarted by this workflow.

Deployment concurrency is serialized. An older release is not allowed to race a newer `main` SHA.

## GitHub configuration required once

Create or use the GitHub Environment named `staging` for the deployment secrets. Do not store application `.env` contents in GitHub unless separately required; the application runtime configuration remains on the VPS.

Repository variables:

- `STAGING_CD_ENABLED` — set to `true` only after the SSH setup below is complete.
- `STAGING_SSH_USER` — dedicated or approved VPS user that owns/can operate the staging checkout and the three staging PM2 processes.
- `STAGING_SSH_PORT` — optional; defaults to `22` when absent.

`staging` Environment secrets:

- `STAGING_SSH_PRIVATE_KEY` — private half of the dedicated GitHub CD SSH key.
- `STAGING_SSH_KNOWN_HOSTS` — trusted `known_hosts` line(s) for `vps.lightworldtech.com`; do not replace this with opportunistic `ssh-keyscan` inside the workflow.

The private key, passwords, database credentials, broker credentials, tokens, cookies, and `.env` contents must never be committed or pasted into PRs/logs.

## VPS SSH account requirements

The SSH account used by GitHub Actions must be narrowly scoped. It needs to:

- authenticate using the dedicated public key;
- access `/home/lightworld/webapps/irexpro-staging`;
- fetch the public `Chrix4u/irexpro` origin;
- run Node.js 22 and Corepack/pnpm 10.34.5;
- run the existing PM2 processes `irexpro-api-staging`, `irexpro-web-staging`, and `irexpro-admin-staging`;
- read the existing staging runtime environment files required by those processes.

It should not receive unrelated root, database-administrator, or production-host privileges.

After the GitHub variables/secrets are configured, set `STAGING_CD_ENABLED=true`. If the current `main` SHA should be deployed immediately without another code merge, manually dispatch **Main Staging Release Gate** on the `main` branch. Its normal exact-main checks still apply, and a successful run will trigger the same staging deploy workflow.

## Release prerequisites

Before any deployment, verify all of the following:

1. The candidate is a full 40-character lowercase Git commit SHA from current `origin/main`.
2. Required exact-SHA CI/security checks passed.
3. The staging checkout has one of the approved `Chrix4u/irexpro` origins and a clean working tree.
4. The staging host is running the verified release baseline, currently Node.js 22.x.
5. Required staging application configuration already exists outside Git.
6. A previously verified rollback SHA is known before runtime mutation.
7. Database backup/restore and secret-rotation prerequisites from the operational security runbook are satisfied when the release requires them.

## Deployment script configuration

`deploy-staging.sh` requires:

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

The GitHub staging deployment workflow supplies these non-secret values explicitly for the verified staging topology above.

`AI_HEALTH_URL` is optional for manual operators, but automatic CD pins it to `http://127.0.0.1:8011/api/v1/health`. The deployment scripts never restart the AI service. When supplied, its observed payload must explicitly identify paper mode or the deployment fails. This keeps staging/UAT trading verification fail-closed without exposing the AI service publicly.

`ADMIN_EXPECTED_STATUSES` defaults to `200,302,303,307,308,401,403`.

## Manual exact-SHA deployment

From the clean staging repository root, an authorized operator may run:

```bash
bash scripts/deployment/deploy-staging.sh <40-character-candidate-sha>
```

The script:

1. validates required configuration, repository root, clean worktree, and approved origin;
2. records the current SHA as rollback evidence;
3. fetches `origin/main` and proves the candidate is contained in it;
4. switches to the exact detached SHA;
5. verifies Node.js 22 and the approved pnpm version;
6. installs from the frozen lockfile;
7. builds API, Web, and Admin before runtime mutation;
8. restarts API first;
9. requires API liveness, dependency-backed readiness, and aggregate health;
10. restarts Web and Admin only after API readiness passes;
11. requires local and public smoke checks;
12. requires AI paper-mode proof when `AI_HEALTH_URL` is supplied (automatic CD always supplies it);
13. re-verifies the final Git SHA and emits timestamped secret-safe evidence.

## Failure behavior

The deployment stops immediately on install, build, restart, health, or final-SHA failure. Failure evidence contains only safe control-plane metadata: UTC timestamp, candidate SHA, previous SHA, failed stage, and exit code.

The workflow does not silently auto-rollback. Failed releases remain visible and rollback must explicitly identify the failed and rollback SHAs.

## Explicit rollback

A rollback requires the checkout still to match the declared failed candidate SHA and the rollback target to be an ancestor of that candidate and contained in the approved `origin/main` history.

```bash
bash scripts/deployment/rollback-staging.sh <failed-candidate-sha> <previously-verified-rollback-sha>
```

Before any rollback fetch or target trust, the rollback script verifies that `remote.origin.url` is exactly one of:

- `https://github.com/Chrix4u/irexpro.git`
- `git@github.com:Chrix4u/irexpro.git`
- `ssh://git@github.com/Chrix4u/irexpro.git`

Stale-owner, lookalike, or otherwise unapproved origins fail closed during rollback preflight.

## CI safety boundary

`.github/workflows/deployment-script-safety.yml` performs repository-local validation only. It runs Bash syntax validation, ShellCheck, deployment/rollback adversarial tests, the public-health-contract test, and the exact-main release-gate self-test.

The safety workflow itself has no SSH credentials and cannot mutate the VPS.

The actual `.github/workflows/staging-deploy.yml` obtains SSH credentials only through the protected GitHub `staging` Environment and only after the exact-main staging release gate succeeds and `STAGING_CD_ENABLED=true`.

## Evidence to retain

For each staging release retain:

- authorized candidate SHA;
- previous/rollback SHA;
- exact-main release-gate result;
- applicable CI/security result references;
- deployment UTC timestamp;
- success/failure marker and failed stage when applicable;
- rollback result when executed;
- operator/service identity according to internal access-control policy.

Never retain private keys, passwords, tokens, application secrets, broker credentials, or full environment dumps in release evidence.
