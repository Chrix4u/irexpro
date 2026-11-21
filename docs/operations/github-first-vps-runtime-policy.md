# iRexPro GitHub-first deployment and VPS storage policy

## Goal

GitHub owns source code, branches, complete version history, CI builds and reproducible release bundles. The VPS owns only runtime dependencies, the currently deployed application, one rollback release, securely stored configuration, database services, uploaded files, operational state and externally stored AI models/datasets.

## What is live today

- The iRexPro demo/staging service is currently executed from `/home/lightworld/webapps/irexpro-staging`. Its PM2 web, admin, API, AI service and a number of shadow/research workers still reference files inside that checkout.
- `staging-deploy.yml` currently invokes `deploy-staging.sh` and compiles the API, web and admin directly on the VPS. Moving to bundled runtime releases is **not complete** merely by adding a GitHub build workflow.
- The PostgreSQL server and the research model assets are separate persistent components. Never delete or overwrite these during source cleanup.
- Never switch the demo trading version to the current `main` without verifying exactly which trading feature branch and configuration are active. Avoid accidental strategy/risk changes during a storage migration.

## Phase 1: Safe cleanup (available now)

Run on the VPS (use the script from a trusted checkout or copy to a protected maintenance directory):

```bash
python3 scripts/deployment/prune-stale-worktrees.py dry-run 50 /home/lightworld/webapps/irexpro-worktrees
python3 scripts/deployment/prune-stale-worktrees.py dry-run 50 /home/lightworld/webapps/irexpro-staging/.worktrees
```

Only after reviewing results, use `apply` instead of `dry-run`.

The utility refuses to remove worktrees with uncommitted or untracked changes, unexpected ignored files, model/data files, active process references, recent directory changes, or worktree HEADs not verified in the remote branch or the locally fetched `origin/main` history. It does not delete GitHub branches. The default minimum age is 14 days. It does not touch the active staging root.

Retain the **current** `.next` and `dist` directory and at least one verified rollback. Remove old backup build directories only after source validation and live health checks.

## Phase 2: GitHub-compiled bundle (manual pilot)

The `iRexPro Runtime Bundle (GitHub Build Pilot)` workflow builds API, web and admin on an ephemeral GitHub runner and uploads a SHA-identifiable tarball with compiled output, package manifests and a SHA-256 checksum. The tarball intentionally does **not** include Git history, `node_modules`, `.env`, databases, model datasets or customer/trading records.

Download a pilot bundle and run:

```bash
bash scripts/deployment/inspect-runtime-bundle.sh irexpro-runtime-bundle.tar.gz <full-40-character-commit-SHA>
```

The bundle is **not yet sufficient for an unattended production switch**, because existing PM2 workers still execute source scripts, release dependencies may change with `pnpm-lock.yaml`, migrations run from TypeScript, and the AI runtime has independent locked Python requirements.

## Phase 3: Artifact-based deployment, before activation

1. Create an immutable SHA-named release directory from verified CI artifacts, with only the executable runtime, source scripts needed by workers, locked production dependencies and static assets.
2. Externalize `.env`, PostgreSQL, broker credentials, trading journals, quote datasets and model stores into durable directories outside releases.
3. Update PM2/web/admin/API/AI and all shadow workers to stable `current` symlinks after proving dependencies and paths work against a candidate release.
4. In a shadow/staging canary, validate database migration behavior, cTrader connections, AI readiness, demo paper mode, restart recovery, web/admin/API URLs and market-open readiness **without changing strategy admission**.
5. After success, atomically swap `current` to a candidate release and restart only required services. Keep `previous` for immediate rollback. Run smoke checks after every deploy; failure must roll back.
6. Replace the old VPS-build deployment job with the tested artifact-only job. Disable redundant deployment workflows to prevent simultaneous resets/builds.
7. Add a scheduled maintenance audit (dry-run by default). Never automatically purge live data or branches based solely on age.

Do not enable a workflow that runs unreviewed trading code merely to reclaim disk. Storage cleanup and trading strategy promotion are independent changes.
