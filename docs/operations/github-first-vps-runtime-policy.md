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

## Phase 3a: Isolated source-light canary (implementation on ops branch)

`iRexPro Isolated Standalone Runtime Canary` is a second, opt-in
GitHub Actions workflow. It checks out the **exact existing demo trading
commit** and applies reviewed Next.js *standalone output configuration*
inside the ephemeral CI checkout only. GitHub builds compiled Nest API,
Next web and admin, then packages:

- `api/`: compiled Nest output and production Node dependencies via pnpm deploy;
- `web/` and `admin/`: standalone Node servers and traced dependencies,
  with copied static assets;
- `apps/api/scripts`: the Node shadow-worker sources with production
  dependency pointers, preserving required original workspace-relative paths;
- `services/ai-engine/`: Python AI application and worker scripts plus the
  hash-locked dependency manifest, but **not** the 1.3 GB environment;
- `meta/`: full source commit SHA, tooling commit SHA, and runtime scope.

The artifact must pass the SHA-256 checksum and the link/path/required-file
validation. This is a **source-light runtime**, not a full iRexPro release:
the installed Python virtual environment (~1.3 GB), running shadow
research workers, model datasets, broker credentials and database state
deliberately remain outside the replaceable release artifact.

To verify the exact GitHub Actions artifact on the VPS without changing
public services:

```bash
# Download the verified GitHub Actions artifact and checksum into a private
# temporary folder first (name shown in the successful workflow run).
sha=652a9858deedcfee1b0240a98440f109000aec3b
bash scripts/deployment/stage-standalone-canary.sh \
  /path/to/irexpro-standalone-runtime.tar.gz \
  /path/to/irexpro-standalone-runtime.tar.gz.sha256 \
  "$sha"
```

This only starts the web/admin standalone processes on loopback TCP 4305 and
4306, checks login/admin pages and web static assets, and terminates those
canary processes. It **never starts a second Nest trading API**, never
modifies PM2 or Nginx, and never changes the active trading commit.

After the source-light canary succeeds, only an explicitly tested release
orchestrator should modify `current` / `previous` symlinks. All live
workers must use stable externalized env/data/model mounts; API migrations
and Python AI dependencies must be validated; live release and rollback
health must be tested. Keep a separate model/venv version policy to avoid
cloning 1.3 GB of Python dependencies per app release.

**Do not merge the ops branch into `main` automatically:** the existing
main staging deployment job still rebuilds applications on the VPS.
Changing the default workflow requires a separately tested migration.

### Cutover hold and preflight

Before moving PM2 paths or deleting the legacy checkout, inspect the
candidate with the **read-only** command:

```bash
python3 scripts/deployment/preflight-artifact-cutover.py \
  /home/lightworld/runtime/irexpro/candidates/<verified-candidate>
```

This verifies entrypoints, all 19 worker script paths, existing core PM2
health, native API modules, and externalized environment/AI/state stores.
It deliberately returns **HOLD** until the old VPS-build workflow is
replaced and broker positions can be reconciled before restarting the
trading scheduler. Never launch a second API/AI scheduler against the demo
broker as a cutover test. The existing live PM2 deployment remains
authoritative until rollback and restart-safe state handling are proven.

## Phase 3b: Protected shared runtime preparation (completed 2026-11-21)

A candidate for the exact active trading commit now exists outside source history
under `/home/lightworld/runtime/irexpro/candidates/`. The VPS maintains:

- `shared/env/api.env` and `shared/env/ai.env` with owner-only 0600
  permissions; copies are byte-verified against active credentials.
- `shared/python/ai-venv`, one independent copy of the existing Python
  environment, not another 1.3 GB copy per application deployment.
- `shared/var`, an **initial snapshot** of runtime audit state. It is not yet
  authoritative: live writers still use the legacy staging source directory.

The candidate contains only symlinks to these shared paths. Its source code
and Node production dependencies come solely from the GitHub-built release.
The current PM2 processes, their environment files, database, brokers, and
the original Python environment are still unchanged.

To fetch the tested build directly from GitHub, using an authenticated GitHub
CLI on the VPS, with no VPS-side compilation:

```bash
bash scripts/deployment/stage-from-github-actions.sh \
  44897767105 \
  652a9858deedcfee1b0240a98440f109000aec3b
```

This validates the exact GitHub Actions run, its successful conclusion,
authorized builder branch, embedded source SHA, tarball checksum, unsafe
archive links, compiled entrypoints, Node dependencies and web/admin canary.
If an identical artifact has already been staged, it is reused rather than
duplicated. It then binds the protected shared paths, performs a read-only
cutover preflight, and explicitly refuses to change running services.

The 2026-11-21 proof: 15 of 18 cutover checks passed; three blocking
conditions remain:

1. The active operational-state writers must be stopped/reconciled and
   the final `var` delta migrated before they can be switched to shared
   state. Snapshot consistency is **not** live-writer consistency.
2. The previous GitHub `Staging Deploy` workflow still fetches source and
   runs builds on the VPS. Disable and replace it only after a tested
   artifact-only production promotion with atomic rollback is ready.
3. Broker open positions, order reconciliation and idempotent scheduler
   restart must be explicitly verified before moving active API, AI and
   shadow workers. Do not start two broker-connected execution engines.

The core active trading commit stays `652a9858`, and 23 of 23 PM2
processes were online at last observation. The extra shared Python copy
temporarily uses ~1.3 GB until the legacy source environment can be retired
after a successful cutover. Do **not** delete it prematurely.

### Broker/order reconciliation gate (read-only, 2026-11-21)

Run the new cutover audit with the verified candidate API folder:

```bash
node scripts/deployment/readonly-broker-cutover-audit.cjs \
  /home/lightworld/runtime/irexpro/candidates/<release-identity>/api
```

This opens a PostgreSQL **read-only transaction**, prints aggregate counts
and closes it. It sends **no broker orders**, changes **no order status** and
does **not** expose credentials or account identifiers.

The 2026-11-21 snapshot of the active staging database found 1,014 CLOSED
trade-ledger rows and zero unclosed trade-ledger rows, but 375 orders with
`RECONCILIATION_PENDING` and one `ACKNOWLEDGED`. Of the 375 pending rows,
70 had been updated since 2026-11-20. No rows existed in
`broker_reconciliation.broker_trade_reconciliation_runs`. These counts alone
cannot prove the provider has an open position or that any particular order
was filled. A successful live broker-side check and matching provider state
are still required. The new gate therefore fails closed rather than claiming
the broker is flat.

With this independent ledger check included, the currently staged
candidate passes **15 of 19** cutover checks. The four unresolved conditions
are (a) order/ledger reconciliation, (b) live operational-state writer
cutover, (c) retiring the old VPS-build deployment workflow after testing
the replacement, and (d) independent broker position/restart verification.

### Correct demo account reconciliation sources (2026-11-21 audit refinement)

The `broker_reconciliation.broker_trade_reconciliation_runs` table tracks
the LIVE account trade-history reconciliation endpoint and must **not** be
treated as evidence that an automated DEMO state sweep never ran. The
authoritative scheduled broker-state reconciliation history is in
`reconciliation.runs`, with open mismatches in
`reconciliation.discrepancies`.

The read-only audit now joins unresolved orders to broker account mode and
provider, and checks the most recent state sweep for each affected connection.
On November 21, the result was:

- All **376** unresolved order rows are DEMO, associated with two broker
  connections (249 Pepperstone cTrader pending, 126 cTrader pending and one
  cTrader acknowledged).
- All 376 have linked `CLOSED` trade records, but none has a provider order
  reference recorded on the order row. This is not proof of broker settlement.
- **718** OPEN warning-level reconciliation discrepancies:
  **660 UNRESOLVED_EXECUTION_RESULT** and
  **58 POSITION_CLOSED_EXTERNALLY**, distributed over the two demo connections.
- The latest periodic automated state reconciliation runs were
  `COMPLETED_WITH_WARNINGS` and saw zero provider positions in those
  individual sweeps. **Provider snapshots cannot replace independent broker
  verification**, especially before an API/scheduler restart.
- No trade-ledger rows were nonclosed. No automatic order-status repair,
  forced trade closure, or brokerage mutation was attempted.

The policy in `scripts/deployment/reconciliation-cutover-policy.cjs` is
pure and covered by six Node regression tests under the required Deployment
Script Safety gate. It refuses promotion on missing/stale/failed state
reconciliation, unresolved orders, open discrepancies, nonclosed trades,
reported provider positions, or invalid counters. Broker-side verification
remains separately mandatory **even when these internal checks pass**.

Avoid changing the model or altering 376 order statuses just to clear this
operational gate; first establish broker-side facts and fix the root cause of
stuck order/provider identifiers. No changes to trading strategy or risk
settings are included in this PR.

### Isolated preview pointer activation and reversible rollback

The verified artifact may be activated **only** behind a separate preview
pointer with `scripts/deployment/atomic-preview-links.sh`:

```bash
bash scripts/deployment/atomic-preview-links.sh activate \
  /home/lightworld/runtime/irexpro/candidates/<source-sha>-<build-tool-sha-prefix>
bash scripts/deployment/atomic-preview-links.sh rollback
```

The script does **not** modify any PM2 definition, live trading root, Nginx
route, live database, broker connection, order record or AI scheduler. It
validates the release provenance and required compiled entrypoints, updates
`preview/current` and `preview/previous` by atomic symlink replacement,
and takes an exclusive lock to reject concurrent pointer changes. Invalid
release directories fail closed. It has an isolated shell-test mode under
`/tmp/irexpro-preview-test.*` for deterministic A/B activation and two
rollback rounds, and is tested by required Deployment Script Safety CI.

During the November 21 preview rehearsal, the VPS `preview/current` pointer
referenced the single verified GitHub-built release. That **unused preview
candidate and pointer were subsequently removed** in the same day's disk
recovery, without changing production PM2, the AI broker processes or the
public Nginx route. This was not a live API/AI rollback; broker/state
reconciliation and the four HOLD conditions remain prerequisites.

### Recurring VPS generated-cache retention (enabled 2026-11-21)

The installed weekly service is `lightworld-irexpro-cache-prune.timer`,
scheduled for Saturdays at 11:15 UTC with up to 10 minutes randomized
delay (during the FX weekend closure). Its approved script is pinned locally
at `/usr/local/sbin/lightworld-irexpro-prune-inactive-caches`, under
`/etc/systemd/system/lightworld-irexpro-cache-prune.service`.

The script source is `scripts/deployment/prune-inactive-worktree-caches.py`.
It only removes **ignored** generated `node_modules`, `.next`, or
`.turbo` directories inside enumerated Git worktrees older than 14 days.
It checks `/proc` for active commands and working directories, refuses
links and paths escaping the worktree, and never deletes source code,
branches, models, broker state, or live PM2 directories. Each run is
limited to 30 inactive worktrees, serialized with `flock`, and executes
under idle I/O priority and a CPU quota. It does not stop any application.

The manual 2026-11-21 cleanup first removed the inactive GitHub runtime
candidate and its duplicated Python environment (the exact live PM2
versions were verified untouched), then removed one superseded 161 MB Next
build backup. The protected environment copies remain; the duplicate
**1.3 GB** Python interpreter environment was deleted because no live
process used it. The verified GitHub Actions artifact is reproducible
and can be re-downloaded for a later controlled cutover.

Three audited cache batches removed 339 ignored generated directories from
56 inactive iRexPro worktrees. VPS usage improved from approximately
286 GB/93% used and 25 GB available to 277 GB/90% used and 34 GB available,
while all 23 iRexPro PM2 services stayed online.

**This is not full artifact-only deployment activation.** The active staging
checkout and the legacy VPS build workflow remain, and other projects'
builds/releases also use the shared VPS. The planned replacement still
requires a safe trading-state and broker reconciliation cutover.

### Shared read-only capacity preflight for ALL hosted projects

The operator-approved, globally installed tool
`/usr/local/sbin/lightworld-vps-capacity-check` is intentionally **not**
a cross-project cleanup agent or deployment hook. Its version-controlled
source is `scripts/deployment/lightworld-vps-capacity-check.py`, with
regression tests in `test-lightworld-vps-capacity-check.py` run by required
deployment safety CI.

- `lightworld-vps-capacity-check inspect`: emit JSON disk and concurrent
  compiler count, never block.
- `lightworld-vps-capacity-check build`: return exit 10 if `df`-aligned
  root usage is 90%+, free space is 30 GiB or less, or other heavy builds
  are active. Direct agents to use CI build artifacts.
- `lightworld-vps-capacity-check artifact 500`: check that a 500 MiB
  compressed artifact has 4x extraction headroom **plus** an 8 GiB reserve.
  This does **not** authorize transaction, broker or database cutovers.

This is an **explicit opt-in preflight call** for each project agent or deploy
script; the host does not automatically intercept arbitrary `pnpm`/
`next` commands. The project-specific GitHub issues, shared
`/home/lightworld/AGENTS.md`, and
`/home/lightworld/SHARED_VPS_DEPLOYMENT_POLICY_20261121.md` instruct
agents to invoke the checker. Other projects must add their own CI,
release and cleanup implementations and verify them before closing issues.

### Shared VPS storage monitoring (2026-11-21)

The read-only shared VPS monitor and two installed systemd timers are
documented in `docs/operations/shared-vps-storage-observer.md`. The
half-hourly snapshots are capped at 336, and the low-priority nightly
first-level directory inventory is protected against concurrent builds.
Neither automatically cleans up files or substitutes for project-specific
release-state verification.

### 2026-11-21 nested-worktree storage audit and conservative remediation

The original bounded cache-pruning script handled only direct child worktrees.
A real production audit found 14 older than 14-day, registered nested
`.worktrees/feat/*` / `.worktrees/fix/*` iRexPro worktrees that retained
ignored pnpm dependency trees. The script now accepts **only those two
fixed nested parent paths**, still requires a registered Git worktree,
`.git` metadata, >=14-day age, an ignored generated path, and absence
of active process/cwd references, while rejecting symlinks.

Production dry-run identified **6 eligible** nested worktrees / **42**
ignored generated directories; the others did **not** satisfy all checks and
were not removed. The low-I/O bounded apply completed with 42/42 folders
removed, preserving branches, models, broker state, databases and all
running 23 iRexPro PM2 services. Actual `df` recovered approximately
**0.40 GiB** net (used bytes 298385846272 -> 297955020800), much less
than apparent directory contents. This demonstrates why other project
storage must be measured and verified before cleanup promises.

Read-only initial `webapps` audit measured 83,384 MiB across 72
directories, with iPresenterPlux 19,605 MiB, iEduPro Next 14,748 MiB,
iRexPro staging 9,778 MiB, iFleetPro 4,433 MiB. These are **whole
application-directory measurements**, not a disposable or recoverable
space estimate. Independent project source/DB/rollback protection remains
mandatory. The shared VPS was still near 90% after cleanup.
